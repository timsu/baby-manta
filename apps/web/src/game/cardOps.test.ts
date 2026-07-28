import { describe, expect, it } from "vitest";
import { buildCardRingChips, buildReassignChips, canAutoMerge, carryTargets, hasConflicts, hasFailingChecks } from "./cardOps.ts";
import { makeCard, makeMember } from "./testFixtures.ts";

const members = [
  makeMember({ userId: "user-1", name: "Dog Tester" }),
  makeMember({ userId: "user-2", name: "Kris Katta" }),
];

describe("buildCardRingChips", () => {
  it("offers reassign + link PR for a plain card", () => {
    const chips = buildCardRingChips(makeCard({ id: "a" }), members);
    expect(chips.map((c) => c.id)).toEqual(["reassign", "linkpr"]);
  });

  it("adds auto-merge and fix chips when the card's PR needs them", () => {
    const card = makeCard({
      id: "a",
      cardStatus: "pr_review",
      prNumber: 7,
      mergeable: "CONFLICTING",
      checksStatus: "failing",
    });
    const chips = buildCardRingChips(card, members);
    expect(chips.map((c) => c.id)).toEqual(["reassign", "automerge", "linkpr", "fix-conflicts", "fix-checks"]);
  });

  it("skips reassign when there is nobody else", () => {
    const chips = buildCardRingChips(makeCard({ id: "a" }), [members[0]!]);
    expect(chips.map((c) => c.id)).toEqual(["linkpr"]);
  });
});

describe("buildReassignChips", () => {
  it("lists every member except the current assignee", () => {
    const chips = buildReassignChips(makeCard({ id: "a", createdBy: "user-1" }), members);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.action).toEqual({ type: "reassign", userId: "user-2" });
  });
});

describe("carryTargets", () => {
  it("matches the 2D drag affordances", () => {
    const targets = carryTargets(makeCard({ id: "a", cardStatus: "bot_working" }));
    expect(targets).not.toContain("bot_working");
    expect(targets.length).toBeGreaterThan(0);
  });
});

describe("PR-state predicates (same rules as Board)", () => {
  it("canAutoMerge requires an open PR on a live card", () => {
    expect(canAutoMerge(makeCard({ id: "a", prNumber: 5, cardStatus: "pr_review" }))).toBe(true);
    expect(canAutoMerge(makeCard({ id: "b", prNumber: 5, cardStatus: "done" }))).toBe(false);
    expect(canAutoMerge(makeCard({ id: "c", prNumber: null }))).toBe(false);
  });

  it("hasConflicts / hasFailingChecks exclude bot_working cards", () => {
    expect(hasConflicts(makeCard({ id: "a", prNumber: 5, mergeable: "CONFLICTING", cardStatus: "pr_review" }))).toBe(true);
    expect(hasConflicts(makeCard({ id: "b", prNumber: 5, mergeable: "CONFLICTING", cardStatus: "bot_working" }))).toBe(false);
    expect(hasFailingChecks(makeCard({ id: "c", prNumber: 5, checksStatus: "failing", cardStatus: "needs_help" }))).toBe(true);
    expect(hasFailingChecks(makeCard({ id: "d", prNumber: null, checksStatus: "failing" }))).toBe(false);
  });
});
