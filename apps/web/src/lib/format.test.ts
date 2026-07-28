import { describe, expect, it } from "vitest";
import { shortTaskId, taskDisplayId } from "./format.ts";

describe("task ID formatting", () => {
  it("shows the c- prefix and first six random characters", () => {
    expect(shortTaskId("c-95dbe6202955")).toBe("c-95dbe6");
  });

  it("does not pad short IDs", () => {
    expect(shortTaskId("c-123")).toBe("c-123");
  });

  it("uses the shortened ID when a task has no display number", () => {
    expect(taskDisplayId({ repo: "acme/manta", taskNumber: null, id: "c-95dbe6202955" })).toBe("c-95dbe6");
  });
});
