import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUserQuestion } from "./userQuestions.ts";
import { pendingUserQuestions } from "./state.ts";

const mocks = vi.hoisted(() => ({
  acceptTaskMessage: vi.fn(async (_w: string, taskId: string) => ({ task: { id: taskId }, dispatched: true })),
  publish: vi.fn(),
}));

vi.mock("../bus.ts", () => ({
  bus: { publish: mocks.publish },
  chanTopic: (w: string, c: string) => `${w}:${c}`,
}));
vi.mock("../worker/taskMessages.ts", () => ({ acceptTaskMessage: mocks.acceptTaskMessage }));

function pending(overrides: Partial<{ ownerUserId: string | null; answer: () => boolean }> = {}) {
  const answer = overrides.answer ?? vi.fn(() => true);
  pendingUserQuestions.set("q1", {
    workspaceId: "w1",
    taskId: "c-1",
    ownerUserId: "ownerUserId" in overrides ? overrides.ownerUserId! : "u1",
    questionId: "q1",
    questions: [] as never,
    answer: answer as never,
  });
  return answer;
}

afterEach(() => {
  pendingUserQuestions.clear();
  vi.clearAllMocks();
});

describe("resolveUserQuestion", () => {
  const opts = { text: "Option A", resumeWhenUndeliverable: true };

  it("hands the answer to the waiting turn and retracts the menu", async () => {
    const answer = pending();
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-1", "q1", opts);

    expect(answer).toHaveBeenCalledWith("Option A");
    expect(sent).toContainEqual({ type: "user_question_resolved", questionId: "q1" });
    expect(pendingUserQuestions.has("q1")).toBe(false);
    // The turn is waiting on the tool result — no follow-up message needed.
    expect(mocks.acceptTaskMessage).not.toHaveBeenCalled();
  });

  it("resumes the card with the answer when the prompt is already gone", async () => {
    // The asking turn ended/was abandoned, or a deploy wiped the in-memory map,
    // while the menu stayed on screen. The answer must not vanish.
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-1", "q1", opts);

    expect(sent).toContainEqual({ type: "user_question_resolved", questionId: "q1" });
    expect(mocks.acceptTaskMessage).toHaveBeenCalledWith("w1", "c-1", "Option A");
    expect(sent).toContainEqual({ type: "user_ack", channel: "c-1", text: "Option A" });
    expect(mocks.publish).toHaveBeenCalledWith("w1:brain", { type: "user_question_resolved", questionId: "q1" });
  });

  it("resumes the card when the worker socket rejects the answer", async () => {
    pending({ answer: vi.fn(() => false) });
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-1", "q1", opts);

    expect(sent).toContainEqual({ type: "user_question_resolved", questionId: "q1" });
    expect(mocks.acceptTaskMessage).toHaveBeenCalledWith("w1", "c-1", "Option A");
  });

  it("does not resume the card on a dismissal", async () => {
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-1", "q1", {
      text: "Dismissed by user without an answer.",
      resumeWhenUndeliverable: false,
    });

    expect(sent).toContainEqual({ type: "user_question_resolved", questionId: "q1" });
    expect(mocks.acceptTaskMessage).not.toHaveBeenCalled();
  });

  it("retracts another member's prompt without answering or resuming it", async () => {
    const answer = pending({ ownerUserId: "someone-else" });
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-1", "q1", opts);

    expect(answer).not.toHaveBeenCalled();
    expect(mocks.acceptTaskMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: "user_question_resolved", questionId: "q1" }]);
    // Still answerable by its owner.
    expect(pendingUserQuestions.has("q1")).toBe(true);
  });

  it("does not cross-answer a prompt id registered against a different task", async () => {
    const answer = pending();
    const sent: unknown[] = [];

    await resolveUserQuestion((o) => sent.push(o), "u1", "w1", "c-other", "q1", opts);

    // c-1's prompt is untouched; the answer goes to the card the client named,
    // exactly as an ordinary follow-up message on that card would.
    expect(answer).not.toHaveBeenCalled();
    expect(pendingUserQuestions.has("q1")).toBe(true);
    expect(mocks.acceptTaskMessage).toHaveBeenCalledWith("w1", "c-other", "Option A");
    expect(sent).toContainEqual({ type: "user_question_resolved", questionId: "q1" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
