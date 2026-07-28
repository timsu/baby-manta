import { describe, expect, it } from "vitest";

import { isBranchAlreadyCheckedOutError } from "./worktreeGit.ts";

describe("isBranchAlreadyCheckedOutError", () => {
  it.each([
    "fatal: 'feature' is already checked out at '/tmp/first'",
    "fatal: 'feature' is already used by worktree at '/tmp/first'",
  ])("recognizes a checked-out branch conflict: %s", (stderr) => {
    const error = Object.assign(new Error("Command failed: git worktree add"), { stderr });
    expect(isBranchAlreadyCheckedOutError(error)).toBe(true);
  });

  it("does not classify unrelated worktree failures as branch conflicts", () => {
    const error = Object.assign(new Error("Command failed: git worktree add"), {
      stderr: "fatal: invalid reference: missing-branch",
    });
    expect(isBranchAlreadyCheckedOutError(error)).toBe(false);
  });
});
