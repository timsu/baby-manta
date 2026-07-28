// Ephemeral "answer a question" runs delegated to a worker daemon. Unlike a task,
// there's no kanban card and no Task row: the brain asks a question about a repo,
// we route it to ANY idle, question-capable worker whose owner is a member of the
// asking workspace (so non-engineer teammates without their own daemon can still
// ask), the daemon runs a read-only Pi turn in a repo checkout it holds, and
// streams the answer back. Correlated by a per-request questionId (mirrors the
// terminal relay's sessionId pattern).

import { randomBytes } from "node:crypto";
import { prisma } from "@manta/db";
import { claimWorkerForQuestion, releaseQuestionWorker } from "./registry.ts";
import { getRepoChatAuthBlob, getTaskAuthBlob } from "../models/service.ts";
import type { AuthBlob } from "@manta/agent";
import { createLogger } from "../logger.ts";
import type { AgentEvent } from "@manta/shared";

const logger = createLogger("Manta:Questions");

const QUESTION_ACK_TIMEOUT_MS = 5_000;
const QUESTION_TIMEOUT_MS = 180_000;

interface Pending {
  workerId: string;
  settle: (result: AskResult) => void;
  ackTimer: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
  /** Accumulated assistant text, used if the done frame carries no explicit answer. */
  text: string;
  /** The model requested for this question — logged with the outcome so an empty
   * answer can be tied to a provider/credential problem. */
  backendId: string;
  /** Progress notes the worker agent emits mid-investigation (post_update tool),
   * relayed to wherever the question came from (e.g. the Slack thread). */
  onUpdate?: (text: string) => void;
  /** Live worker events for browser repo chat. */
  onEvent?: (event: AgentEvent) => void;
}

const pending = new Map<string, Pending>();
const repoChatToolGrants = new Map<string, { workspaceId: string; userId: string; expiresAt: number }>();

/** Authorize a taskless repo-chat tool request. The unguessable grant exists
 * only for the lifetime of an active browser-started repo-chat turn, so another
 * read-only question running on the same daemon cannot call board mutations by
 * reading the daemon's long-lived worker credential. */
export function authorizeRepoChatToolGrant(token: string, workspaceId: string, userId: string): boolean {
  const grant = repoChatToolGrants.get(token);
  if (!grant || grant.expiresAt <= Date.now()) {
    if (grant) repoChatToolGrants.delete(token);
    return false;
  }
  return grant.workspaceId === workspaceId && grant.userId === userId;
}

export type AskResult =
  | { ok: true; answer: string }
  | { ok: false; reason: "no_worker" | "timeout" | "error"; message?: string };

/** Ask a question about `repo`, delegated to a worker. Resolves with the answer,
 * or `{ ok: false }` when no capable worker is online / it times out / it errors.
 * Never rejects — the caller gets a discriminated result. */
export async function askWorkerQuestion(
  input: { workspaceId: string; repo: string; question: string; backendId: string; ownerUserId?: string },
  onUpdate?: (text: string) => void,
  onEvent?: (event: AgentEvent) => void,
): Promise<AskResult> {
  let memberRows: Array<{ userId: string }>;
  try {
    memberRows = await prisma.membership.findMany({
      where: { workspaceId: input.workspaceId },
      select: { userId: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("question membership lookup failed", { workspaceId: input.workspaceId, repo: input.repo, error: message });
    return { ok: false, reason: "error", message };
  }
  const members = new Set(memberRows.map((m) => m.userId));

  const questionId = randomBytes(8).toString("hex");
  const worker = claimWorkerForQuestion(
    questionId,
    (uid) => members.has(uid) && (!input.ownerUserId || uid === input.ownerUserId),
    input.ownerUserId ? "repo_chat" : "run_question",
  );
  if (!worker) return { ok: false, reason: "no_worker" };

  // Vend workspace credentials for the requested model. Questions land on ANY
  // member's daemon (not necessarily the asker's), so we cannot rely on that
  // daemon being logged into the model's provider locally — without vended creds
  // the turn just returns empty. Resolved from the workspace member pool (same as
  // tasks/cloud) and applied in-memory on the daemon (no local-login clobber).
  let authJson: AuthBlob | null = null;
  try {
    authJson = input.ownerUserId
      ? await getRepoChatAuthBlob(input.workspaceId, input.ownerUserId)
      : await getTaskAuthBlob(input.workspaceId, null, input.backendId);
  } catch (err) {
    logger.warn("question auth resolve failed", { questionId, error: err instanceof Error ? err.message : String(err) });
  }
  if (!authJson) {
    logger.warn("question has no vendable credentials for model — daemon will use its local auth", {
      questionId,
      backendId: input.backendId,
    });
  }
  const workspaceToolToken = input.ownerUserId ? randomBytes(32).toString("hex") : null;
  if (workspaceToolToken && input.ownerUserId) {
    repoChatToolGrants.set(workspaceToolToken, {
      workspaceId: input.workspaceId,
      userId: input.ownerUserId,
      expiresAt: Date.now() + QUESTION_TIMEOUT_MS,
    });
  }

  return new Promise<AskResult>((resolve) => {
    const settle = (result: AskResult): void => {
      const p = pending.get(questionId);
      if (!p) return; // already settled
      clearTimeout(p.ackTimer);
      clearTimeout(p.timer);
      pending.delete(questionId);
      if (workspaceToolToken) repoChatToolGrants.delete(workspaceToolToken);
      releaseQuestionWorker(questionId);
      resolve(result);
    };
    const ackTimer = setTimeout(
      () => settle({ ok: false, reason: "timeout", message: `worker did not acknowledge within ${QUESTION_ACK_TIMEOUT_MS / 1000}s` }),
      QUESTION_ACK_TIMEOUT_MS,
    );
    ackTimer.unref?.();
    const timer = setTimeout(
      () => settle({ ok: false, reason: "timeout", message: `no response within ${QUESTION_TIMEOUT_MS / 1000}s` }),
      QUESTION_TIMEOUT_MS,
    );
    timer.unref?.();
    pending.set(questionId, {
      workerId: worker.workerId,
      settle,
      ackTimer,
      timer,
      text: "",
      backendId: input.backendId,
      ...(onUpdate ? { onUpdate } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    try {
      worker.send({
        type: "run_question",
        questionId,
        workspaceId: input.workspaceId,
        repo: input.repo,
        question: input.question,
        backendId: input.backendId,
        ...(workspaceToolToken ? { workspaceToolToken } : {}),
        ...(authJson ? { authJson } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("question dispatch failed", { questionId, workerId: worker.workerId, repo: input.repo, error: message });
      settle({ ok: false, reason: "error", message });
      return;
    }
    logger.info("question dispatched", { questionId, workerId: worker.workerId, repo: input.repo });
  });
}

/** Worker accepted the run_question frame. This is separate from the final answer:
 * it proves the supposedly-online socket/daemon is actually reading messages, so
 * callers do not wait minutes on a stale connection. */
export function acknowledgeQuestion(questionId: string): void {
  const p = pending.get(questionId);
  if (!p) return;
  clearTimeout(p.ackTimer);
}

/** Streamed event from the worker's question turn (accumulate assistant text for
 * the fallback answer; the final answer arrives on the done frame). */
export function onQuestionEvent(questionId: string, event: AgentEvent): void {
  const p = pending.get(questionId);
  if (!p) return;
  acknowledgeQuestion(questionId);
  if (event.type === "text" && typeof event.text === "string") p.text += event.text;
  p.onEvent?.(event);
}

/** A mid-investigation progress note from the worker agent (post_update tool) —
 * relay it to the question's origin (e.g. post it in the Slack thread). */
export function onQuestionUpdate(questionId: string, text: string): void {
  const p = pending.get(questionId);
  if (!p || !text.trim()) return;
  acknowledgeQuestion(questionId);
  p.onUpdate?.(text);
}

/** Worker finished — resolve with its answer (falling back to accumulated text). */
export function completeQuestion(questionId: string, answer?: string): void {
  const p = pending.get(questionId);
  if (!p) return;
  acknowledgeQuestion(questionId);
  const finalText = (answer?.trim() || p.text.trim());
  // Log the outcome so an empty answer is diagnosable (it usually means the worker
  // couldn't run the requested model — e.g. missing provider creds or tools).
  if (finalText) {
    logger.info("question answered", { questionId, workerId: p.workerId, backendId: p.backendId, chars: finalText.length });
  } else {
    logger.warn("question produced no answer", { questionId, workerId: p.workerId, backendId: p.backendId });
  }
  p.settle({ ok: true, answer: finalText || "(the worker finished but produced no answer)" });
}

export function failQuestion(questionId: string, message: string): void {
  acknowledgeQuestion(questionId);
  pending.get(questionId)?.settle({ ok: false, reason: "error", message });
}

/** Fail every pending question held by a worker that just disconnected. */
export function failWorkerQuestions(workerId: string, message: string): void {
  for (const [qid, p] of pending) {
    if (p.workerId === workerId) {
      logger.warn("question failed — worker gone", { questionId: qid, workerId });
      p.settle({ ok: false, reason: "error", message });
    }
  }
}

/** Fail every pending question. Used on graceful server shutdown so a brain turn
 * awaiting an ephemeral answer_question run resolves before this process exits;
 * otherwise Slack/web callers can be left with a dangling placeholder and the
 * worker's eventual buffered answer reconnects to a fresh process that no longer
 * has the in-memory pending question. */
export function failAllQuestions(message: string): void {
  for (const [qid, p] of pending) {
    logger.warn("question failed — server shutting down", { questionId: qid, workerId: p.workerId });
    p.settle({ ok: false, reason: "error", message });
  }
}
