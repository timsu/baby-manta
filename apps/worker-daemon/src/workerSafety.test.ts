import { describe, expect, it } from "vitest";
import { WORKER_SAFETY_INSTRUCTIONS } from "./workerSafety.ts";

describe("worker safety instructions", () => {
  it("forbids unguarded force pushes without blocking force-with-lease", () => {
    const instructions = WORKER_SAFETY_INSTRUCTIONS.join(" ");

    expect(instructions).toContain("Never use an unguarded force push");
    expect(instructions).toContain("`git push --force`");
    expect(instructions).toContain("`git push -f`");
    expect(instructions).toContain("`git push --force-with-lease` is allowed");
    expect(instructions).toContain("after fetching and verifying the remote branch tip");
  });
});
