import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointTaskAccum, handleRegisteredWorkerMessage } from "./workerMessages.ts";
import { taskAccums, taskEventBuffers, pendingUserQuestions } from "./state.ts";

const dbMocks = vi.hoisted(() => ({
  messagesAppend: vi.fn(async () => {}),
  tasksGet: vi.fn(),
  tasksSetWorker: vi.fn(async () => {}),
  tasksTransition: vi.fn(async () => ({})),
}));
const busMocks = vi.hoisted(() => ({ publish: vi.fn() }));
const registryMocks = vi.hoisted(() => ({
  claimTaskWorktrees: vi.fn(),
  freeTaskWorker: vi.fn(),
  markTaskActivity: vi.fn(),
}));
const lifecycleMocks = vi.hoisted(() => ({
  onTurnDone: vi.fn(),
  onWipCommitted: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({
  clearTaskSnapshot: vi.fn(),
  loadTaskSnapshot: vi.fn(async () => null as unknown),
  saveTaskSnapshot: vi.fn(),
}));
const questionMocks = vi.hoisted(() => ({
  acknowledgeQuestion: vi.fn(),
  completeQuestion: vi.fn(),
  failQuestion: vi.fn(),
  onQuestionEvent: vi.fn(),
  onQuestionUpdate: vi.fn(),
}));

vi.mock("@manta/db", () => ({
  messages: { append: dbMocks.messagesAppend },
  tasks: {
    get: dbMocks.tasksGet,
    setWorker: dbMocks.tasksSetWorker,
    transition: dbMocks.tasksTransition,
  },
}));
vi.mock("../bus.ts", () => ({
  bus: busMocks,
  chanTopic: (workspaceId: string, channel: string) => `chan:${workspaceId}:${channel}`,
  kanbanTopic: (workspaceId: string) => `kanban:${workspaceId}`,
}));
vi.mock("../logger.ts", () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock("../worker/registry.ts", () => registryMocks);
vi.mock("../worker/lifecycle.ts", () => lifecycleMocks);
vi.mock("../worker/snapshot.ts", () => snapshotMocks);
vi.mock("../worker/questions.ts", () => questionMocks);
vi.mock("../notices.ts", () => ({ noteOnCard: vi.fn() }));

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-bg",
    workspaceId: "w1",
    cardStatus: "bot_working",
    backgroundMode: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  taskAccums.clear();
  taskEventBuffers.clear();
  pendingUserQuestions.clear();
  dbMocks.tasksGet.mockResolvedValue(task());
  snapshotMocks.loadTaskSnapshot.mockResolvedValue(null);
});

describe("handleRegisteredWorkerMessage", () => {
  it("does not treat an unrecognized task packet as turn activity", async () => {
    await handleRegisteredWorkerMessage({
      msg: { type: "stale_task_packet", taskId: "c-bg", workspaceId: "w1" },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(registryMocks.markTaskActivity).not.toHaveBeenCalled();
  });

  it("marks completed background workers done when the turn finishes", async () => {
    dbMocks.tasksGet.mockResolvedValue(task({ backgroundMode: "linear_status_automation" }));

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.tasksTransition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      "done",
      "worker",
      { doneReason: "completed", reason: "Background worker run completed" },
    );
    expect(dbMocks.tasksSetWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      { workerActive: false, workerStatus: "done" },
    );
    expect(busMocks.publish).toHaveBeenCalledWith("kanban:w1", {});
  });

  it("does not overwrite normal worker status on a non-background done event", async () => {
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.tasksTransition).not.toHaveBeenCalled();
    expect(dbMocks.tasksSetWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      { workerActive: false },
    );
  });

  it("persists a text-only worker reply when the turn finishes", async () => {
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "text", text: "I checked this and it is already fixed." } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.messagesAppend).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      {
        channel: "c-bg",
        role: "assistant",
        content: "I checked this and it is already fixed.",
        meta: {
          tools: [],
          transcript: [{ type: "assistant", text: "I checked this and it is already fixed." }],
        },
      },
    );
  });

  it("checkpoints streamed output so a user follow-up can be persisted after it", async () => {
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "text", text: "First response" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    await expect(checkpointTaskAccum("w1", "c-bg")).resolves.toBe(true);

    expect(dbMocks.messagesAppend).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      {
        channel: "c-bg",
        role: "assistant",
        content: "First response",
        meta: {
          tools: [],
          transcript: [{ type: "assistant", text: "First response" }],
        },
      },
    );
    expect(taskEventBuffers.has("c-bg")).toBe(false);
    expect(taskAccums.get("c-bg")).toEqual({
      workspaceId: "w1",
      assistantText: "",
      toolTrace: [],
      transcript: [],
    });

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "text", text: "Second response" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.messagesAppend).toHaveBeenLastCalledWith(
      { workspaceId: "w1" },
      expect.objectContaining({ channel: "c-bg", role: "assistant", content: "Second response" }),
    );
  });

  it("checkpoints output recovered only from a restart snapshot", async () => {
    snapshotMocks.loadTaskSnapshot.mockResolvedValue({
      assistantText: "Recovered response",
      toolTrace: [],
      transcript: [{ type: "assistant", text: "Recovered response" }],
      events: [{ type: "text", text: "Recovered response" }],
    });

    await expect(checkpointTaskAccum("w1", "c-bg")).resolves.toBe(true);

    expect(dbMocks.messagesAppend).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      expect.objectContaining({ channel: "c-bg", role: "assistant", content: "Recovered response" }),
    );
    expect(snapshotMocks.clearTaskSnapshot).toHaveBeenCalledWith("c-bg");
  });

  it("persists the full worker transcript for follow-up turns on review cards", async () => {
    dbMocks.tasksGet.mockResolvedValue(task({ cardStatus: "pr_review" }));

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "thinking", text: "Checking context" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "tool_use", toolName: "read", argsPreview: '{"path":"x"}' } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "tool_result", ok: true, preview: "file contents" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "text", text: "Done." } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });
    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.messagesAppend).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      {
        channel: "c-bg",
        role: "assistant",
        content: "Done.",
        meta: {
          tools: [{ tool: "read", args: '{"path":"x"}' }],
          transcript: [
            { type: "thinking", text: "Checking context" },
            { type: "tool", tool: "read", args: '{"path":"x"}' },
            { type: "status", text: "Tool result: ok — file contents" },
            { type: "assistant", text: "Done." },
          ],
        },
      },
    );
  });

  it("does not mark background workers done for error terminators", async () => {
    dbMocks.tasksGet.mockResolvedValue(task({ backgroundMode: "linear_status_automation" }));

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "error" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.tasksTransition).not.toHaveBeenCalled();
    expect(dbMocks.tasksSetWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      { workerActive: false },
    );
  });

  it("does not mark background workers done for interrupted terminators", async () => {
    dbMocks.tasksGet.mockResolvedValue(task({ backgroundMode: "linear_status_automation" }));

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "interrupted" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.tasksTransition).not.toHaveBeenCalled();
    expect(dbMocks.tasksSetWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      { workerActive: false },
    );
  });

  it("moves background investigations from investigation-complete to done", async () => {
    dbMocks.tasksGet.mockResolvedValue(task({
      backgroundMode: "linear_status_automation",
      cardStatus: "investigation_complete",
    }));

    await handleRegisteredWorkerMessage({
      msg: { type: "worker_event", taskId: "c-bg", workspaceId: "w1", event: { type: "done", reason: "end_turn" } },
      send: vi.fn(),
      boundScope: null,
      workerId: "worker-1",
    });

    expect(dbMocks.tasksTransition).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      "done",
      "worker",
      { doneReason: "completed", reason: "Background worker run completed", force: true },
    );
    expect(dbMocks.tasksSetWorker).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      "c-bg",
      { workerActive: false, workerStatus: "done" },
    );
  });
});
