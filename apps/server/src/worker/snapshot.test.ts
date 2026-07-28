import { beforeEach, describe, expect, it, vi } from "vitest";
import { del, setJson } from "../redis.ts";
import { clearTaskSnapshot, flushSnapshotsNow, saveTaskSnapshot, type TaskSnapshot } from "./snapshot.ts";

vi.mock("../redis.ts", () => ({
  setJson: vi.fn(),
  getJson: vi.fn(),
  del: vi.fn(),
}));

const snap: TaskSnapshot = { assistantText: "hello", toolTrace: [], events: [] };

describe("task snapshots", () => {
  beforeEach(async () => {
    vi.mocked(setJson).mockResolvedValue(true);
    vi.mocked(del).mockResolvedValue(undefined);
    await flushSnapshotsNow();
    vi.clearAllMocks();
    vi.mocked(setJson).mockResolvedValue(true);
    vi.mocked(del).mockResolvedValue(undefined);
  });

  it("keeps a dirty snapshot queued when a Redis write fails", async () => {
    vi.mocked(setJson).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    saveTaskSnapshot("t-retry", snap);
    await flushSnapshotsNow();
    expect(setJson).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setJson).mock.calls.map(([key]) => key)).toEqual(["task:t-retry", "task:t-retry"]);

    await flushSnapshotsNow();
    expect(setJson).toHaveBeenCalledTimes(2);
  });

  it("does not re-queue a failed write after the snapshot is cleared", async () => {
    let finishWrite!: (ok: boolean) => void;
    vi.mocked(setJson).mockReturnValueOnce(new Promise<boolean>((resolve) => { finishWrite = resolve; }));

    saveTaskSnapshot("t-clear", snap);
    const flushing = flushSnapshotsNow();
    expect(setJson).toHaveBeenCalledTimes(1);

    clearTaskSnapshot("t-clear");
    finishWrite(false);
    await flushing;

    expect(del).toHaveBeenCalledWith("task:t-clear");
    await flushSnapshotsNow();
    expect(setJson).toHaveBeenCalledTimes(1);
  });
});
