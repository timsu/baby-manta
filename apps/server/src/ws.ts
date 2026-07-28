// WebSocket hub (Phase 5). One multiplexed socket per browser tab. The client
// subscribes to channels (brain / <taskId>) and the workspace's kanban topic;
// the server relays bus events live. A `chat` message runs a brain turn whose
// events publish to the bus as they stream. Auth rides the session cookie on
// the upgrade request.
//
// Worker daemons connect to /worker-ws with a shared secret. They receive
// run_task dispatches and stream AgentEvents back; the server relays to the
// bus and persists messages.

import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { workspaces, repos, messages, tasks, agentSessions, inbox, workerCredentials, sandboxCredentials } from "@manta/db";
import { authorizeTerminal } from "./terminal.ts";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import { SESSION_COOKIE, type Sessions } from "./auth/session.ts";
import { bus, chanTopic, kanbanTopic } from "./bus.ts";
import { runBrainTurn } from "./brain/runner.ts";
import { drainSandboxRuns } from "./worker/cloud.ts";
import {
  registerWorker,
  unregisterWorker,
  isLiveConnection,
  ackDispatch,
  forwardToTaskWorker,
  listWorkers,
  getTaskWorkerSend,
  getTaskWorkerInfo,
  reconnectTaskHome,
  claimTaskWorktrees,
  claimActiveTasks,
  touchWorkerPresence,
  drainHeldDispatches,
  setOnWorkerWedged,
} from "./worker/registry.ts";
import { cancelSpindown } from "./worker/lifecycle.ts";
import { failAllQuestions, failWorkerQuestions } from "./worker/questions.ts";
import { loadTaskSnapshot } from "./worker/snapshot.ts";
import { pendingUserQuestions, taskEventBuffers, terminalSessions } from "./ws/state.ts";
import { handleRegisteredWorkerMessage } from "./ws/workerMessages.ts";
import { canUsePendingQuestion, resolveUserQuestion } from "./ws/userQuestions.ts";
import { acceptTaskMessage } from "./worker/taskMessages.ts";
import { handleDisconnectedActiveTask, handleWedgedTask, resolveDisconnectGrace } from "./worker/disconnect.ts";
import { getUserAuthBlob, saveUserAuth } from "./models/service.ts";
import type { AuthBlob } from "@manta/agent";
export { listWorkers };
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import type { AuthVars } from "./auth/routes.ts";

const wsLogger = createLogger("Manta:WS");

/** Validate an untrusted `pi_auth_refreshed` payload as a Pi auth blob: a plain
 * object mapping provider id → credential object. Returns null on anything else
 * (array, primitive, or a non-object credential value) so a malformed message
 * can never overwrite a user's stored auth. */
function asAuthBlob(value: unknown): AuthBlob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  for (const [provider, cred] of entries) {
    if (!provider || !cred || typeof cred !== "object" || Array.isArray(cred)) return null;
  }
  return value as AuthBlob;
}

export interface WsDeps {
  sessions: Sessions;
  brain: {
    brainBackend: AgentBackend;
    brainBackendId: string;
    brainTools: ToolDefinition[];
    defaultBrainPrompt: string;
  };
}

interface ClientMsg {
  type: "subscribe" | "chat" | "worker_chat" | "answer_user_question" | "dismiss_user_question";
  workspaceId: string;
  channel?: string;
  message?: string;
  taskId?: string;
  questionId?: string;
  answer?: string;
}

function brainChannelForUser(userId: string): string {
  return `brain:${userId}`;
}

function publicChannelName(channel: string): string {
  return channel.startsWith("brain:") ? "brain" : channel;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
// On a deploy the process is replaced. Without coordination the worker sockets
// drop with code 1006 and `onClose` flips every active task to needs_help — a
// healthy worker that reconnects 2s later looks like a crash. `gracefulShutdown`
// flips this flag so `onClose` leaves task state alone (the new process rebuilds
// it from the worker's re-register), then closes the sockets with 1001 so workers
// reconnect promptly instead of waiting out a TCP timeout.
let shuttingDown = false;
/** Close handles for every live worker socket, so shutdown can ask them all to go. */
const workerSockets = new Map<number, () => void>();

/** Begin graceful shutdown: stop protecting nothing, ask workers to reconnect to
 * the replacement process. Returns once close has been requested on every socket. */
export function gracefulShutdown(): void {
  shuttingDown = true;
  failAllQuestions("server is restarting; please ask again in a moment");
  wsLogger.info("graceful shutdown — closing worker sockets (1001)", { count: workerSockets.size });
  for (const close of workerSockets.values()) {
    try { close(); } catch { /* already gone */ }
  }
}

/** Registers GET /ws and GET /worker-ws on the app; returns the node-server injector. */
export function setupWebSocket(app: Hono<{ Variables: AuthVars }>, deps: WsDeps) {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // A dispatch the daemon acked but never streamed output for is a wedged turn —
  // route it to Needs Help so the card stops spinning on "working…".
  setOnWorkerWedged((taskId, workerId) => {
    void handleWedgedTask(taskId, workerId).catch((err) =>
      wsLogger.error("wedge handler failed", { taskId, workerId, err }),
    );
  });

  // ── Browser WebSocket (/ws) ────────────────────────────────────────────────

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let userId: string | null = null;
      const unsubs: Array<() => void> = [];
      const subscribedChannels = new Set<string>();
      const send = (ws: { send: (s: string) => void }, obj: unknown) => ws.send(JSON.stringify(obj));

      return {
        async onOpen(_evt, ws) {
          const token = getCookie(c, SESSION_COOKIE);
          const claims = token ? await deps.sessions.verify(token) : null;
          userId = claims?.sub ?? null;
          if (!userId) {
            send(ws, { type: "error", message: "unauthenticated" });
            ws.close(1008, "unauthenticated");
          }
        },

        async onMessage(evt, ws) {
          if (!userId) return;
          let msg: ClientMsg;
          try {
            msg = JSON.parse(evt.data.toString()) as ClientMsg;
          } catch {
            return;
          }
          if (!(await workspaces.isMember(userId, msg.workspaceId))) {
            send(ws, { type: "error", message: "not_a_member" });
            return;
          }

          if (msg.type === "subscribe" && msg.channel) {
            // The browser-facing brain channel is always the signed-in user's
            // private brain channel. Do not trust client-supplied `brain:<id>`
            // names, or one workspace member could subscribe to another
            // member's sidebar chat by guessing their user id.
            const channel = msg.channel === "brain" || msg.channel.startsWith("brain:")
              ? brainChannelForUser(userId)
              : msg.channel;
            const publicChannel = publicChannelName(channel);
            // Re-subscribes (task re-opened): only resend history, don't duplicate bus listeners.
            if (!subscribedChannels.has(channel)) {
              subscribedChannels.add(channel);
              unsubs.push(
                bus.subscribe(chanTopic(msg.workspaceId, channel), (event) => {
                  const custom = event as { type?: string; taskId?: string; questionId?: string; questions?: unknown; ownerUserId?: string | null };
                  if (custom.type === "history_cleared") {
                    send(ws, { type: "history_cleared", channel: publicChannel });
                    return;
                  }
                  if (custom.type === "user_question_pending" && custom.taskId && custom.questionId && custom.questions) {
                    if (custom.ownerUserId != null && custom.ownerUserId !== userId) return;
                    send(ws, { type: "ask_user_question", taskId: custom.taskId, questionId: custom.questionId, ownerUserId: custom.ownerUserId ?? null, questions: custom.questions });
                    return;
                  }
                  if (custom.type === "user_question_resolved" && custom.questionId) {
                    send(ws, { type: "user_question_resolved", questionId: custom.questionId });
                    return;
                  }
                  send(ws, { type: "event", channel: publicChannel, event });
                }),
              );
              if (msg.channel === "brain") {
                unsubs.push(
                  bus.subscribe(chanTopic(msg.workspaceId, "brain"), (event) => {
                    const custom = event as { type?: string; taskId?: string; questionId?: string; questions?: unknown; ownerUserId?: string | null };
                    if (custom.type === "user_question_pending" && custom.taskId && custom.questionId && custom.questions) {
                      if (custom.ownerUserId != null && custom.ownerUserId !== userId) return;
                      send(ws, { type: "ask_user_question", taskId: custom.taskId, questionId: custom.questionId, ownerUserId: custom.ownerUserId ?? null, questions: custom.questions });
                      return;
                    }
                    if (custom.type === "user_question_resolved" && custom.questionId) {
                      send(ws, { type: "user_question_resolved", questionId: custom.questionId });
                      return;
                    }
                    send(ws, { type: "event", channel: "brain", event });
                  }),
                );
              }
              unsubs.push(
                bus.subscribe(kanbanTopic(msg.workspaceId), () => send(ws, { type: "kanban" })),
              );
            }
            const history = await messages.list({ workspaceId: msg.workspaceId }, channel);
            // Live-event replay: prefer the in-memory buffer; after a deploy it's
            // empty, so fall back to the snapshot cache so a reloaded tab still
            // replays the in-flight turn instead of showing a blank pane.
            let liveEvents = taskEventBuffers.get(channel);
            if (!liveEvents) {
              const snap = await loadTaskSnapshot(channel);
              if (snap?.events?.length) liveEvents = snap.events;
            }
            send(ws, {
              type: "history",
              channel: publicChannel,
              messages: history.map((m) => ({ role: m.role, content: m.content, meta: m.meta ?? null })),
              liveEvents: liveEvents ? [...liveEvents] : undefined,
            });
            for (const q of pendingUserQuestions.values()) {
              if (q.workspaceId === msg.workspaceId && canUsePendingQuestion(q, userId)) {
                send(ws, { type: "ask_user_question", taskId: q.taskId, questionId: q.questionId, ownerUserId: q.ownerUserId, questions: q.questions });
              }
            }
          } else if (msg.type === "answer_user_question" && msg.questionId && msg.taskId) {
            await resolveUserQuestion((obj) => send(ws, obj), userId, msg.workspaceId, msg.taskId, msg.questionId, {
              text: String(msg.answer ?? ""),
              // The prompt is gone but the user answered anyway. Their answer must
              // resume the card rather than vanish, so fall back to the ordinary
              // follow-up path (which respawns a worker if none is attached).
              resumeWhenUndeliverable: true,
            });
          } else if (msg.type === "dismiss_user_question" && msg.questionId && msg.taskId) {
            await resolveUserQuestion((obj) => send(ws, obj), userId, msg.workspaceId, msg.taskId, msg.questionId, {
              text: "Dismissed by user without an answer.",
              // Nothing to resume — the user explicitly declined to answer.
              resumeWhenUndeliverable: false,
            });
          } else if (msg.type === "chat" && msg.message) {
            const workspaceId = msg.workspaceId;
            const channel = brainChannelForUser(userId);
            send(ws, { type: "user_ack", channel: "brain", text: msg.message });

            // Handle /new command: reset the brain session without running a turn.
            if (msg.message.trim() === "/new") {
              await Promise.all([
                agentSessions.upsertSessionKey(workspaceId, channel, ""),
                messages.clear({ workspaceId }, channel),
              ]);
              bus.publish(chanTopic(workspaceId, channel), { type: "history_cleared" } as never);
              bus.publish(chanTopic(workspaceId, channel), { type: "text", text: "✅ Started a new brain session." });
              bus.publish(chanTopic(workspaceId, channel), { type: "done", reason: "end_turn" });
              send(ws, { type: "chat_done", channel: "brain" });
              return;
            }

            const [ws2, resumeFrom, pendingItems, wsSettings, repoRows] = await Promise.all([
              workspaces.byId(workspaceId),
              agentSessions.getSessionKey(workspaceId, channel),
              inbox.pending(workspaceId, "brain"),
              workspaces.getSettings(workspaceId),
              repos.list({ workspaceId }),
            ]);
            // UI brain turns must not silently inherit Slack conversations that
            // happened in a separate Slack thread. Other background inbox items
            // are still injected, but drainInbox labels them as hidden/lower
            // priority than the visible UI message.
            const inboxItems = pendingItems.filter((i) => i.source !== "slack").map((i) => ({
              id: i.id, body: i.body, source: i.source, createdAt: i.createdAt.getTime(),
            }));
            try {
              const result = await runBrainTurn({
                scope: { workspaceId },
                channel,
                userMessage: msg.message,
                backend: deps.brain.brainBackend,
                backendId: wsSettings.defaultModel || deps.brain.brainBackendId,
                tools: deps.brain.brainTools,
                userId,
                promptParts: {
                  basePrompt: ws2?.brainPrompt?.trim() || deps.brain.defaultBrainPrompt,
                  teamMemory: ws2?.teamMemory,
                  workspaceRepos: repoRows.filter((repo) => repo.enabled).map((repo) => ({ orgRepo: repo.orgRepo, defaultBranch: repo.defaultBranch })),
                },
                onEvent: (event) => {
                  bus.publish(chanTopic(workspaceId, channel), event);
                  if (event.type === "context_usage") {
                    send(ws, { type: "context_usage_update", channel: "brain", tokens: event.tokens, contextWindow: event.contextWindow, percent: event.percent });
                  }
                },
                ...(resumeFrom ? { resumeFrom } : {}),
                onSession: (key) => agentSessions.upsertSessionKey(workspaceId, channel, key),
                ...(inboxItems.length ? { inbox: inboxItems } : {}),
              });
              await inbox.markConsumed(workspaceId, result.consumedInboxIds);
            } catch (err) {
              bus.publish(chanTopic(workspaceId, channel), {
                type: "error",
                message: err instanceof Error ? err.message : "turn failed",
              });
            }
            bus.publish(kanbanTopic(workspaceId), {});
            send(ws, { type: "chat_done", channel: "brain" });
          } else if (msg.type === "worker_chat" && msg.taskId && msg.message) {
            const accepted = await acceptTaskMessage(msg.workspaceId, msg.taskId, msg.message);
            if (!accepted) return;
            if (!accepted.dispatched) {
              send(ws, { type: "error", message: "Follow-up was saved but a worker turn could not be started." });
              return;
            }
            send(ws, { type: "user_ack", channel: accepted.task.id, text: msg.message });
          }
        },

        onClose() {
          for (const u of unsubs) u();
        },
      };
    }),
  );

  // ── Worker daemon WebSocket (/worker-ws) ──────────────────────────────────

  app.get(
    "/worker-ws",
    upgradeWebSocket(() => {
      let workerId: string | null = null;
      // Identity of THIS socket's registration. workerId is stable across
      // reconnects, so onClose gates teardown on connId still being current —
      // otherwise a late close from a dropped socket clobbers the live one.
      let connId: number | null = null;
      // For a cloud sandbox connection, the single (task, workspace) its token is
      // bound to. The agent inside a sandbox runs untrusted code, so every event
      // it sends is checked against this — it can only ever act on its own task.
      // null for a laptop daemon (a trusted, per-user machine).
      let boundScope: { taskId: string; workspaceId: string } | null = null;
      let registeredOwnerUserId: string | null = null;
      const send = (ws: { send: (s: string) => void }, obj: unknown) => ws.send(JSON.stringify(obj));

      return {
        onOpen(_evt, _ws) {
          // Authentication happens on the first message.
        },

        async onMessage(evt, ws) {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(evt.data.toString()) as Record<string, unknown>;
          } catch {
            return;
          }

          // ── Heartbeat ─────────────────────────────────────────────────────
          // Workers ping periodically so the connection never sits fully idle
          // (proxies in the path drop idle WebSockets). Answer regardless of
          // registration state.
          if (msg["type"] === "ping") {
            // Refresh presence on every heartbeat so the survives-restart cache
            // stays warm while this socket is healthy.
            if (workerId) touchWorkerPresence(workerId);
            send(ws, { type: "pong" });
            return;
          }

          // Daemon confirms it received a run_task dispatch — cancels the
          // "dispatch not acked" warning so a real ghost-dispatch stands out.
          if (msg["type"] === "run_task_ack") {
            const ackTaskId = msg["taskId"] as string | undefined;
            if (ackTaskId) ackDispatch(ackTaskId);
            return;
          }

          // The daemon's local OAuth token rotated mid-turn. OpenAI invalidates the
          // old refresh token on every refresh, so the server's vended copy is now
          // stale — and it would clobber the laptop's fresh token on the next
          // dispatch (syncPiAuth overwrites). Persist the refreshed blob back to the
          // owner so both sides stay in sync (the laptop→server gap that otherwise
          // forces a manual re-login). Per-user laptop daemons only; sandbox tokens
          // are ephemeral and synthetic-owned.
          if (msg["type"] === "pi_auth_refreshed" && registeredOwnerUserId && !registeredOwnerUserId.startsWith("sandbox:")) {
            // Validate the shape before persisting: a plain provider→credential
            // map (each value a non-null object). A malformed payload must never
            // overwrite the user's stored auth with garbage.
            const blob = asAuthBlob(msg["blob"]);
            if (blob) {
              void saveUserAuth(registeredOwnerUserId, blob).catch((err: unknown) =>
                wsLogger.warn("failed to persist refreshed worker auth", { err: String(err) }),
              );
            } else {
              wsLogger.warn("ignored malformed pi_auth_refreshed payload", { workerId });
            }
            return;
          }

          // ── Registration ──────────────────────────────────────────────────
          if (msg["type"] === "register") {
            // Two kinds of worker authenticate here:
            //  • laptop daemon — a per-user token from the browser pairing flow;
            //    its owner is used for owner-based task routing.
            //  • cloud sandbox — a single-task token (msb_…) minted server-side;
            //    it's bound to exactly one task, never owner-routed.
            const token = msg["token"] as string | undefined;
            let ownerUserId: string;
            let boundTaskId: string | undefined;
            const sandbox = await sandboxCredentials.verify(token);
            if (sandbox) {
              boundTaskId = sandbox.taskId;
              boundScope = { taskId: sandbox.taskId, workspaceId: sandbox.workspaceId };
              // Synthetic owner — can never match a real userId, so dispatchTask
              // (owner-based) won't route other tasks to this sandbox worker.
              ownerUserId = `sandbox:${sandbox.taskId}`;
            } else {
              const cred = await workerCredentials.verify(token);
              if (!cred) {
                send(ws, { type: "error", message: "auth_failed" });
                ws.close(1008, "auth_failed");
                return;
              }
              ownerUserId = cred.userId;
            }
            const workerVersion = Number(msg["version"] ?? 0);
            const minVersion = config.minWorkerVersion();
            if (workerVersion < minVersion) {
              // Soft enforcement: nudge the worker to update, but let it register
              // and keep serving. A hard close (1008) locks an outdated daemon out
              // entirely — it can't run anything until a human intervenes — and
              // older daemons mis-handled that close by wiping their credential and
              // re-pairing. Instead the daemon schedules its own git-pull update and
              // restarts when idle (see the `update` handler in daemon.ts). Fall
              // through to normal registration rather than returning.
              send(ws, { type: "update", minVersion });
            }
            workerId = (msg["workerId"] as string | undefined) ?? `worker-${Date.now()}`;
            const gitHash = (msg["gitHash"] as string | undefined) ?? null;
            const terminalPort = typeof msg["terminalPort"] === "number" ? (msg["terminalPort"] as number) : null;
            const caps = Array.isArray(msg["caps"])
              ? (msg["caps"] as unknown[]).filter((c): c is string => typeof c === "string")
              : [];
            connId = registerWorker(workerId, ownerUserId, (obj) => send(ws, obj), {
              gitHash,
              terminalPort,
              caps,
              ...(boundTaskId ? { boundTaskId } : {}),
            });
            registeredOwnerUserId = ownerUserId;
            // Rebuild terminal routing after a server restart: the daemon (still up
            // across the deploy) advertises the task worktrees it holds, so a
            // terminal works immediately rather than only after the next dispatch.
            const heldTasks = Array.isArray(msg["heldTasks"])
              ? (msg["heldTasks"] as unknown[]).filter((t): t is string => typeof t === "string")
              : [];
            claimTaskWorktrees(workerId, heldTasks);
            // Tasks with an in-flight turn the daemon is still running (deploy
            // reconnect): rebuild active-turn routing so follow-ups forward here
            // and a *later* real disconnect still protects them.
            const activeTasks = Array.isArray(msg["activeTasks"])
              ? (msg["activeTasks"] as unknown[]).filter((t): t is string => typeof t === "string")
              : [];
            claimActiveTasks(workerId, activeTasks);
            // This worker dropped moments ago and its cards are being held (see
            // the disconnect grace window). Its claim is the authority: tasks it
            // still runs are released from the hold, tasks it no longer runs fail
            // now instead of waiting out the window.
            resolveDisconnectGrace(workerId, activeTasks);
            // Register a close handle so graceful shutdown can ask this socket to
            // reconnect to the replacement process.
            const myConnId = connId;
            workerSockets.set(myConnId, () => ws.close(1001, "server_restart"));
            send(ws, { type: "registered", workerId });
            // A sandbox self-starts only its first (env) message; deliver any
            // follow-ups that arrived while it was still provisioning.
            if (boundTaskId) {
              for (const runMsg of drainSandboxRuns(boundTaskId)) forwardToTaskWorker(boundTaskId, runMsg);
            }
            // A laptop worker that just (re)connected may have turns held for it
            // during a deploy window — dispatch them now instead of cloud.
            drainHeldDispatches(ownerUserId);
            // Push the user's stored Pi credentials so `pi` works locally even
            // if the user hasn't run `pi /login` on this machine.
            if (!boundTaskId) {
              getUserAuthBlob(ownerUserId).then((blob) => {
                if (blob) send(ws, { type: "sync_pi_auth", authJson: blob });
              }).catch(() => {})
            }
            return;
          }

          if (!workerId) {
            send(ws, { type: "error", message: "not_registered" });
            return;
          }

          await handleRegisteredWorkerMessage({
            msg,
            send: (obj) => send(ws, obj),
            boundScope,
            workerId,
          });
        },

        onClose(evt) {
          if (connId !== null) workerSockets.delete(connId);
          if (!workerId || !registeredOwnerUserId || connId === null) return;
          const ownerUserIdForClose = registeredOwnerUserId;
          // Log the close so a worker drop is visible + correlatable with the
          // daemon's own "socket closed (code …)" line (code 1006 = abnormal /
          // proxy or network reset; 1001 = our graceful-shutdown ask).
          const closeCode = (evt as { code?: number } | undefined)?.code;
          const closeReason = (evt as { reason?: string } | undefined)?.reason || undefined;
          wsLogger.info("worker socket closed", { workerId, connId, code: closeCode, reason: closeReason, shuttingDown });
          // Deploy in progress: we closed this socket on purpose. Leave task
          // routing, presence, and snapshots intact so the replacement process
          // rebuilds them from the worker's re-register — flipping to needs_help
          // here would falsely fail a healthy worker that's mid-reconnect.
          if (shuttingDown) return;
          // A reconnect re-registers under the same (stable) workerId. If this
          // close is for a superseded socket, do nothing — tearing down terminal
          // sessions / routing here would clobber the live connection.
          if (!isLiveConnection(workerId, connId)) return;
          // A sandbox dropped (stopped, crashed, or token revoked): drop its grace
          // timer so a stale spindown doesn't fire against an already-gone box.
          if (boundScope) cancelSpindown(boundScope.taskId);
          // Tear down any terminal relay sessions homed on this worker — its PTYs
          // (and worktrees) are gone with the connection.
          for (const [sid, sess] of terminalSessions) {
            if (sess.workerId === workerId) {
              try { sess.close(1011, "worker disconnected"); } catch { /* already closed */ }
              terminalSessions.delete(sid);
            }
          }
          // Fail any in-flight question this worker was answering so the awaiting
          // brain turn doesn't hang until timeout.
          failWorkerQuestions(workerId, "worker disconnected");
          const activeTaskIds = unregisterWorker(workerId, connId);
          for (const activeTaskId of activeTaskIds) {
            // Worker dropped mid-task. Only move to needs_help if no other
            // active/replacement worker can continue the card.
            // Errors here (DB hiccup, invalid transition) must not become an
            // unhandled rejection: catch and log so the failure is visible.
            void (async () => {
              await handleDisconnectedActiveTask(workerId, ownerUserIdForClose, activeTaskId);
            })().catch((err) => {
              wsLogger.error("onClose needs_help transition failed", { activeTaskId, err });
            });
          }
        },
      };
    }),
  );

  // ── Terminal WebSocket (/terminal?workspaceId=...&taskId=...) ─────────────
  // The PTY itself lives on the worker daemon that holds the task's worktree.
  // This endpoint is a pure RELAY: browser ↔ server ↔ worker (over /worker-ws).
  // Same-machine browsers connect straight to the worker's loopback port instead
  // (see GET /api/tasks/:taskId/terminal-endpoint) and never reach here.
  app.get(
    "/terminal",
    upgradeWebSocket((c) => {
      const workspaceId = c.req.query("workspaceId");
      const taskId = c.req.query("taskId");
      const terminalId = c.req.query("terminalId") || "default";
      // Client's initial geometry — forwarded so the worker spawns the PTY at the
      // right size and zsh's first prompt isn't drawn at the wrong width.
      const openCols = c.req.query("cols");
      const openRows = c.req.query("rows");
      let sessionId: string | null = null;
      let workerSend: ((m: unknown) => void) | null = null;
      let relayTaskId: string | null = null;

      return {
        async onOpen(_evt, ws) {
          const token = getCookie(c, SESSION_COOKIE);
          const auth = await authorizeTerminal(token, workspaceId, taskId, deps.sessions);
          if (!auth) { ws.close(1008, "unauthorized"); return; }

          if (!getTaskWorkerSend(auth.taskId) && workspaceId) {
            const task = await tasks.get({ workspaceId }, auth.taskId);
            if (task && task.workerVenue !== "daytona" && !task.archivedAt) {
              reconnectTaskHome(task.id, task.createdBy);
            }
          }
          const info = getTaskWorkerInfo(auth.taskId);
          const send = getTaskWorkerSend(auth.taskId);
          if (!info || !send) {
            ws.send(JSON.stringify({ type: "output", data: "\r\nWorker disconnected from this card — terminal unavailable.\r\n" }));
            ws.close(1011, "worker disconnected");
            return;
          }
          sessionId = randomUUID();
          workerSend = send;
          relayTaskId = auth.taskId;
          terminalSessions.set(sessionId, {
            send: (s) => ws.send(s),
            close: (code, reason) => ws.close(code, reason),
            taskId: auth.taskId,
            workerId: info.workerId,
          });
          // Ask the worker to open (or attach to) the PTY for this task's worktree.
          send({ type: "terminal_open", taskId: auth.taskId, terminalId, sessionId, cwd: auth.cwd, cols: openCols, rows: openRows });
        },
        onMessage(evt) {
          if (!sessionId || !workerSend || !relayTaskId) return;
          try {
            const msg = JSON.parse(evt.data.toString()) as { type: string; data?: string; cols?: number; rows?: number };
            if (msg.type === "input") {
              workerSend({ type: "terminal_input", taskId: relayTaskId, terminalId, sessionId, data: msg.data });
            } else if (msg.type === "resize") {
              workerSend({ type: "terminal_resize", taskId: relayTaskId, terminalId, sessionId, cols: msg.cols, rows: msg.rows });
            }
          } catch { /* ignore */ }
        },
        onClose() {
          if (!sessionId) return;
          terminalSessions.delete(sessionId);
          workerSend?.({ type: "terminal_close", taskId: relayTaskId, terminalId, sessionId });
        },
      };
    }),
  );

  return injectWebSocket;
}
