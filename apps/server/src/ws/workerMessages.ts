import { messages, tasks } from "@manta/db";
import type { AgentEvent } from "@manta/shared";
import { bus, chanTopic, kanbanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { claimTaskWorktrees, freeTaskWorker, markTaskActivity } from "../worker/registry.ts";
import { cancelDisconnectGrace } from "../worker/disconnect.ts";
import { onTurnDone, onWipCommitted } from "../worker/lifecycle.ts";
import { clearTaskSnapshot, loadTaskSnapshot, saveTaskSnapshot } from "../worker/snapshot.ts";
import { acknowledgeQuestion, completeQuestion, failQuestion, onQuestionEvent, onQuestionUpdate } from "../worker/questions.ts";
import { withTaskTranscriptLock } from "../worker/taskTranscriptLock.ts";
import { taskAccums, taskEventBuffers, terminalSessions, pendingUserQuestions, pushTaskEventBuffer, TASK_EVENTS_MAX, type TaskAccum } from "./state.ts";
import { noteOnCard } from "../notices.ts";

const wsLogger = createLogger("Manta:WS");

type BoundScope = { taskId: string; workspaceId: string };

interface HandleWorkerMessageArgs {
  msg: Record<string, unknown>;
  send: (obj: unknown) => void;
  boundScope: BoundScope | null;
  workerId: string;
}

/** Handle messages that are only valid after a worker socket has registered. */
export async function handleRegisteredWorkerMessage({ msg, send, boundScope, workerId }: HandleWorkerMessageArgs): Promise<boolean> {
  // ── Ephemeral question stream (keyed by questionId, no Task) ──────────────
  const questionId = msg["questionId"] as string | undefined;
  if (questionId) {
    if (msg["type"] === "question_ack") {
      acknowledgeQuestion(questionId);
      return true;
    }
    if (msg["type"] === "question_event") {
      onQuestionEvent(questionId, msg["event"] as AgentEvent);
      return true;
    }
    if (msg["type"] === "question_update") {
      onQuestionUpdate(questionId, String(msg["text"] ?? ""));
      return true;
    }
    if (msg["type"] === "question_done") {
      completeQuestion(questionId, msg["answer"] as string | undefined);
      return true;
    }
    if (msg["type"] === "question_error") {
      failQuestion(questionId, String(msg["message"] ?? "worker error"));
      return true;
    }
  }

  const taskId = msg["taskId"] as string | undefined;
  const workspaceId = msg["workspaceId"] as string | undefined;

  // A sandbox connection may only act on the one task its token is bound
  // to — drop any event it forges for another task/workspace. (Terminal
  // frames carry only taskId, no workspaceId; the per-field checks allow
  // them through for the bound task.)
  if (boundScope) {
    if (taskId !== undefined && taskId !== boundScope.taskId) return true;
    if (workspaceId !== undefined && workspaceId !== boundScope.workspaceId) return true;
  }

  // Only validated turn-progress messages prove an acked turn is alive. A stale
  // or unrelated task-scoped packet must not cancel its liveness watchdog.
  const isTurnActivity = msg["type"] === "worker_event"
    || msg["type"] === "ask_user_question"
    || msg["type"] === "worker_session"
    || msg["type"] === "worker_worktree"
    || msg["type"] === "worker_setup";
  if (taskId && isTurnActivity) {
    markTaskActivity(taskId);
    // Streamed activity proves a worker is on this card — release any hold left
    // by an earlier socket drop (e.g. a retry landed while the window was open).
    cancelDisconnectGrace(taskId);
  }

  if (msg["type"] === "worker_event" && taskId && workspaceId) {
    await withTaskTranscriptLock(taskId, () => handleWorkerEvent(msg, taskId, workspaceId, boundScope));
    return true;
  }

  if (msg["type"] === "ask_user_question" && taskId && workspaceId) {
    const userQuestionId = String(msg["userQuestionId"] ?? "");
    const questions = Array.isArray(msg["questions"]) ? msg["questions"] : [];
    if (!userQuestionId || questions.length === 0) return true;
    const task = await tasks.get({ workspaceId }, taskId);
    pendingUserQuestions.set(userQuestionId, {
      workspaceId,
      taskId,
      ownerUserId: task?.createdBy ?? null,
      questionId: userQuestionId,
      questions: questions as never,
      answer: (answer: string) => {
        try {
          send({ type: "answer_user_question", userQuestionId, answer });
          return true;
        } catch (err) {
          wsLogger.warn("failed to forward user question answer to worker", { taskId, userQuestionId, err });
          return false;
        }
      },
    });
    bus.publish(chanTopic(workspaceId, "brain"), { type: "user_question_pending", taskId, questionId: userQuestionId, questions, ownerUserId: task?.createdBy ?? null } as never);
    return true;
  }

  // ── WIP commit acked by a sandbox before spindown ─────────────────
  if (msg["type"] === "worker_wip_committed" && taskId) {
    onWipCommitted(taskId);
    return true;
  }

  if (msg["type"] === "worker_session" && taskId && workspaceId) {
    const sessionKey = msg["sessionKey"] as string;
    await tasks.setWorker({ workspaceId }, taskId, { sessionBlobKey: sessionKey });
    return true;
  }

  if (msg["type"] === "worker_worktree" && taskId && workspaceId) {
    const worktreePath = msg["worktreePath"] as string;
    const branch = msg["branch"] as string;
    // The worker just proved it physically holds this worktree. Keep terminal
    // routing in sync even if a prior dispatch/register mapping was missed.
    claimTaskWorktrees(workerId, [taskId]);
    await tasks.setWorker({ workspaceId }, taskId, { worktreePath, branch, workerStatus: "running" });
    bus.publish(kanbanTopic(workspaceId), {});
    return true;
  }

  if (msg["type"] === "worker_setup" && taskId && workspaceId) {
    await handleWorkerSetup(msg, taskId, workspaceId);
    return true;
  }

  if (isTerminalFrame(msg)) {
    handleTerminalFrame(msg);
    return true;
  }

  if (msg["type"] === "worker_error" && taskId && workspaceId) {
    await withTaskTranscriptLock(taskId, () => handleWorkerError(msg, taskId, workspaceId));
    return true;
  }

  return false;
}

/**
 * Persist any accumulated-but-unflushed assistant reply for a task, then drop the
 * in-memory turn state. Worker replies stream live over the bus but are only
 * written to the DB on the turn's `done`/`error` event; if the worker socket drops
 * mid-turn (daemon restart, network blip, a Codex hiccup) neither fires, so the
 * reply you already saw live vanishes on reload. The disconnect path calls this so
 * a streamed-but-uncommitted reply survives a refresh — even for cards that aren't
 * `bot_working` (e.g. a follow-up on a Ready-To-Test card), where the rest of the
 * disconnect handler intentionally leaves card state alone. Returns true if a
 * message was persisted. Safe to call when nothing is buffered (no-op).
 */
export function flushTaskAccum(taskId: string): Promise<boolean> {
  return withTaskTranscriptLock(taskId, () => flushTaskAccumUnlocked(taskId));
}

async function flushTaskAccumUnlocked(taskId: string): Promise<boolean> {
  const accum = taskAccums.get(taskId);
  if (!accum) return false;
  // Claim the turn state synchronously (before any await) so a racing `done` event
  // — the turn finishing on a superseded socket — sees no accum and can't
  // double-persist the same reply.
  taskAccums.delete(taskId);
  if (!accum.assistantText && accum.toolTrace.length === 0 && accum.transcript.length === 0) {
    taskEventBuffers.delete(taskId);
    clearTaskSnapshot(taskId);
    return false;
  }
  try {
    await persistTaskAccum(taskId, accum);
  } catch (err) {
    // Persistence failed (transient DB error). Restore the claimed accum so the
    // reply isn't lost — a later flush or `done` event can retry instead of
    // dropping it permanently. Don't clobber a fresh turn's accum if one started.
    if (!taskAccums.has(taskId)) taskAccums.set(taskId, accum);
    throw err;
  }
  // Only drop the replay/recovery buffers once the reply is durably stored.
  taskEventBuffers.delete(taskId);
  clearTaskSnapshot(taskId);
  wsLogger.info("flushed unpersisted worker reply on disconnect", { taskId, chars: accum.assistantText.length });
  return true;
}

function hasPersistableTaskAccum(accum: TaskAccum): boolean {
  return accum.assistantText.length > 0 || accum.toolTrace.length > 0 || accum.transcript.length > 0;
}

async function persistTaskAccum(taskId: string, accum: TaskAccum): Promise<void> {
  const transcript = accum.transcript.length > 0
    ? accum.transcript
    : accum.assistantText.length > 0
      ? [{ type: "assistant" as const, text: accum.assistantText }]
      : [];
  await messages.append(
    { workspaceId: accum.workspaceId },
    {
      channel: taskId,
      role: "assistant",
      content: accum.assistantText,
      ...(accum.toolTrace.length || transcript.length
        ? { meta: { tools: accum.toolTrace, transcript } }
        : {}),
    },
  );
}

/** Retract every `ask_user_question` menu still outstanding for a task. Called
 * when the asking turn ends by any route (done, error, abandonment) — the
 * resolver that would have received the answer no longer exists. */
function resolvePendingUserQuestions(taskId: string, workspaceId: string): void {
  for (const [questionId, q] of pendingUserQuestions) {
    if (q.taskId === taskId && q.workspaceId === workspaceId) {
      pendingUserQuestions.delete(questionId);
      bus.publish(chanTopic(workspaceId, "brain"), { type: "user_question_resolved", questionId } as never);
    }
  }
}

/**
 * Persist the output streamed so far before a user follow-up is appended.
 *
 * Assistant output normally becomes durable only when its turn ends. Without
 * this checkpoint, a follow-up sent mid-turn receives an earlier message seq
 * than all of the assistant output already visible above it, so reopening the
 * card displays the conversation out of order.
 *
 * Install a fresh accumulator synchronously before writing the checkpoint so
 * worker events arriving during the DB write belong to the next transcript
 * segment and cannot be lost or hydrated from the just-cleared snapshot.
 */
export async function checkpointTaskAccum(workspaceId: string, taskId: string): Promise<boolean> {
  let accum = taskAccums.get(taskId);
  if (!accum) {
    const snap = await loadTaskSnapshot(taskId);
    if (snap) {
      accum = {
        workspaceId,
        assistantText: snap.assistantText,
        toolTrace: snap.toolTrace,
        transcript: snap.transcript ?? [],
      };
      taskAccums.set(taskId, accum);
    }
  }
  if (!accum || !hasPersistableTaskAccum(accum)) return false;

  const nextAccum: TaskAccum = {
    workspaceId: accum.workspaceId,
    assistantText: "",
    toolTrace: [],
    transcript: [],
  };
  taskAccums.set(taskId, nextAccum);
  taskEventBuffers.delete(taskId);
  clearTaskSnapshot(taskId);

  try {
    await persistTaskAccum(taskId, accum);
  } catch (err) {
    // The user message is not appended when checkpointing fails. Rejoin any
    // output that arrived during the failed write so the active turn can still
    // be persisted by its normal done/disconnect path.
    nextAccum.assistantText = accum.assistantText + nextAccum.assistantText;
    nextAccum.toolTrace = [...accum.toolTrace, ...nextAccum.toolTrace];
    nextAccum.transcript = [...accum.transcript, ...nextAccum.transcript];
    throw err;
  }
  return true;
}

async function handleWorkerEvent(
  msg: Record<string, unknown>,
  taskId: string,
  workspaceId: string,
  boundScope: BoundScope | null,
): Promise<void> {
  const event = msg["event"] as AgentEvent;
  const scope = { workspaceId };

  // Accumulate for DB persistence. On the first event for a task with no
  // in-memory accum, hydrate from the snapshot cache: a turn whose stream
  // began before a deploy keeps its pre-deploy text/events instead of
  // persisting only the tail that arrived after the restart.
  let accum = taskAccums.get(taskId);
  if (!accum) {
    const snap = await loadTaskSnapshot(taskId);
    accum = {
      workspaceId,
      assistantText: snap?.assistantText ?? "",
      toolTrace: snap?.toolTrace ?? [],
      transcript: snap?.transcript ?? [],
    };
    taskAccums.set(taskId, accum);
    if (snap?.events?.length && !taskEventBuffers.has(taskId)) {
      taskEventBuffers.set(taskId, snap.events.slice(-TASK_EVENTS_MAX));
    }
  }

  // Relay to subscribed browser sockets.
  bus.publish(chanTopic(workspaceId, taskId), event);

  // Buffer for re-subscribe replay.
  pushTaskEventBuffer(taskId, event);

  if (event.type === "text") {
    accum.assistantText += event.text;
    const last = accum.transcript[accum.transcript.length - 1];
    if (last?.type === "assistant") last.text += event.text;
    else accum.transcript.push({ type: "assistant", text: event.text });
  }
  if (event.type === "thinking") {
    const last = accum.transcript[accum.transcript.length - 1];
    if (last?.type === "thinking") last.text += event.text;
    else accum.transcript.push({ type: "thinking", text: event.text });
  }
  if (event.type === "tool_use") {
    const tool = { tool: event.toolName, args: event.argsPreview };
    accum.toolTrace.push(tool);
    accum.transcript.push({ type: "tool", ...tool });

    // A tool call proves the worker is actively making progress again.
    // If the card was previously marked Needs Help (for example by a
    // disconnect/stall race), move it back to Bot Working immediately.
    // Explicit handoff tools are the exception: they intentionally leave the
    // card there so a human can correct/review the request before retrying.
    const task = await tasks.get(scope, taskId);
    if (task?.cardStatus === "needs_help" && !["send_card_to_needs_help", "switch_card_repo", "plan_ready"].includes(event.toolName)) {
      try {
        await tasks.transition(scope, taskId, "bot_working", "worker", { reason: "worker resumed with tool use" });
        await tasks.setWorker(scope, taskId, { workerActive: true, workerStatus: "running" });
        bus.publish(kanbanTopic(workspaceId), {});
      } catch (err) {
        wsLogger.warn("failed to restore needs_help task on worker tool use", { taskId, err });
      }
    }
  }
  if (event.type === "tool_result") {
    const preview = event.preview?.trim();
    const text = `Tool result: ${event.ok ? "ok" : "failed"}${preview ? ` — ${preview}` : ""}`;
    accum.transcript.push({ type: "status", text });
  }

  if (event.type === "done" || event.type === "error") {
    resolvePendingUserQuestions(taskId, workspaceId);
    // Free the worker FIRST (synchronous) so that if onClose races with
    // this handler — worker finishes then immediately drops — onClose's
    // unregisterWorker sees a freed slot and won't false-flag needs_help.
    freeTaskWorker(taskId);
    // Persist assistant message to DB.
    if (hasPersistableTaskAccum(accum)) {
      await persistTaskAccum(taskId, accum);
    }
    // Persist the error message itself so it survives a reload (the live bus
    // publish at line 128 is ephemeral; without this it disappears on close).
    if (event.type === "error" && event.message) {
      await messages.append(scope, { channel: taskId, role: "status", content: `⚠️ ${event.message}` });
    }
    taskAccums.delete(taskId);
    taskEventBuffers.delete(taskId);
    clearTaskSnapshot(taskId);
    const completedBackgroundTask = event.type === "done" && event.reason === "end_turn"
      ? await completeBackgroundTaskOnDone(scope, taskId)
      : false;
    await tasks.setWorker(scope, taskId, {
      workerActive: false,
      ...(completedBackgroundTask ? { workerStatus: "done" as const } : {}),
    });
    // Cloud sandbox: a turn just ended. Keep the box warm for a grace
    // window, then commit WIP + stop it (lifecycle owns venueStatus).
    if (boundScope) onTurnDone({ id: taskId, workspaceId });
    bus.publish(chanTopic(workspaceId, "brain"), { type: "worker_notification", taskId });
    bus.publish(kanbanTopic(workspaceId), {});
  } else {
    // Throttled mirror so a deploy mid-turn can recover this state.
    saveTaskSnapshot(taskId, {
      assistantText: accum.assistantText,
      toolTrace: accum.toolTrace,
      transcript: accum.transcript,
      events: taskEventBuffers.get(taskId) ?? [],
    });
  }
}

async function completeBackgroundTaskOnDone(scope: { workspaceId: string }, taskId: string): Promise<boolean> {
  try {
    const task = await tasks.get(scope, taskId);
    if (!task?.backgroundMode || task.cardStatus === "done" || task.cardStatus === "canceled" || task.cardStatus === "needs_help") return false;

    await tasks.transition(scope, taskId, "done", "worker", {
      doneReason: "completed",
      reason: "Background worker run completed",
      ...(task.cardStatus === "bot_working" ? {} : { force: true }),
    });
    return true;
  } catch (err) {
    wsLogger.warn("failed to mark completed background task done", { taskId, err });
    return false;
  }
}

async function handleWorkerSetup(msg: Record<string, unknown>, taskId: string, workspaceId: string): Promise<void> {
  const chunk = msg["chunk"] as string | undefined;
  if (chunk !== undefined) {
    // Live-only setup output. Keep it distinct from assistant text so the web
    // client doesn't append install logs to the first agent response bubble.
    // The final `content` below is the persisted record of the run.
    bus.publish(chanTopic(workspaceId, taskId), { type: "setup", text: chunk });
    return;
  }
  const content = msg["content"] as string | undefined;
  if (content) {
    await messages.append({ workspaceId }, { channel: taskId, role: "status", content });
  }
}

function isTerminalFrame(msg: Record<string, unknown>): boolean {
  return msg["type"] === "terminal_output" || msg["type"] === "terminal_ready" ||
    msg["type"] === "terminal_exit" || msg["type"] === "terminal_error";
}

function handleTerminalFrame(msg: Record<string, unknown>): void {
  const sessionId = msg["sessionId"] as string | undefined;
  const sess = sessionId ? terminalSessions.get(sessionId) : undefined;
  if (!sess) return;
  if (msg["type"] === "terminal_output") {
    sess.send(JSON.stringify({ type: "output", data: msg["data"] }));
  } else if (msg["type"] === "terminal_ready") {
    sess.send(JSON.stringify({ type: "ready" }));
  } else if (msg["type"] === "terminal_error") {
    sess.send(JSON.stringify({ type: "output", data: `\r\n${String(msg["message"] ?? "terminal error")}\r\n` }));
    sess.close(1011, "terminal error");
    terminalSessions.delete(sessionId!);
  } else { // terminal_exit
    sess.close(1000, "pty exited");
    terminalSessions.delete(sessionId!);
  }
}

async function handleWorkerError(msg: Record<string, unknown>, taskId: string, workspaceId: string): Promise<void> {
  const scope = { workspaceId };
  const errorMsg = (msg["message"] as string | undefined) ?? "worker error";
  bus.publish(chanTopic(workspaceId, taskId), { type: "error", message: errorMsg });
  freeTaskWorker(taskId);
  // The turn that asked is gone, so any outstanding prompt is dead: answering it
  // would resolve nothing. Retract the menus (same as the done/error path).
  resolvePendingUserQuestions(taskId, workspaceId);

  // Persist any partial assistant text accumulated before the error.
  const accum = taskAccums.get(taskId);
  if (accum && hasPersistableTaskAccum(accum)) {
    await persistTaskAccum(taskId, accum);
  }
  taskAccums.delete(taskId);
  taskEventBuffers.delete(taskId);
  clearTaskSnapshot(taskId);

  const task = await tasks.get(scope, taskId);
  if (task) {
    await tasks.setWorker(scope, taskId, { workerActive: false, workerStatus: "failed" });
    if (task.cardStatus === "bot_working") {
      await tasks.transition(scope, taskId, "needs_help", "worker", { reason: errorMsg });
    }
    await noteOnCard(scope, taskId, `🚨 Worker error: ${errorMsg}`);
  }
  bus.publish(chanTopic(workspaceId, "brain"), { type: "worker_notification", taskId });
  bus.publish(kanbanTopic(workspaceId), {});
}
