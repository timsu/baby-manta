import { describe, expect, it } from "vitest";

import {
  resolveProvisionTarget,
  taskIdCandidatesFromWorktreeName,
  worktreeDirSlug,
} from "./worktreeOwnership.ts";

const ROOT = "/home/u/.manta/worktrees";

describe("resolveProvisionTarget", () => {
  const base = {
    root: ROOT,
    name: "fix-crm-bug",
    taskId: "c-6e7fc8",
    baseBranch: "manta/fix-crm-bug-c-6e7fc8",
    makeSuffix: () => "abcd12",
  };

  it("provisions the canonical path when no dir exists yet", () => {
    const t = resolveProvisionTarget({ ...base, dirExists: false, owner: undefined });
    expect(t).toEqual({
      worktree: `${ROOT}/fix-crm-bug-c-6e7fc8`,
      branch: "manta/fix-crm-bug-c-6e7fc8",
      reuse: false,
    });
  });

  it("reuses an existing dir this task owns", () => {
    const t = resolveProvisionTarget({ ...base, dirExists: true, owner: "c-6e7fc8" });
    expect(t.reuse).toBe(true);
    expect(t.worktree).toBe(`${ROOT}/fix-crm-bug-c-6e7fc8`);
    expect(t.branch).toBe("manta/fix-crm-bug-c-6e7fc8");
  });

  it("reuses an existing unowned dir (pre-stamping, by construction our own path)", () => {
    const t = resolveProvisionTarget({ ...base, dirExists: true, owner: undefined });
    expect(t.reuse).toBe(true);
    expect(t.worktree).toBe(`${ROOT}/fix-crm-bug-c-6e7fc8`);
  });

  it("diverts to a fresh path AND branch when the dir is owned by another task", () => {
    const t = resolveProvisionTarget({ ...base, dirExists: true, owner: "c-deadbe" });
    expect(t.reuse).toBe(false);
    // unique path and branch so the two cards never share a checkout
    expect(t.worktree).toBe(`${ROOT}/fix-crm-bug-c-6e7fc8-abcd12`);
    expect(t.branch).toBe("manta/fix-crm-bug-c-6e7fc8-abcd12");
  });

  it("slugs an unsafe card title so the worktree path has no spaces or colons", () => {
    const t = resolveProvisionTarget({
      ...base,
      name: "Spot check: Sentry New Issues",
      dirExists: false,
      owner: undefined,
    });
    // No space/colon in the path — node-gyp's from-source builds break otherwise.
    expect(t.worktree).toBe(`${ROOT}/Spot-check-Sentry-New-Issues-c-6e7fc8`);
    expect(t.worktree).not.toMatch(/[ :]/);
  });
});

describe("worktreeDirSlug", () => {
  it("replaces spaces, colons, and slashes with a single dash", () => {
    expect(worktreeDirSlug("Spot check: Sentry New Issues")).toBe("Spot-check-Sentry-New-Issues");
    expect(worktreeDirSlug("feat/foo bar")).toBe("feat-foo-bar");
  });

  it("keeps already-safe names unchanged", () => {
    expect(worktreeDirSlug("fix-crm-bug")).toBe("fix-crm-bug");
    expect(worktreeDirSlug("v1.2.3_build")).toBe("v1.2.3_build");
  });

  it("trims leading/trailing dashes and never returns empty", () => {
    expect(worktreeDirSlug("  hi  ")).toBe("hi");
    expect(worktreeDirSlug(":::")).toBe("task");
    expect(worktreeDirSlug("")).toBe("task");
  });
});

describe("taskIdCandidatesFromWorktreeName", () => {
  it("recovers a prefixed-hex id (most specific first)", () => {
    expect(taskIdCandidatesFromWorktreeName("fix-crm-bug-c-6e7fc8")[0]).toBe("c-6e7fc8");
  });

  it("recovers the long 12-hex id scheme", () => {
    expect(taskIdCandidatesFromWorktreeName("ship-it-c-0123456789ab")).toContain(
      "c-0123456789ab",
    );
  });

  it("avoids the greedy -c- trap for slugs ending in -c", () => {
    const ids = taskIdCandidatesFromWorktreeName("thing-c-c-6e7fc8");
    expect(ids[0]).toBe("c-6e7fc8");
  });

  it("recovers a bare-hex id for older/test names", () => {
    expect(taskIdCandidatesFromWorktreeName("legacy-e08681")).toContain("e08681");
  });
});
