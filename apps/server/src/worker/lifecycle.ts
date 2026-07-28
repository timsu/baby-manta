// Server-driven lifecycle for cloud (Daytona) sandboxes.
//
// A coding task is a conversation, so "done" is per-TURN, not per-task: after a
// turn the box goes idle and we keep it warm for a short grace window (a likely
// follow-up reuses it), then commit any WIP and stop it. A later message wakes a
// restarted/fresh box that resumes off the pushed branch + session.
//
//   provisioning → active → idle (warm, grace timer) → stopped (asleep)
//                    ↑                                        │
//                    └──────────────── wake ─────────────────┘
//
// Grace timers are IN-MEMORY (keyed by taskId) — an optimization, not the source
// of truth. A server restart loses them, but Daytona's auto-stop backstop and the
// reconciler (worker/reconciler.ts) still reap idle/terminal boxes. Only cloud
// (daytona) tasks reach here; laptop tasks are never passed in.

import type { Task } from "@manta/db";
import { tasks } from "@manta/db";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { bus, kanbanTopic } from "../bus.ts";
import { stopCloudSandbox } from "./cloud.ts";
import { forwardToTaskWorker } from "./registry.ts";

const logger = createLogger("Manta:Lifecycle");

type TaskRef = Pick<Task, "id" | "workspaceId">;

/** A scheduled (or in-flight) spindown for a task. `canceled` is checked after
 * every await in spindown() so a turn that arrives mid-spindown (e.g. during the
 * commit_wip wait) aborts the stop instead of racing it — the entry stays in the
 * map across the async work so cancelSpindown can reach and flag it. */
interface Spindown {
  timer?: ReturnType<typeof setTimeout>;
  canceled: boolean;
}
const spindowns = new Map<string, Spindown>();
/** taskId → resolver for an in-flight commit_wip ack. */
const wipAcks = new Map<string, () => void>();

async function setStatus(task: TaskRef, venueStatus: "active" | "idle"): Promise<void> {
  await tasks.setWorker({ workspaceId: task.workspaceId }, task.id, { venueStatus });
  bus.publish(kanbanTopic(task.workspaceId), {});
}

/** A turn started on the task's cloud sandbox — keep it warm and mark running. */
export function onTurnStart(task: TaskRef): void {
  cancelSpindown(task.id);
  void setStatus(task, "active").catch((err) => logger.warn("onTurnStart failed", { taskId: task.id, err }));
}

/** A turn finished — mark idle and schedule spindown after the grace window. */
export function onTurnDone(task: TaskRef): void {
  cancelSpindown(task.id);
  void setStatus(task, "idle").catch((err) => logger.warn("onTurnDone failed", { taskId: task.id, err }));
  const graceMin = config.sandboxGraceMinutes();
  const entry: Spindown = { canceled: false };
  entry.timer = setTimeout(() => {
    entry.timer = undefined; // fired — but keep the entry so an in-flight spindown stays cancelable
    void spindown(task, entry).catch((err) => logger.warn("spindown failed", { taskId: task.id, err }));
  }, graceMin * 60_000);
  // A pending sandbox timer must not keep the process alive on shutdown.
  entry.timer.unref?.();
  spindowns.set(task.id, entry);
  logger.info("sandbox idle — spindown scheduled", { taskId: task.id, graceMin });
}

/** Cancel a pending or in-flight spindown: a new turn, a disconnect, a manual
 * stop, or the reconciler taking over. Flags the entry `canceled` (so a spindown
 * already past its timer aborts before stopping the box) and drops it. No-op if
 * none is scheduled. */
export function cancelSpindown(taskId: string): void {
  const e = spindowns.get(taskId);
  if (!e) return;
  e.canceled = true;
  if (e.timer) clearTimeout(e.timer);
  spindowns.delete(taskId);
}

async function spindown(task: TaskRef, entry: Spindown): Promise<void> {
  try {
    if (entry.canceled) return;
    logger.info("spinning down idle sandbox", { taskId: task.id });
    await commitWip(task);
    // A turn may have arrived during the commit_wip wait (onTurnStart →
    // cancelSpindown flagged us). Don't stop a box that's active again.
    if (entry.canceled) return;
    await stopCloudSandbox(task);
  } finally {
    // Always drop our entry — even on a throw — if it's still the active one (a
    // concurrent onTurnDone may have replaced it; cancelSpindown may have already
    // removed it). Prevents stale lifecycle state on stop/commit failures.
    if (spindowns.get(task.id) === entry) spindowns.delete(task.id);
  }
}

/** Ask the sandbox daemon to commit + push any uncommitted work before we stop
 * the box, so a follow-up resumes from the latest state and nothing is lost.
 * Best-effort with a short timeout — if the daemon is already gone or never acks,
 * we proceed to stop anyway (the branch is the durable artifact). */
async function commitWip(task: TaskRef): Promise<void> {
  const sent = forwardToTaskWorker(task.id, {
    type: "commit_wip",
    taskId: task.id,
    workspaceId: task.workspaceId,
  });
  if (!sent) return; // no live daemon holding this task — nothing to ask
  await new Promise<void>((resolve) => {
    const done = () => {
      if (wipAcks.get(task.id) === done) wipAcks.delete(task.id);
      resolve();
    };
    wipAcks.set(task.id, done);
    const timer = setTimeout(done, 15_000);
    timer.unref?.();
  });
}

/** Resolve the awaiting commitWip when the daemon reports the WIP commit done. */
export function onWipCommitted(taskId: string): void {
  wipAcks.get(taskId)?.();
}
