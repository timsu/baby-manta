import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerWorker,
  unregisterWorker,
  listWorkers,
  dispatchTask,
  disposeTaskWorker,
  freeTaskWorker,
  isExternalTask,
  forwardToTaskWorker,
  availableWorkerCount,
  availableQuestionWorkerCount,
  claimWorkerForQuestion,
  releaseQuestionWorker,
  claimActiveTasks,
  ownerHasPresentWorker,
  holdDispatch,
  drainHeldDispatches,
  claimTaskWorktrees,
  reconnectTaskHome,
  getTaskWorkerSend,
  ownerWorkerPresenceStatus,
  ackDispatch,
  setOnWorkerWedged,
} from "./registry.ts";

// The registry is module-level singleton state; clean up workers between tests.
const cleanup: string[] = [];
beforeEach(() => {
  while (cleanup.length) unregisterWorker(cleanup.pop()!);
});

function register(workerId: string, ownerUserId: string, opts?: { boundTaskId?: string; caps?: string[] }) {
  registerWorker(workerId, ownerUserId, () => {}, opts);
  cleanup.push(workerId);
}

describe("worker registry", () => {
  it("counts only repo-chat-capable workers for repo chat availability", () => {
    register("old-question-worker", "user-A", { caps: ["run_question"] });
    register("repo-chat-worker", "user-A", { caps: ["run_question", "repo_chat"] });
    register("other-user-worker", "user-B", { caps: ["run_question", "repo_chat"] });

    expect(availableQuestionWorkerCount("user-A")).toBe(1);
    expect(availableQuestionWorkerCount("user-B")).toBe(1);
    expect(availableQuestionWorkerCount("user-C")).toBe(0);
  });

  it("does not arm a liveness watchdog for an unsolicited dispatch ack", async () => {
    vi.useFakeTimers();
    try {
      const onWedged = vi.fn();
      setOnWorkerWedged(onWedged);

      ackDispatch("no-pending-dispatch");
      await vi.advanceTimersByTimeAsync(120_000);

      expect(onWedged).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches multiple tasks to one connected laptop daemon", () => {
    const sent: Array<{ type: "run_task"; taskId: string }> = [];
    registerWorker("laptop-multi", "user-A", (msg) => sent.push(msg as { type: "run_task"; taskId: string }));
    cleanup.push("laptop-multi");

    expect(availableWorkerCount("user-A")).toBe(1);
    expect(dispatchTask({ type: "run_task", taskId: "t1" }, "user-A")).toBe("laptop-multi");
    expect(availableWorkerCount("user-A")).toBe(1);
    expect(dispatchTask({ type: "run_task", taskId: "t2" }, "user-A")).toBe("laptop-multi");

    expect(sent.map((msg) => msg.taskId)).toEqual(["t1", "t2"]);
    expect(isExternalTask("t1")).toBe(true);
    expect(isExternalTask("t2")).toBe(true);
    expect(listWorkers().find((w) => w.workerId === "laptop-multi")).toMatchObject({
      activeTaskCount: 2,
      activeTaskIds: ["t1", "t2"],
      currentTaskId: "t1",
      idle: false,
    });

    freeTaskWorker("t1");
    expect(isExternalTask("t1")).toBe(false);
    expect(isExternalTask("t2")).toBe(true);
    expect(availableWorkerCount("user-A")).toBe(1);
  });

  it("never owner-routes another task to a sandbox worker", () => {
    register("sandbox-1", "sandbox:t9", { boundTaskId: "t9" });
    // A bound sandbox worker is sticky, so it's never counted/dispatched for owner routing.
    expect(availableWorkerCount("sandbox:t9")).toBe(0);
    expect(dispatchTask({ type: "run_task", taskId: "t-other" }, "sandbox:t9")).toBeNull();
  });

  it("keeps a sandbox worker bound across turns (sticky)", () => {
    let delivered = 0;
    registerWorker("sandbox-2", "sandbox:t2", () => { delivered++; }, { boundTaskId: "t2" });
    cleanup.push("sandbox-2");

    expect(isExternalTask("t2")).toBe(true);

    // A completed turn frees laptop workers — but a sandbox stays bound so
    // follow-up turns keep routing to it.
    freeTaskWorker("t2");
    expect(isExternalTask("t2")).toBe(true);
    expect(forwardToTaskWorker("t2", { type: "run_task" })).toBe(true);
    expect(delivered).toBe(1);

    // Only disconnect unbinds it.
    expect(unregisterWorker("sandbox-2")).toEqual(["t2"]);
    cleanup.pop();
    expect(isExternalTask("t2")).toBe(false);
  });

  it("keeps terminal routing to a laptop worktree after the turn is freed", () => {
    const sent: unknown[] = [];
    registerWorker("laptop-terminal", "user-T", (msg) => sent.push(msg));
    cleanup.push("laptop-terminal");

    expect(dispatchTask({ type: "run_task", taskId: "t-terminal" }, "user-T")).toBe("laptop-terminal");
    freeTaskWorker("t-terminal");

    expect(isExternalTask("t-terminal")).toBe(false);
    expect(getTaskWorkerSend("t-terminal")).not.toBeNull();
    getTaskWorkerSend("t-terminal")?.({ type: "terminal_open", taskId: "t-terminal" });
    expect(sent.at(-1)).toMatchObject({ type: "terminal_open", taskId: "t-terminal" });
  });

  it("disposes active turns and terminal routing for a terminal task", () => {
    const sent: unknown[] = [];
    registerWorker("laptop-dispose", "user-D", (msg) => sent.push(msg));
    cleanup.push("laptop-dispose");

    expect(dispatchTask({ type: "run_task", taskId: "t-dispose" }, "user-D")).toBe("laptop-dispose");
    freeTaskWorker("t-dispose");
    expect(getTaskWorkerSend("t-dispose")).not.toBeNull();

    disposeTaskWorker("t-dispose");

    expect(sent).toContainEqual({ type: "dispose_task", taskId: "t-dispose" });
    expect(isExternalTask("t-dispose")).toBe(false);
    expect(getTaskWorkerSend("t-dispose")).toBeNull();
    expect(listWorkers().find((w) => w.workerId === "laptop-dispose")?.activeTaskIds).toEqual([]);
  });

  it("rebuilds terminal routing from a worker worktree claim", () => {
    const sent: unknown[] = [];
    registerWorker("laptop-claim", "user-C", (msg) => sent.push(msg));
    cleanup.push("laptop-claim");

    expect(getTaskWorkerSend("t-claimed")).toBeNull();
    claimTaskWorktrees("laptop-claim", ["t-claimed"]);

    getTaskWorkerSend("t-claimed")?.({ type: "terminal_open", taskId: "t-claimed" });
    expect(sent.at(-1)).toMatchObject({ type: "terminal_open", taskId: "t-claimed" });
  });

  it("reconnects terminal routing to an owner's live laptop worker", () => {
    const sent: unknown[] = [];
    registerWorker("laptop-reconnect", "user-R", (msg) => sent.push(msg));
    cleanup.push("laptop-reconnect");

    expect(getTaskWorkerSend("t-reconnect")).toBeNull();
    expect(reconnectTaskHome("t-reconnect", "user-R")).toBe(true);
    getTaskWorkerSend("t-reconnect")?.({ type: "terminal_open", taskId: "t-reconnect" });
    expect(sent.at(-1)).toMatchObject({ type: "terminal_open", taskId: "t-reconnect" });
    expect(reconnectTaskHome("t-other", "missing-user")).toBe(false);
  });
});

describe("deploy-resilience routing", () => {
  it("rebuilds in-flight task routing when a worker reconnects (claimActiveTasks)", () => {
    const sent: Array<{ taskId: string }> = [];
    registerWorker("laptop-rc", "user-RC", (m) => sent.push(m as { taskId: string }));
    // Reconnect after a deploy: the daemon advertises a turn it's still running.
    claimActiveTasks("laptop-rc", ["t-inflight"]);
    // Follow-ups now route here, and the task counts as active.
    expect(isExternalTask("t-inflight")).toBe(true);
    expect(forwardToTaskWorker("t-inflight", { type: "run_task", taskId: "t-inflight" })).toBe(true);
    expect(sent.at(-1)).toMatchObject({ taskId: "t-inflight" });
    // A *later* real disconnect still surfaces it so the task can be flagged.
    expect(unregisterWorker("laptop-rc")).toEqual(["t-inflight"]);
  });

  it("ownerHasPresentWorker is true for a live worker, false otherwise (no redis)", async () => {
    register("w-present", "owner-P");
    expect(await ownerHasPresentWorker("owner-P")).toBe(true);
    expect(await ownerHasPresentWorker("owner-absent")).toBe(false);
    expect(await ownerWorkerPresenceStatus("owner-P")).toBe("online");
    expect(await ownerWorkerPresenceStatus("owner-absent")).toBe("offline");
    expect(await ownerWorkerPresenceStatus(null)).toBe("offline");
  });

  it("a worker answering a question is still present and available (questions are concurrent)", async () => {
    register("w-question", "owner-Q", { caps: ["run_question"] });
    expect(claimWorkerForQuestion("q-live", (uid) => uid === "owner-Q")?.workerId).toBe("w-question");
    // Questions don't occupy the daemon for task purposes.
    expect(availableWorkerCount("owner-Q")).toBe(1);
    expect(await ownerHasPresentWorker("owner-Q")).toBe(true);
  });

  it("holds a dispatch and drains it to the worker that reconnects", () => {
    let fellBack = false;
    holdDispatch("owner-H", { type: "run_task", taskId: "t-held" }, () => { fellBack = true; });
    // Worker reconnects within the window.
    const sent: Array<{ taskId: string }> = [];
    registerWorker("laptop-h", "owner-H", (m) => sent.push(m as { taskId: string }));
    cleanup.push("laptop-h");
    drainHeldDispatches("owner-H");
    expect(sent.map((m) => m.taskId)).toContain("t-held");
    expect(fellBack).toBe(false);
  });

  it("falls back to cloud once the owner has no present worker", async () => {
    vi.useFakeTimers();
    try {
      let fellBack = false;
      // No live worker and no presence cache → the first re-check tick gives up to cloud.
      holdDispatch("owner-T", { type: "run_task", taskId: "t-timeout" }, () => { fellBack = true; });
      expect(fellBack).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fellBack).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps holding (no cloud fallback) while the owner's worker is still present", async () => {
    vi.useFakeTimers();
    try {
      let fellBack = false;
      // A transient blip: presence still says the worker is around (here, a live
      // entry) — it just hasn't re-registered to drain the queue yet. The hold must
      // extend across ticks rather than bounce the card to cloud at 30s, since a
      // reconnect backoff alone can outlast a single tick.
      register("w-blip", "owner-B");
      holdDispatch("owner-B", { type: "run_task", taskId: "t-blip" }, () => { fellBack = true; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fellBack).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fellBack).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claimWorkerForQuestion", () => {
  it("claims a capable worker and allows concurrent questions", () => {
    register("w1", "alice", { caps: ["run_question"] });
    expect(claimWorkerForQuestion("q1", (uid) => uid === "alice")?.workerId).toBe("w1");
    // Answering, so not "idle" for display — but still available for tasks.
    expect(listWorkers().find((w) => w.workerId === "w1")?.idle).toBe(false);
    expect(availableWorkerCount("alice")).toBe(1);
    // A second concurrent question lands on the same worker — no one-at-a-time limit.
    expect(claimWorkerForQuestion("q2", () => true)?.workerId).toBe("w1");
    // Releasing both returns it to idle.
    releaseQuestionWorker("q1");
    releaseQuestionWorker("q2");
    expect(listWorkers().find((w) => w.workerId === "w1")?.idle).toBe(true);
  });

  it("routes to ANY eligible member's worker, not just one owner", () => {
    register("w1", "alice", { caps: ["run_question"] });
    register("w2", "bob", { caps: ["run_question"] });
    // Asker is neither alice nor bob, but both are workspace members → bob's worker is fair game.
    const claimed = claimWorkerForQuestion("q1", (uid) => uid === "bob");
    expect(claimed?.workerId).toBe("w2");
  });

  it("answers a question even while the daemon is running tasks", () => {
    register("w1", "alice", { caps: ["run_question"] });
    dispatchTask({ type: "run_task", taskId: "t1" }, "alice");
    dispatchTask({ type: "run_task", taskId: "t2" }, "alice");
    // A read-only question runs alongside active tasks — not blocked by them.
    expect(claimWorkerForQuestion("q1", (uid) => uid === "alice")?.workerId).toBe("w1");
  });

  it("skips workers without the run_question capability", () => {
    register("w1", "alice"); // old daemon: no caps
    expect(claimWorkerForQuestion("q1", () => true)).toBeNull();
  });

  it("skips workers whose owner isn't eligible", () => {
    register("w1", "alice", { caps: ["run_question"] });
    expect(claimWorkerForQuestion("q1", (uid) => uid === "someone-else")).toBeNull();
  });
});
