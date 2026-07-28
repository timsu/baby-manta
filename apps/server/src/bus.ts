// Live fan-out pub/sub (Phase 5). Subscribers are browser sockets; publishers
// are worker events and board changes. Delivery is in-process for THIS replica
// plus an Ably backplane that bridges replicas.
//
// Why the backplane: the worker ws (/worker-ws) and the browser ws (/ws) are
// independent connections, each load-balanced separately across ECS replicas.
// With a purely in-memory bus, a worker on replica B publishing to a browser
// subscribed on replica A finds no local subscriber and the event is silently
// dropped — tool calls never reach the frontend. Ably carries every published
// event to the other replicas, which re-emit it to their local subscribers.
//
// Local delivery stays synchronous and is the authoritative path for same-replica
// pairs (fast, and unaffected if Ably is down); the backplane only adds reach to
// OTHER replicas. `echoMessages: false` keeps a replica from receiving its own
// publishes (it already delivered them locally); the `from` tag is belt-and-
// suspenders against that. Unconfigured key → in-process only (correct for a
// single instance and for dev/tests).
//
// One Ably channel per workspace (`manta:<env>:bus:<workspaceId>`), so a replica
// only carries traffic for workspaces it actually has subscribers in, per-channel
// rate limits scale with workspace count, and the backplane can't bridge one
// tenant's events to another. A replica attaches a workspace channel on its first
// local subscriber there and detaches when the last one leaves (refcounted).
//
// Topics are workspace-scoped so a subscriber can never receive another tenant's
// events: `t:<workspaceId>:<channel>` for agent streams and
// `t:<workspaceId>:kanban` for board changes.

import { randomUUID } from "node:crypto";
import Ably from "ably";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger("Manta:Bus");

type Handler = (event: unknown) => void;

// Unique per process: lets a replica ignore its own messages off the backplane.
const INSTANCE_ID = randomUUID();

interface BackplaneMsg {
  from: string;
  topic: string;
  event: unknown;
}

/** Pull the workspaceId out of a topic (`t:<workspaceId>:<channel>`). Returns
 * null for a malformed topic. cuid workspace ids never contain ':', so the
 * second segment is the whole id even when the channel part has colons. */
function workspaceOf(topic: string): string | null {
  const first = topic.indexOf(":");
  if (first !== 1 || topic[0] !== "t") return null;
  const second = topic.indexOf(":", first + 1);
  if (second < 0) return null;
  return topic.slice(first + 1, second);
}

class Bus {
  private readonly subs = new Map<string, Set<Handler>>();
  private readonly client: Ably.Realtime | null;
  /** Per-workspace backplane channel, refcounted by local subscriber count. */
  private readonly wsChannels = new Map<string, { channel: Ably.RealtimeChannel; refs: number }>();
  private readonly channelPrefix: string;

  constructor() {
    // dev and prod may share one Ably app, so namespace channels by env to keep
    // a local dev replica's events from leaking into production.
    this.channelPrefix = `manta:${config.isProd() ? "prod" : "dev"}:bus:`;
    this.client = this.initClient();
  }

  private initClient(): Ably.Realtime | null {
    const key = config.ablyKey();
    if (!key) {
      logger.info("Ably disabled (no ABLY_API_KEY); bus is in-process only");
      return null;
    }
    try {
      // echoMessages:false → we don't get our own publishes back (already
      // delivered locally). The SDK reconnects on its own; clientId aids
      // debugging in the Ably console.
      const client = new Ably.Realtime({ key, echoMessages: false, clientId: INSTANCE_ID });
      client.connection.on("failed", (s) => logger.warn("Ably connection failed", { reason: s?.reason }));
      logger.info("Ably backplane enabled");
      return client;
    } catch (err) {
      // A bad key or SDK init failure must not take the server down — fall back
      // to in-process delivery (degrades to the single-instance behavior).
      logger.warn("Ably init failed; bus is in-process only", { err });
      return null;
    }
  }

  /** Deliver to handlers registered on THIS replica. */
  private deliverLocal(topic: string, event: unknown): void {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const h of set) {
      try {
        h(event);
      } catch {
        /* a slow/broken subscriber must not break the publisher */
      }
    }
  }

  /** Attach (or refcount up) the backplane channel for a workspace. */
  private retainWsChannel(workspaceId: string): void {
    if (!this.client) return;
    let entry = this.wsChannels.get(workspaceId);
    if (!entry) {
      const channel = this.client.channels.get(this.channelPrefix + workspaceId);
      entry = { channel, refs: 0 };
      this.wsChannels.set(workspaceId, entry);
      void channel.subscribe("e", (msg) => {
        const data = msg.data as BackplaneMsg | undefined;
        if (!data || data.from === INSTANCE_ID || typeof data.topic !== "string") return;
        this.deliverLocal(data.topic, data.event);
      });
    }
    entry.refs++;
  }

  /** Refcount down; detach the workspace channel when the last subscriber leaves. */
  private releaseWsChannel(workspaceId: string): void {
    const entry = this.wsChannels.get(workspaceId);
    if (!entry) return;
    if (--entry.refs > 0) return;
    this.wsChannels.delete(workspaceId);
    try {
      entry.channel.unsubscribe();
      void entry.channel.detach();
    } catch {
      /* already gone — fine */
    }
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(handler);
    const workspaceId = workspaceOf(topic);
    if (workspaceId) this.retainWsChannel(workspaceId);
    let released = false;
    return () => {
      // Guard against a double-call unbalancing the refcount.
      if (released) return;
      released = true;
      set!.delete(handler);
      if (set!.size === 0) this.subs.delete(topic);
      if (workspaceId) this.releaseWsChannel(workspaceId);
    };
  }

  publish(topic: string, event: unknown): void {
    // Authoritative same-replica path: synchronous, and unaffected by Ably.
    this.deliverLocal(topic, event);
    // Best-effort cross-replica fan-out. Never let a backplane hiccup throw into
    // a worker-event handler. channels.get is cached, so a worker streaming a
    // turn reuses one attached channel rather than re-attaching per event.
    if (this.client) {
      const workspaceId = workspaceOf(topic);
      if (!workspaceId) return;
      const payload: BackplaneMsg = { from: INSTANCE_ID, topic, event };
      this.client.channels
        .get(this.channelPrefix + workspaceId)
        .publish("e", payload)
        .catch((err) => logger.warn("Ably publish failed", { topic, err }));
    }
  }
}

export const bus = new Bus();

export const chanTopic = (workspaceId: string, channel: string) => `t:${workspaceId}:${channel}`;
export const kanbanTopic = (workspaceId: string) => `t:${workspaceId}:kanban`;
