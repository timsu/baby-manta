import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptTaskMessage } from "./taskMessages.ts";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  append: vi.fn(async () => {}),
  transition: vi.fn(),
  setWorker: vi.fn(async () => {}),
  normalize: vi.fn(),
  buildPayload: vi.fn(),
  buildLaptopPayload: vi.fn(),
  startWorker: vi.fn(async () => true),
  forward: vi.fn(),
  publish: vi.fn(),
  note: vi.fn(async () => {}),
  checkpoint: vi.fn(async () => false),
  withTranscriptLock: vi.fn(async (_taskId: string, action: () => Promise<unknown>) => action()),
}));

vi.mock("@manta/db", () => ({
  messages: { append: mocks.append },
  tasks: { get: mocks.get, transition: mocks.transition, setWorker: mocks.setWorker },
}));
vi.mock("../bus.ts", () => ({ bus: { publish: mocks.publish }, kanbanTopic: (id: string) => `kanban:${id}` }));
vi.mock("../logger.ts", () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock("../notices.ts", () => ({ noteOnCard: mocks.note }));
vi.mock("../ws/workerMessages.ts", () => ({ checkpointTaskAccum: mocks.checkpoint }));
vi.mock("./taskTranscriptLock.ts", () => ({ withTaskTranscriptLock: mocks.withTranscriptLock }));
vi.mock("../repos/canonical.ts", () => ({ normalizeTaskRepoForDispatch: mocks.normalize }));
vi.mock("./dispatch.ts", () => ({ buildLaptopRunTaskPayload: mocks.buildLaptopPayload, startWorkerForTask: mocks.startWorker }));
vi.mock("./lifecycle.ts", () => ({ onTurnStart: vi.fn(), cancelSpindown: vi.fn() }));
vi.mock("./payload.ts", () => ({ buildTaskPayload: mocks.buildPayload }));
vi.mock("./registry.ts", () => ({
  forwardToTaskWorker: mocks.forward,
  isExternalTask: vi.fn(() => true),
}));

function task() {
  return {
    id: "c-1",
    workspaceId: "w-1",
    cardStatus: "bot_working",
    workerVenue: "laptop",
    createdBy: "u-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const value = task();
  mocks.get.mockResolvedValue(value);
  mocks.normalize.mockResolvedValue(value);
  mocks.transition.mockResolvedValue(value);
  mocks.buildPayload.mockResolvedValue({ id: value.id });
  mocks.buildLaptopPayload.mockResolvedValue({ type: "run_task", taskId: value.id });
  mocks.forward.mockReturnValue(true);
  mocks.checkpoint.mockResolvedValue(false);
});

describe("acceptTaskMessage", () => {
  it("durably appends before dispatching the worker turn", async () => {
    const result = await acceptTaskMessage("w-1", "c-1", "please continue");

    expect(result?.task.id).toBe("c-1");
    expect(result?.dispatched).toBe(true);
    expect(mocks.append).toHaveBeenCalledWith(
      { workspaceId: "w-1" },
      { channel: "c-1", role: "user", content: "please continue" },
    );
    await vi.waitFor(() => expect(mocks.forward).toHaveBeenCalledOnce());
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(mocks.forward.mock.invocationCallOrder[0]!);
  });

  it("checkpoints streamed assistant output before appending a mid-turn follow-up", async () => {
    mocks.checkpoint.mockImplementationOnce(async () => true);

    await acceptTaskMessage("w-1", "c-1", "answer this next");

    expect(mocks.checkpoint).toHaveBeenCalledWith("w-1", "c-1");
    expect(mocks.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(mocks.append.mock.invocationCallOrder[0]!);
  });

  it("keeps the accepted message and surfaces a dispatch failure", async () => {
    mocks.buildPayload.mockRejectedValue(new Error("payload unavailable"));

    await expect(acceptTaskMessage("w-1", "c-1", "do not lose this")).resolves.toMatchObject({ task: { id: "c-1" }, dispatched: false });

    expect(mocks.note).toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.setWorker).toHaveBeenCalledWith(
      { workspaceId: "w-1" },
      "c-1",
      { workerActive: false, workerStatus: "failed" },
    );
    expect(mocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w-1" },
      "c-1",
      "needs_help",
      "worker",
      { reason: "Worker failed to start" },
    );
  });

  it("starts a replacement turn when the holding worker disconnects during dispatch", async () => {
    mocks.forward.mockReturnValue(false);

    const result = await acceptTaskMessage("w-1", "c-1", "retry elsewhere");

    expect(result?.dispatched).toBe(true);
    expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({ id: "c-1" }), "retry elsewhere", { messageAlreadyPersisted: true });
  });

  it.each(["ready_to_test", "pr_review", "done"] as const)("reactivates a finished %s card before acknowledging the follow-up", async (cardStatus) => {
    const finished = { ...task(), cardStatus };
    mocks.get.mockResolvedValue(finished);
    mocks.normalize.mockResolvedValue(finished);
    mocks.transition.mockResolvedValue({ ...finished, cardStatus: "bot_working" });
    mocks.forward.mockReturnValue(false);

    const result = await acceptTaskMessage("w-1", "c-1", "please address this");

    expect(mocks.transition).toHaveBeenCalledWith(
      { workspaceId: "w-1" }, "c-1", "bot_working", "human", { reason: "User sent follow-up" },
    );
    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ cardStatus: "bot_working" }), "please address this", { messageAlreadyPersisted: true },
    );
    expect(result).toMatchObject({ dispatched: true, task: { cardStatus: "bot_working" } });
  });

  it("does not acknowledge a follow-up when no replacement worker turn was claimed", async () => {
    mocks.forward.mockReturnValue(false);
    mocks.startWorker.mockResolvedValue(false);

    await expect(acceptTaskMessage("w-1", "c-1", "try again")).resolves.toMatchObject({ dispatched: false });
    expect(mocks.append).toHaveBeenCalledOnce();
  });

  it("rejects a Brain follow-up while a worker is active instead of forwarding it", async () => {
    mocks.get.mockResolvedValue({ ...task(), workerActive: true });

    await expect(acceptTaskMessage("w-1", "c-1", "do not overlap", "brain", { requireIdle: true }))
      .resolves.toMatchObject({ dispatched: false });

    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("persists a concurrent finished-card follow-up after another request reactivates it", async () => {
    const finished = { ...task(), cardStatus: "ready_to_test" };
    const reactivated = { ...task(), cardStatus: "bot_working" };
    mocks.get.mockResolvedValueOnce(finished).mockResolvedValueOnce(reactivated);
    mocks.normalize.mockResolvedValue(finished);
    mocks.transition.mockRejectedValueOnce(new Error("already reactivated"));
    mocks.forward.mockReturnValue(false);

    await expect(acceptTaskMessage("w-1", "c-1", "second follow-up")).resolves.toMatchObject({
      task: { cardStatus: "bot_working" }, dispatched: true,
    });
    expect(mocks.append).toHaveBeenCalledWith(
      { workspaceId: "w-1" }, { channel: "c-1", role: "user", content: "second follow-up" },
    );
  });
});
