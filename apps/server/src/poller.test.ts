import { describe, expect, it } from "vitest";
import { autoMergeBlockers, cardTitleForPrRefresh, mergeMethodFor, shouldPostLinearHandoffComment } from "./poller.ts";

describe("cardTitleForPrRefresh", () => {
  it("updates the card title when GitHub reports a changed PR title", () => {
    expect(cardTitleForPrRefresh({ title: "Old title", prTitle: "Old PR title" }, "New PR title")).toBe("New PR title");
  });

  it("keeps the card title synced to the PR title even when PR metadata is unchanged", () => {
    expect(cardTitleForPrRefresh({ title: "Custom card title", prTitle: "PR title" }, "PR title")).toBe("PR title");
  });
});

describe("shouldPostLinearHandoffComment", () => {
  it("suppresses completion comments for regular Linear-linked cards", () => {
    expect(shouldPostLinearHandoffComment({ linearTriage: null })).toBe(false);
  });

  it("suppresses completion comments for Linear status automation cards", () => {
    expect(shouldPostLinearHandoffComment({
      linearTriage: { statusAutomation: true, statusId: "status-1", statusName: "To Validate" },
    })).toBe(false);
  });
});

describe("autoMergeBlockers", () => {
  it("allows auto-merge when checks and reviews are ready but mergeability is unknown", () => {
    expect(autoMergeBlockers({
      prState: "open",
      merged: false,
      checksStatus: "passing",
      reviewDecision: "APPROVED",
      mergeable: "UNKNOWN",
    })).toEqual([]);
  });

  it("blocks auto-merge on explicit conflicts", () => {
    expect(autoMergeBlockers({
      prState: "open",
      merged: false,
      checksStatus: "passing",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    })).toEqual(["mergeable_conflicting"]);
  });
});

describe("mergeMethodFor", () => {
  it("uses squash when the repository only allows squash merges", () => {
    expect(mergeMethodFor({
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: false,
    })).toBe("squash");
  });

  it("falls back to merge when repository settings are unavailable", () => {
    expect(mergeMethodFor(null)).toBe("merge");
  });

  it("returns null when GitHub reports no merge methods are enabled", () => {
    expect(mergeMethodFor({
      allow_merge_commit: false,
      allow_squash_merge: false,
      allow_rebase_merge: false,
    })).toBeNull();
  });
});
