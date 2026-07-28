import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Isolate the lifecycle module from the DB, Daytona, bus, and config so we test
// only the grace-timer state machine. cloud.ts in particular pulls in the Daytona
// SDK via the sandbox factory — mock it out entirely.
vi.mock("@manta/db", () => ({ tasks: { setWorker: vi.fn(async () => {}) } }));
vi.mock("../bus.ts", () => ({ bus: { publish: vi.fn() }, kanbanTopic: (id: string) => `kanban:${id}` }));
vi.mock("./cloud.ts", () => ({ stopCloudSandbox: vi.fn(async () => {}) }));
vi.mock("./registry.ts", () => ({ forwardToTaskWorker: vi.fn(() => true) }));
vi.mock("../config.ts", () => ({ config: { sandboxGraceMinutes: () => 10 } }));

import { onTurnStart, onTurnDone, cancelSpindown, onWipCommitted } from "./lifecycle.ts";
import { stopCloudSandbox } from "./cloud.ts";
import { forwardToTaskWorker } from "./registry.ts";

const GRACE_MS = 10 * 60_000;

describe("sandbox lifecycle grace timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("after a turn, commits WIP then stops the box once the grace window elapses", async () => {
    const task = { id: "t-stop", workspaceId: "w1" };
    onTurnDone(task);
    expect(stopCloudSandbox).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(GRACE_MS); // fires spindown → asks for WIP commit
    expect(forwardToTaskWorker).toHaveBeenCalledWith("t-stop", expect.objectContaining({ type: "commit_wip" }));
    expect(stopCloudSandbox).not.toHaveBeenCalled(); // still awaiting the commit ack

    await vi.advanceTimersByTimeAsync(15_000); // ack times out → proceed to stop
    expect(stopCloudSandbox).toHaveBeenCalledWith(task);
  });

  it("a WIP ack short-circuits the commit wait so the box stops promptly", async () => {
    const task = { id: "t-ack", workspaceId: "w1" };
    onTurnDone(task);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    onWipCommitted("t-ack"); // daemon reports the commit landed
    await vi.advanceTimersByTimeAsync(0);
    expect(stopCloudSandbox).toHaveBeenCalledWith(task);
  });

  it("a turn arriving during the commit_wip wait aborts the stop (no race)", async () => {
    const task = { id: "t-race", workspaceId: "w1" };
    onTurnDone(task);
    await vi.advanceTimersByTimeAsync(GRACE_MS); // spindown fires, asks for WIP commit, awaits ack
    expect(forwardToTaskWorker).toHaveBeenCalledWith("t-race", expect.objectContaining({ type: "commit_wip" }));
    onTurnStart(task); // a follow-up turn arrives mid-commit → cancels the in-flight spindown
    await vi.advanceTimersByTimeAsync(15_000); // ack times out and spindown resumes…
    expect(stopCloudSandbox).not.toHaveBeenCalled(); // …but must not stop the now-active box
  });

  it("a new turn cancels the scheduled spindown", async () => {
    const task = { id: "t-resume", workspaceId: "w1" };
    onTurnDone(task);
    onTurnStart(task); // follow-up arrived while warm
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(stopCloudSandbox).not.toHaveBeenCalled();
  });

  it("cancelSpindown (disconnect / manual stop) cancels the timer", async () => {
    const task = { id: "t-cancel", workspaceId: "w1" };
    onTurnDone(task);
    cancelSpindown("t-cancel");
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(stopCloudSandbox).not.toHaveBeenCalled();
  });
});
