import { describe, expect, it, vi } from "vitest";
import { withTaskTranscriptLock } from "./taskTranscriptLock.ts";

describe("withTaskTranscriptLock", () => {
  it("serializes transcript mutations for the same task", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];

    const first = withTaskTranscriptLock("task-1", async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const secondAction = vi.fn(async () => { order.push("second"); });
    const second = withTaskTranscriptLock("task-1", secondAction);

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    expect(secondAction).not.toHaveBeenCalled();

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not block mutations for different tasks", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withTaskTranscriptLock("task-1", () => firstBlocked);
    const secondAction = vi.fn(async () => {});

    await withTaskTranscriptLock("task-2", secondAction);

    expect(secondAction).toHaveBeenCalledOnce();
    releaseFirst();
    await first;
  });
});
