// Per-task in-flight turn state, mirrored to Redis so a deploy mid-turn doesn't
// lose the assistant message being streamed or the live-event replay buffer. The
// in-memory copies in ws.ts stay authoritative for THIS process; this is the
// survives-restart cache the fresh process hydrates from on the first event it
// sees for a task whose turn began before the deploy.
//
// Writes are throttled (coalesced on a timer) so a token-by-token stream doesn't
// fan out into one Upstash REST call per event.

import type { AgentEvent } from "@manta/shared";
import { setJson, getJson, del } from "../redis.ts";

export type TaskTranscriptEntry =
  | { type: "assistant"; text: string }
  | { type: "tool"; tool: string; args: string }
  | { type: "status"; text: string }
  | { type: "thinking"; text: string };

export interface TaskSnapshot {
  assistantText: string;
  toolTrace: Array<{ tool: string; args: string }>;
  transcript?: TaskTranscriptEntry[];
  events: AgentEvent[];
}

/** How long a snapshot lives if never cleared (turn crashed without done/error).
 * Long enough to ride out any deploy, short enough to self-clean. */
const SNAPSHOT_TTL_SEC = 30 * 60;
/** Coalesce window: at most one Redis write per task per this interval. */
const FLUSH_MS = 2_000;

const dirty = new Map<string, TaskSnapshot>();
const flushingTaskIds = new Set<string>();
const clearedDuringFlush = new Set<string>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let currentFlush: Promise<void> | null = null;

function flushDirty(): Promise<void> {
  if (currentFlush) return currentFlush;
  if (dirty.size === 0) return Promise.resolve();

  currentFlush = (async () => {
    const batch = [...dirty.entries()];
    dirty.clear();
    for (const [taskId] of batch) flushingTaskIds.add(taskId);
    try {
      await Promise.all(
        batch.map(async ([taskId, snap]) => {
          const key = `task:${taskId}`;
          let ok = false;
          try {
            ok = await setJson(key, snap, SNAPSHOT_TTL_SEC);
          } catch {
            ok = false;
          }
          if (clearedDuringFlush.has(taskId)) {
            await del(key);
            return;
          }
          // If the write failed, keep the snapshot dirty for the next flush. Do
          // not overwrite a newer snapshot that may have arrived while this write
          // was in flight.
          if (!ok && !dirty.has(taskId)) dirty.set(taskId, snap);
        }),
      );
    } finally {
      for (const [taskId] of batch) {
        flushingTaskIds.delete(taskId);
        clearedDuringFlush.delete(taskId);
      }
      currentFlush = null;
    }
  })();
  return currentFlush;
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushDirty();
  }, FLUSH_MS);
  // Don't keep the process alive just for the flush loop.
  flushTimer.unref?.();
}

/** Queue the latest snapshot for a task; persisted on the next flush tick. */
export function saveTaskSnapshot(taskId: string, snap: TaskSnapshot): void {
  clearedDuringFlush.delete(taskId);
  dirty.set(taskId, snap);
  ensureTimer();
}

/** Load a task's snapshot (null if none / Redis disabled). */
export function loadTaskSnapshot(taskId: string): Promise<TaskSnapshot | null> {
  return getJson<TaskSnapshot>(`task:${taskId}`);
}

/** Drop a task's snapshot once its turn ends (done/error). */
export function clearTaskSnapshot(taskId: string): void {
  dirty.delete(taskId);
  if (flushingTaskIds.has(taskId)) clearedDuringFlush.add(taskId);
  void del(`task:${taskId}`);
}

/** Flush all pending snapshots immediately (called on shutdown so the last few
 * seconds of an in-flight turn aren't lost to the throttle window). */
export async function flushSnapshotsNow(): Promise<void> {
  await flushDirty();
  // If a timer flush was already in flight, new snapshots may have arrived while
  // it ran; make one more pass for shutdown callers without looping forever when
  // Redis is down and failed writes are re-queued.
  await flushDirty();
}
