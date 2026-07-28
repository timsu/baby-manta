// Settling the `ask_user_question` menus the browser shows for a worker turn.
//
// The prompt itself lives in an in-memory map on whichever process received it
// (see `pendingUserQuestions` in state.ts), while the menu lives in the browser
// until something retracts it. Those two lifetimes routinely disagree: the
// asking turn ends or is abandoned, or a deploy replaces the process, and the
// user is left clicking a menu nothing is listening for.

import { bus, chanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { acceptTaskMessage } from "../worker/taskMessages.ts";
import { pendingUserQuestions, type PendingUserQuestion } from "./state.ts";

const logger = createLogger("Manta:UserQuestions");

/** Ownerless automation prompts are answerable by any member; an owned one only
 * by its owner. */
export function canUsePendingQuestion(question: Pick<PendingUserQuestion, "ownerUserId">, userId: string): boolean {
  return question.ownerUserId === null || question.ownerUserId === userId;
}

export interface ResolveQuestionOptions {
  /** The answer text, or the dismissal note. */
  text: string;
  /**
   * When the prompt is gone, deliver `text` as an ordinary follow-up message so
   * the card picks up where the question left off. True for a real answer (the
   * user's intent is "continue with this"), false for a dismissal.
   */
  resumeWhenUndeliverable: boolean;
}

/**
 * Settle a question menu the browser just acted on.
 *
 * Always tells the browser the menu is done — every "not found" path used to be
 * a silent return, which left the menu stuck on "Sending…" forever and threw the
 * answer away. When the answer cannot be handed to a waiting turn, it is
 * delivered as a normal follow-up message instead, which re-dispatches the card
 * and resumes the work the question was blocking.
 */
export async function resolveUserQuestion(
  reply: (obj: unknown) => void,
  userId: string,
  workspaceId: string,
  taskId: string,
  questionId: string,
  opts: ResolveQuestionOptions,
): Promise<void> {
  const found = pendingUserQuestions.get(questionId);
  const pending = found && found.workspaceId === workspaceId && found.taskId === taskId ? found : undefined;

  // Someone else's prompt: retract this viewer's copy, but leave it answerable
  // by the member it belongs to.
  if (pending && !canUsePendingQuestion(pending, userId)) {
    reply({ type: "user_question_resolved", questionId });
    return;
  }

  const delivered = pending ? pending.answer(opts.text) : false;
  if (pending) pendingUserQuestions.delete(questionId);
  reply({ type: "user_question_resolved", questionId });
  // A question ID can still be pending for another task. Settle only this
  // client's stale menu in that case; broadcasting would retract the active
  // prompt in every other client.
  if (!found || pending) {
    bus.publish(chanTopic(workspaceId, "brain"), { type: "user_question_resolved", questionId } as never);
  }

  if (delivered || !opts.resumeWhenUndeliverable) return;
  logger.info("question prompt was gone — resuming the card with the answer as a follow-up", { taskId, questionId });
  const accepted = await acceptTaskMessage(workspaceId, taskId, opts.text);
  if (accepted?.dispatched) reply({ type: "user_ack", channel: accepted.task.id, text: opts.text });
}
