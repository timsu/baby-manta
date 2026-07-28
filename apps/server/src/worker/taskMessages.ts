import { messages, tasks, type Task } from "@manta/db";
import { bus, kanbanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { noteOnCard } from "../notices.ts";
import { normalizeTaskRepoForDispatch } from "../repos/canonical.ts";
import { checkpointTaskAccum } from "../ws/workerMessages.ts";
import { buildLaptopRunTaskPayload, startWorkerForTask } from "./dispatch.ts";
import { onTurnStart } from "./lifecycle.ts";
import { buildTaskPayload } from "./payload.ts";
import { withTaskTranscriptLock } from "./taskTranscriptLock.ts";
import {
  forwardToTaskWorker,
  isExternalTask,
} from "./registry.ts";

const logger = createLogger("Manta:TaskMessages");

async function dispatchPersistedMessage(task: Task, message: string, requireIdle = false): Promise<boolean> {
  // Brain follow-ups have no queue: they must claim a fresh turn rather than
  // forwarding into an existing one that could already be consuming another
  // instruction.
  if (!requireIdle && isExternalTask(task.id)) {
    if (task.workerVenue === "daytona") onTurnStart(task);
    const forwarded = forwardToTaskWorker(task.id, {
      type: "run_task",
      taskId: task.id,
      workspaceId: task.workspaceId,
      message,
      task: await buildTaskPayload(task),
    });
    // The holding worker can disconnect while the payload is being built. Do
    // not strand the persisted message on that stale routing entry; continue
    // through normal laptop/cloud selection when forwarding loses the race.
    if (forwarded) return true;
  }

  // Claiming the worker slot is the durable dispatch acknowledgement. It also
  // prevents a finished/review-ready card from merely accumulating messages:
  // startWorkerForTask moves its newly active turn through the normal venue
  // dispatcher before the caller reports delivery.
  return startWorkerForTask(task, message, { messageAlreadyPersisted: true });
}

async function markDispatchFailure(task: Task, err: unknown): Promise<void> {
  logger.error("task message dispatch failed", { taskId: task.id, err });
  const scope = { workspaceId: task.workspaceId };
  await tasks.setWorker(scope, task.id, { workerActive: false, workerStatus: "failed" }).catch(() => {});
  await tasks.transition(scope, task.id, "needs_help", "worker", { reason: "Worker failed to start" }).catch(() => {});
  const detail = err instanceof Error ? err.message : String(err);
  await noteOnCard(scope, task.id, `🚨 Worker failed to start — moved to Needs Help.\n\n${detail}`).catch(() => {});
  bus.publish(kanbanTopic(task.workspaceId), {});
}

/** Persist a user message before asynchronously dispatching it to a worker.
 * Returning after the durable append lets browser keepalive requests complete
 * even when the user immediately navigates away or closes the page. */
export interface AcceptedTaskMessage {
  task: Task;
  dispatched: boolean;
}

export interface AcceptTaskMessageOptions {
  /** Reject rather than forwarding to an in-flight worker turn. */
  requireIdle?: boolean;
}

export async function acceptTaskMessage(
  workspaceId: string,
  taskId: string,
  message: string,
  actor: "human" | "brain" = "human",
  opts: AcceptTaskMessageOptions = {},
): Promise<AcceptedTaskMessage | null> {
  let task = await tasks.get({ workspaceId }, taskId);
  if (!task) return null;
  if (opts.requireIdle && task.workerActive) return { task, dispatched: false };
  task = await normalizeTaskRepoForDispatch(task);
  if (task.cardStatus === "investigation_complete" || task.cardStatus === "ready_to_test" || task.cardStatus === "pr_review" || task.cardStatus === "done") {
    try {
      task = await tasks.transition({ workspaceId }, task.id, "bot_working", actor, {
        reason: actor === "brain" ? "Brain sent follow-up" : "User sent follow-up",
      });
    } catch (err) {
      // Another follow-up may have reactivated this card between our read and
      // transition. Re-read and continue through the normal busy/claim path so
      // the later message is not dropped before it reaches the transcript.
      const current = await tasks.get({ workspaceId }, task.id);
      if (current?.cardStatus !== "bot_working") throw err;
      task = current;
    }
    bus.publish(kanbanTopic(workspaceId), {});
  }

  // Worker output is streamed immediately but normally persisted only at the
  // end of the turn. Checkpoint it before this eagerly persisted follow-up so
  // reopening the card preserves the chronology the user saw live.
  await withTaskTranscriptLock(task.id, async () => {
    await checkpointTaskAccum(workspaceId, task.id);
    await messages.append({ workspaceId }, { channel: task.id, role: "user", content: message });
  });
  try {
    const dispatched = await dispatchPersistedMessage(task, message, opts.requireIdle);
    if (dispatched) return { task, dispatched: true };
    // A false claim normally means another dispatcher won. Do not overwrite its
    // active turn, but surface a real no-dispatch rather than leaving this
    // persisted instruction on an apparently-working card.
    const current = await tasks.get({ workspaceId }, task.id);
    if (!current?.workerActive) {
      await markDispatchFailure(task, new Error("No worker turn could be claimed"));
    }
    return { task, dispatched: false };
  } catch (err) {
    await markDispatchFailure(task, err);
    return { task, dispatched: false };
  }
}
