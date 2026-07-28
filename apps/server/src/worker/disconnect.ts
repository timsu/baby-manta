import { prisma, tasks } from "@manta/db";
import { bus, kanbanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { noteOnCard } from "../notices.ts";
import { buildTaskPayload } from "./payload.ts";
import { availableWorkerCount, dispatchTask, freeTaskWorker, hasActiveTaskWorker } from "./registry.ts";
import { recentSandboxLog } from "./sandboxLog.ts";
import { flushTaskAccum } from "../ws/workerMessages.ts";

const logger = createLogger("Manta:Disconnect");

export type DisconnectedTaskResult =
  | "ignored"
  | "kept_active"
  | "replacement_dispatched"
  | "grace_pending"
  | "needs_help";

const REPLACEMENT_MESSAGE =
  "The previous worker disconnected mid-task. Please continue from the current card context and repository state.";

/**
 * How long a dropped worker has to come back before its in-flight card is failed
 * to Needs Help.
 *
 * A server deploy (or a Cloudflare/ALB proxy restart) drops every worker socket
 * at once while the daemons themselves keep running the turn locally and
 * reconnect within seconds. Failing the card the instant the socket dies turned
 * a routine deploy into a "Worker disconnected mid-task" note on healthy,
 * still-running work. `shuttingDown` in ws.ts covers only OUR graceful shutdown;
 * an abnormal close (1006) — the common case — needs this window instead.
 *
 * The window is cancelled the moment the worker proves it is alive: it
 * re-registers advertising the task in `activeTasks`, or any turn activity
 * streams for the task. Set to 0 to fail immediately (used by tests). Read
 * lazily so a deployment (or a test) can change it without a rebuild.
 */
function disconnectGraceMs(): number {
  return Number(process.env["WORKER_DISCONNECT_GRACE_MS"] ?? 60_000);
}

type GraceEntry = {
  workerId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Deferred failure, run when the window elapses without the worker returning. */
  fail: () => Promise<void>;
};

const disconnectGrace = new Map<string, GraceEntry>();

/** Cancel a pending disconnect failure — the worker (or some worker) proved the
 * task is alive. Safe to call for tasks with no pending window. */
export function cancelDisconnectGrace(taskId: string): void {
  const entry = disconnectGrace.get(taskId);
  if (!entry) return;
  clearTimeout(entry.timer);
  disconnectGrace.delete(taskId);
  logger.info("worker returned within the disconnect grace window — card left as-is", { taskId, workerId: entry.workerId });
}

/**
 * Reconcile a (re)connecting worker's claim against the tasks awaiting its
 * return. `claimedTaskIds` is what the daemon says it is still running.
 *
 * Anything it claims is alive — cancel the failure. Anything it does NOT claim
 * is genuinely over (the daemon restarted, or the turn ended while the socket
 * was down), so fail it now rather than making the user wait out the rest of the
 * window: the worker itself is the authority on what it is running.
 */
export function resolveDisconnectGrace(workerId: string, claimedTaskIds: string[]): void {
  const claimed = new Set(claimedTaskIds);
  for (const [taskId, entry] of [...disconnectGrace]) {
    if (entry.workerId !== workerId) continue;
    if (claimed.has(taskId)) {
      cancelDisconnectGrace(taskId);
      continue;
    }
    clearTimeout(entry.timer);
    disconnectGrace.delete(taskId);
    logger.info("worker reconnected without claiming task — failing it now", { taskId, workerId });
    void entry.fail().catch((err) => logger.error("deferred needs_help failed", { taskId, err }));
  }
}

/**
 * Handle a worker socket dropping while it had an active turn. A disconnected
 * worker should only move the card to Needs Help when no other valid worker can
 * continue: either another worker is already active on the same task, or another
 * connected owner worker can take over with a replacement turn.
 */
export async function handleDisconnectedActiveTask(
  workerId: string,
  workerOwnerUserId: string,
  taskId: string,
): Promise<DisconnectedTaskResult> {
  // Capture the box's recent output up front: a concurrent spindown can clear it
  // out from under us during the awaits below, and it's what tells the user WHY
  // the worker died (failed extension load, upstream 529, crash) rather than just
  // that it did.
  const recentOutput = recentSandboxLog(taskId);

  // A worker reply streams live but is only written to the DB on the turn's
  // done/error event. This socket dropped without either, so flush whatever the
  // worker streamed before it died — otherwise the reply the user already saw
  // disappears on reload. Do this unconditionally, before the cardStatus guards
  // below: a follow-up on a Ready-To-Test card re-activates the worker but never
  // moves the card to bot_working, so the "ignored" path would otherwise lose it.
  await flushTaskAccum(taskId).catch((err) => {
    logger.warn("failed to flush worker reply on disconnect", { taskId, err });
  });

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.cardStatus !== "bot_working") return "ignored";

  const workerOwnsTask = task.createdBy === workerOwnerUserId || workerOwnerUserId === `sandbox:${taskId}`;
  if (!workerOwnsTask) return "ignored";

  const scope = { workspaceId: task.workspaceId };

  if (hasActiveTaskWorker(taskId)) {
    cancelDisconnectGrace(taskId);
    await tasks.setWorker(scope, taskId, { workerActive: true, workerStatus: "running" });
    bus.publish(kanbanTopic(task.workspaceId), {});
    return "kept_active";
  }

  if (task.createdBy && availableWorkerCount(task.createdBy) > 0) {
    await tasks.setWorker(scope, taskId, {
      workerActive: true,
      workerStatus: "running",
      workerVenue: "laptop",
      venueStatus: "active",
    });
    const dispatched = dispatchTask(
      {
        type: "run_task",
        taskId,
        workspaceId: task.workspaceId,
        message: REPLACEMENT_MESSAGE,
        task: await buildTaskPayload(task),
      },
      task.createdBy,
    );
    if (dispatched) {
      cancelDisconnectGrace(taskId);
      bus.publish(kanbanTopic(task.workspaceId), {});
      return "replacement_dispatched";
    }
  }

  // No other worker can take over. Before failing the card, give this one a
  // window to come back: a deploy or proxy restart drops the socket while the
  // daemon keeps running the turn, and it re-registers seconds later.
  const fail = async (): Promise<void> => {
    // Re-check under the current state: the card may have finished, been retried
    // onto another worker, or picked up again while the window was open.
    const current = await prisma.task.findUnique({ where: { id: taskId } });
    if (!current || current.cardStatus !== "bot_working") return;
    if (hasActiveTaskWorker(taskId)) return;
    await tasks.setWorker(scope, taskId, { workerActive: false });
    await tasks.transition(scope, taskId, "needs_help", "worker", {
      reason: "Worker disconnected",
    });
    const tail = recentOutput.trim();
    const detail = tail ? `\n\nLast worker output before it died:\n\`\`\`\n${tail}\n\`\`\`` : "";
    await noteOnCard(
      scope,
      taskId,
      `🚨 Worker \`${workerId}\` disconnected mid-task and did not come back — moved to Needs Help. Use Retry Worker to resume.${detail}`,
    );
    bus.publish(kanbanTopic(task.workspaceId), {});
  };

  const graceMs = disconnectGraceMs();
  if (graceMs <= 0) {
    await fail();
    return "needs_help";
  }

  // Leave the card in bot_working with its worker flags intact for now — a
  // deploy should look like a brief blip, not a failure.
  const existing = disconnectGrace.get(taskId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    disconnectGrace.delete(taskId);
    logger.warn("worker did not return within the disconnect grace window", { taskId, workerId, ms: graceMs });
    void fail().catch((err) => logger.error("deferred needs_help failed", { taskId, err }));
  }, graceMs);
  timer.unref?.();
  disconnectGrace.set(taskId, { workerId, timer, fail });
  logger.info("worker dropped mid-task — holding the card while it reconnects", { taskId, workerId, ms: graceMs });
  return "grace_pending";
}

/**
 * Handle an acked dispatch that then streamed no output within the liveness window
 * (see registry's post-ack watchdog). Unlike a socket drop, the worker is still
 * connected — its turn is wedged (a hung subprocess a reconnect orphaned, holding
 * the daemon's per-task drain lock). Move the card to Needs Help so it stops
 * spinning on "working…", but KEEP the worktree-home routing: a Retry re-dispatches
 * to the same daemon, which (worker v8+) aborts the wedged turn after a grace period
 * and starts a fresh turn on a new session.
 */
export async function handleWedgedTask(taskId: string, workerId: string): Promise<void> {
  // A wedged turn streamed nothing, but flush defensively for parity with the
  // disconnect path (a partial reply that arrived pre-wedge must survive a reload).
  await flushTaskAccum(taskId).catch((err) => {
    logger.warn("failed to flush worker reply on wedge", { taskId, err });
  });

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.cardStatus !== "bot_working") return;
  const scope = { workspaceId: task.workspaceId };

  // Free the active-turn slot so a Retry can re-dispatch, but leave taskHomeWorker
  // intact (disposeTaskWorker would tear down the worktree routing and node_modules)
  // so the retry lands back on the daemon that still holds the checkout.
  freeTaskWorker(taskId);
  await tasks.setWorker(scope, taskId, { workerActive: false, workerStatus: "stalled" });
  await tasks.transition(scope, taskId, "needs_help", "worker", {
    reason: "Worker acked but produced no output",
  });
  await noteOnCard(
    scope,
    taskId,
    `🚨 Worker \`${workerId}\` acked the dispatch but produced no output — the turn looks wedged (a stuck subprocess a reconnect left behind). Moved to Needs Help. Use Retry Worker to start a fresh turn.`,
  );
  bus.publish(kanbanTopic(task.workspaceId), {});
}
