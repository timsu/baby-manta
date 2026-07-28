import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActiveTasks, registerWorker, unregisterWorker } from "./registry.ts";
import {
  cancelDisconnectGrace,
  handleDisconnectedActiveTask,
  handleWedgedTask,
  resolveDisconnectGrace,
} from "./disconnect.ts";
import { appendSandboxLog, clearSandboxLog } from "./sandboxLog.ts";
import { taskAccums } from "../ws/state.ts";

const dbMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  setWorker: vi.fn(async () => {}),
  transition: vi.fn(async () => {}),
  messagesAppend: vi.fn(async () => {}),
}));
const noteMocks = vi.hoisted(() => ({ noteOnCard: vi.fn(async () => {}) }));
const busMocks = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock("@manta/db", () => ({
  prisma: { task: { findUnique: dbMocks.taskFindUnique } },
  tasks: { setWorker: dbMocks.setWorker, transition: dbMocks.transition },
  messages: { append: dbMocks.messagesAppend },
}));
vi.mock("../bus.ts", () => ({ bus: busMocks, kanbanTopic: (id: string) => `kanban:${id}` }));
vi.mock("../notices.ts", () => ({ noteOnCard: noteMocks.noteOnCard }));
vi.mock("./payload.ts", () => ({ buildTaskPayload: vi.fn(async (task) => ({ id: task.id, title: task.title })) }));

const cleanup: string[] = [];

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-disconnect",
    workspaceId: "w1",
    cardStatus: "bot_working",
    createdBy: "owner-1",
    name: "disconnect-card",
    title: "Disconnect card",
    repo: "acme/app",
    workerBackend: "pi",
    worktreePath: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    prTitle: null,
    linearIssueIdentifier: null,
    sessionBlobKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.taskFindUnique.mockResolvedValue(task());
  // Most cases assert the terminal outcome; the grace window has its own describe.
  process.env["WORKER_DISCONNECT_GRACE_MS"] = "0";
});

afterEach(() => {
  while (cleanup.length) unregisterWorker(cleanup.pop()!);
  taskAccums.delete("c-disconnect");
  cancelDisconnectGrace("c-disconnect");
  delete process.env["WORKER_DISCONNECT_GRACE_MS"];
});

describe("handleDisconnectedActiveTask", () => {
  it("moves a bot_working card to Needs Help when no replacement worker exists", async () => {
    await expect(handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect")).resolves.toBe("needs_help");

    expect(dbMocks.setWorker).toHaveBeenCalledWith({ workspaceId: "w1" }, "c-disconnect", { workerActive: false });
    expect(dbMocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      "needs_help",
      "worker",
      { reason: "Worker disconnected" },
    );
    expect(noteMocks.noteOnCard).toHaveBeenCalled();
  });

  it("attaches the box's last output to the Needs Help note so the cause is visible", async () => {
    clearSandboxLog("c-disconnect");
    appendSandboxLog("c-disconnect", "Failed to load extension: getModels is not a function\n");
    try {
      await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
      const lastCall = noteMocks.noteOnCard.mock.calls.at(-1) as unknown[] | undefined;
      const note = String(lastCall?.[2] ?? "");
      expect(note).toContain("disconnected mid-task");
      expect(note).toContain("Last worker output");
      expect(note).toContain("getModels is not a function");
    } finally {
      clearSandboxLog("c-disconnect");
    }
  });

  it("keeps the card working when another worker is already active on the same task", async () => {
    registerWorker("replacement-active", "owner-1", () => {});
    cleanup.push("replacement-active");
    claimActiveTasks("replacement-active", ["c-disconnect"]);

    await expect(handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect")).resolves.toBe("kept_active");

    expect(dbMocks.setWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      { workerActive: true, workerStatus: "running" },
    );
    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });

  it("dispatches a replacement turn instead of moving to Needs Help when the owner has another worker", async () => {
    const sent: unknown[] = [];
    registerWorker("replacement-idle", "owner-1", (msg) => sent.push(msg));
    cleanup.push("replacement-idle");

    await expect(handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect")).resolves.toBe("replacement_dispatched");

    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "run_task", taskId: "c-disconnect", workspaceId: "w1" });
  });

  it("persists a streamed-but-uncommitted reply on disconnect, even for a non-bot_working card", async () => {
    // Follow-up on a Ready-To-Test card re-activates the worker but never moves it
    // to bot_working, so the disconnect handler returns "ignored" — but the reply
    // the worker already streamed must still survive a reload.
    dbMocks.taskFindUnique.mockResolvedValue(task({ cardStatus: "ready_to_test" }));
    taskAccums.set("c-disconnect", {
      workspaceId: "w1",
      assistantText: "Here is what I changed...",
      toolTrace: [{ tool: "bash", args: "git status" }],
      transcript: [{ type: "assistant", text: "Here is what I changed..." }],
    });

    await expect(handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect")).resolves.toBe("ignored");

    expect(dbMocks.messagesAppend).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      expect.objectContaining({ channel: "c-disconnect", role: "assistant", content: "Here is what I changed..." }),
    );
    // Accum is cleared so a racing done event can't double-persist it.
    expect(taskAccums.has("c-disconnect")).toBe(false);
  });

  it("restores the buffered reply when persistence fails, so it isn't lost permanently", async () => {
    dbMocks.taskFindUnique.mockResolvedValue(task({ cardStatus: "ready_to_test" }));
    dbMocks.messagesAppend.mockRejectedValueOnce(new Error("transient DB error"));
    const accum = {
      workspaceId: "w1",
      assistantText: "Partial reply...",
      toolTrace: [],
      transcript: [{ type: "assistant" as const, text: "Partial reply..." }],
    };
    taskAccums.set("c-disconnect", accum);

    // The disconnect handler swallows the flush error; the reply must survive in memory.
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");

    expect(dbMocks.messagesAppend).toHaveBeenCalled();
    expect(taskAccums.get("c-disconnect")).toBe(accum);
  });

  it("does not write an empty message when there is no buffered reply", async () => {
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
    expect(dbMocks.messagesAppend).not.toHaveBeenCalled();
  });

  it("ignores a disconnected worker that does not own the task", async () => {
    await expect(handleDisconnectedActiveTask("wrong-worker", "other-owner", "c-disconnect")).resolves.toBe("ignored");

    expect(dbMocks.setWorker).not.toHaveBeenCalled();
    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });
});

describe("disconnect grace window (deploy resilience)", () => {
  beforeEach(() => {
    process.env["WORKER_DISCONNECT_GRACE_MS"] = "60000";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the card instead of failing it while the worker may still reconnect", async () => {
    await expect(handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect")).resolves.toBe("grace_pending");

    // The card stays exactly as it was — a deploy must not look like a failure.
    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(dbMocks.setWorker).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });

  it("leaves the card alone when the worker reconnects still running the task", async () => {
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
    resolveDisconnectGrace("dead-worker", ["c-disconnect"]);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });

  it("fails the card immediately when the worker reconnects without claiming it", async () => {
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
    resolveDisconnectGrace("dead-worker", ["some-other-task"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(dbMocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      "needs_help",
      "worker",
      { reason: "Worker disconnected" },
    );
  });

  it("fails the card once the window elapses with no reconnect", async () => {
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
    expect(dbMocks.transition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(dbMocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      "needs_help",
      "worker",
      { reason: "Worker disconnected" },
    );
    const note = String((noteMocks.noteOnCard.mock.calls.at(-1) as unknown[] | undefined)?.[2] ?? "");
    expect(note).toContain("did not come back");
  });

  it("does not fail a card that finished while the window was open", async () => {
    await handleDisconnectedActiveTask("dead-worker", "owner-1", "c-disconnect");
    dbMocks.taskFindUnique.mockResolvedValue(task({ cardStatus: "ready_to_test" }));

    await vi.advanceTimersByTimeAsync(60_001);

    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });
});

describe("handleWedgedTask", () => {
  it("moves a bot_working card to Needs Help with a wedge note", async () => {
    await handleWedgedTask("c-disconnect", "wedged-worker");

    expect(dbMocks.setWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      { workerActive: false, workerStatus: "stalled" },
    );
    expect(dbMocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-disconnect",
      "needs_help",
      "worker",
      { reason: "Worker acked but produced no output" },
    );
    const lastCall = noteMocks.noteOnCard.mock.calls.at(-1) as unknown[] | undefined;
    const note = String(lastCall?.[2] ?? "");
    expect(note).toContain("produced no output");
    expect(note).toContain("Retry Worker");
  });

  it("does nothing for a card that is no longer bot_working", async () => {
    dbMocks.taskFindUnique.mockResolvedValue(task({ cardStatus: "done" }));

    await handleWedgedTask("c-disconnect", "wedged-worker");

    expect(dbMocks.transition).not.toHaveBeenCalled();
    expect(noteMocks.noteOnCard).not.toHaveBeenCalled();
  });
});
