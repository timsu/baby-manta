import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableWorkerCount, registerWorker, unregisterWorker } from "./registry.ts";
import { acknowledgeQuestion, askWorkerQuestion, authorizeRepoChatToolGrant, completeQuestion, failAllQuestions, onQuestionEvent } from "./questions.ts";

const dbMocks = vi.hoisted(() => ({
  membershipFindMany: vi.fn(),
}));

vi.mock("@manta/db", () => ({
  prisma: {
    membership: {
      findMany: dbMocks.membershipFindMany,
    },
  },
}));

// askWorkerQuestion resolves vended credentials (getTaskAuthBlob) before dispatch;
// stub it so these tests stay focused on dispatch/ack/timeout behavior.
vi.mock("../models/service.ts", () => ({
  getTaskAuthBlob: vi.fn().mockResolvedValue(null),
  getRepoChatAuthBlob: vi.fn().mockResolvedValue(null),
}));

const cleanup: string[] = [];

// Credential resolution adds async hops before the run_question frame is sent, so
// flush several microtasks (not just one) before inspecting the dispatched frame.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  dbMocks.membershipFindMany.mockReset();
});

afterEach(() => {
  failAllQuestions("test cleanup");
  vi.useRealTimers();
  while (cleanup.length) unregisterWorker(cleanup.pop()!);
});

describe("askWorkerQuestion", () => {
  it("returns an error if membership lookup fails", async () => {
    dbMocks.membershipFindMany.mockRejectedValue(new Error("database unavailable"));

    await expect(askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    })).resolves.toEqual({ ok: false, reason: "error", message: "database unavailable" });
  });

  it("returns an error and releases the worker if dispatch send throws", async () => {
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }]);
    registerWorker("w-throw", "alice", () => { throw new Error("socket closed"); }, { caps: ["run_question"] });
    cleanup.push("w-throw");

    await expect(askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    })).resolves.toEqual({ ok: false, reason: "error", message: "socket closed" });

    expect(availableWorkerCount("alice")).toBe(1);
  });

  it("resolves when the worker completes the question", async () => {
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }]);
    let sent: { questionId?: string } | undefined;
    registerWorker("w-complete", "alice", (msg) => { sent = msg as { questionId?: string }; }, { caps: ["run_question"] });
    cleanup.push("w-complete");

    const result = askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    });
    await flush();
    expect(sent?.questionId).toBeTruthy();

    completeQuestion(sent!.questionId!, "It uses a queue.");

    await expect(result).resolves.toEqual({ ok: true, answer: "It uses a queue." });
    expect(availableWorkerCount("alice")).toBe(1);
  });

  it("pins repo chat to the requesting user's worker and streams events", async () => {
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }, { userId: "bob" }]);
    const aliceSend = vi.fn();
    let bobMessage: { questionId?: string; workspaceToolToken?: string } | undefined;
    registerWorker("w-alice", "alice", aliceSend, { caps: ["run_question", "repo_chat"] });
    registerWorker("w-bob", "bob", (msg) => { bobMessage = msg as { questionId?: string; workspaceToolToken?: string }; }, { caps: ["run_question", "repo_chat"] });
    cleanup.push("w-alice", "w-bob");
    const onEvent = vi.fn();

    const result = askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
      ownerUserId: "bob",
    }, undefined, onEvent);
    await flush();

    expect(aliceSend).not.toHaveBeenCalled();
    expect(bobMessage?.questionId).toBeTruthy();
    expect(authorizeRepoChatToolGrant(bobMessage!.workspaceToolToken!, "workspace-1", "bob")).toBe(true);
    expect(authorizeRepoChatToolGrant(bobMessage!.workspaceToolToken!, "workspace-1", "alice")).toBe(false);
    onQuestionEvent(bobMessage!.questionId!, { type: "text", text: "From Bob's checkout." });
    completeQuestion(bobMessage!.questionId!);

    await expect(result).resolves.toEqual({ ok: true, answer: "From Bob's checkout." });
    expect(onEvent).toHaveBeenCalledWith({ type: "text", text: "From Bob's checkout." });
    expect(authorizeRepoChatToolGrant(bobMessage!.workspaceToolToken!, "workspace-1", "bob")).toBe(false);
  });

  it("fails quickly if the selected worker never acknowledges the question", async () => {
    vi.useFakeTimers();
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }]);
    registerWorker("w-no-ack", "alice", () => {}, { caps: ["run_question"] });
    cleanup.push("w-no-ack");

    const result = askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    });
    await flush();

    await vi.advanceTimersByTimeAsync(4_999);
    await expect(Promise.race([result, Promise.resolve("pending")])).resolves.toBe("pending");

    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ ok: false, reason: "timeout", message: "worker did not acknowledge within 5s" });
    expect(availableWorkerCount("alice")).toBe(1);
  });

  it("keeps waiting for the answer after the worker acknowledges", async () => {
    vi.useFakeTimers();
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }]);
    let sent: { questionId?: string } | undefined;
    registerWorker("w-ack", "alice", (msg) => { sent = msg as { questionId?: string }; }, { caps: ["run_question"] });
    cleanup.push("w-ack");

    const result = askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    });
    await flush();
    acknowledgeQuestion(sent!.questionId!);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(Promise.race([result, Promise.resolve("pending")])).resolves.toBe("pending");

    completeQuestion(sent!.questionId!, "It uses a queue.");

    await expect(result).resolves.toEqual({ ok: true, answer: "It uses a queue." });
    expect(availableWorkerCount("alice")).toBe(1);
  });

  it("fails pending questions during server shutdown instead of waiting for the long timeout", async () => {
    dbMocks.membershipFindMany.mockResolvedValue([{ userId: "alice" }]);
    registerWorker("w-shutdown", "alice", () => {}, { caps: ["run_question"] });
    cleanup.push("w-shutdown");

    const result = askWorkerQuestion({
      workspaceId: "workspace-1",
      repo: "acme/project",
      question: "How does this work?",
      backendId: "pi",
    });
    await flush();

    failAllQuestions("server is restarting");

    await expect(result).resolves.toEqual({ ok: false, reason: "error", message: "server is restarting" });
    expect(availableWorkerCount("alice")).toBe(1);
  });
});
