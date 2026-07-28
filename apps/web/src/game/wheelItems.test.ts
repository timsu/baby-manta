import { describe, expect, it } from "vitest";
import { buildCardWheel, buildGlobalWheel, buildLinearDepotWheel } from "./wheelItems.ts";
import { makeCard, makeMember, makeTicket } from "./testFixtures.ts";

const members = [
  makeMember({ userId: "user-1", name: "Dog Tester" }),
  makeMember({ userId: "user-2", name: "Kris Katta" }),
];

describe("buildCardWheel", () => {
  it("always offers open + carry, in that order (tap-E parity first)", () => {
    const wheel = buildCardWheel(makeCard({ id: "a", title: "Fix it" }), members);
    expect(wheel.title).toBe("Fix it");
    expect(wheel.items[0]!.id).toBe("open");
    expect(wheel.items[1]!.id).toBe("carry");
  });

  it("nests reassign as a submenu of the other members", () => {
    const wheel = buildCardWheel(makeCard({ id: "a", createdBy: "user-1" }), members);
    const reassign = wheel.items.find((i) => i.id === "reassign")!;
    expect(reassign.action.type).toBe("submenu");
    const sub = reassign.action.type === "submenu" ? reassign.action.items : [];
    expect(sub).toHaveLength(1);
    expect(sub[0]!.action).toEqual({ type: "reassign", userId: "user-2" });
  });

  it("surfaces PR-state actions exactly when the 2D board would", () => {
    const hot = buildCardWheel(makeCard({
      id: "a", cardStatus: "pr_review", prNumber: 7, mergeable: "CONFLICTING", checksStatus: "failing",
    }), members);
    expect(hot.items.map((i) => i.id)).toEqual(["open", "carry", "reassign", "automerge", "linkpr", "fix-conflicts", "fix-checks"]);
    const plain = buildCardWheel(makeCard({ id: "b" }), [members[0]!]);
    expect(plain.items.map((i) => i.id)).toEqual(["open", "carry", "linkpr"]);
  });
});

describe("buildGlobalWheel", () => {
  it("covers every app-level operation", () => {
    const wheel = buildGlobalWheel("me");
    expect(wheel.items.map((i) => i.id)).toEqual([
      "new-card", "refresh", "board-mode", "workers", "spot-checks", "settings", "debug", "chat",
    ]);
  });

  it("marks the current board scope in the submenu", () => {
    const wheel = buildGlobalWheel("team");
    const scope = wheel.items.find((i) => i.id === "board-mode")!;
    expect(scope.label).toBe("Scope: All team");
    const sub = scope.action.type === "submenu" ? scope.action.items : [];
    expect(sub.map((i) => i.label)).toEqual(["Mine", "All team ✓", "Automated"]);
    expect(sub[2]!.action).toEqual({ type: "board-mode", mode: "automated" });
  });
});

describe("buildLinearDepotWheel", () => {
  const filters = [
    { type: "unstarted", label: "Todo", count: 2 },
    { type: "started", label: "In Progress", count: 1 },
  ];

  it("titles with the active status and lists its tickets", () => {
    const wheel = buildLinearDepotWheel([makeTicket({ identifier: "ENG-1" })], filters, "Todo");
    expect(wheel.title).toBe("Linear · Todo");
    expect(wheel.items[0]!.label).toContain("ENG-1");
  });

  it("offers a Showing submenu with counts and a check on the active status", () => {
    const wheel = buildLinearDepotWheel([], filters, "Todo");
    const filterItem = wheel.items.find((i) => i.id === "linear-filter")!;
    expect(filterItem.label).toBe("Showing: Todo");
    const sub = filterItem.action.type === "submenu" ? filterItem.action.items : [];
    expect(sub.map((i) => i.label)).toEqual(["Todo (2) ✓", "In Progress (1)"]);
    expect(sub[1]!.action).toEqual({ type: "linear-filter", stateName: "In Progress" });
  });

  it("omits the switcher when only one status exists and tickets are shown", () => {
    const wheel = buildLinearDepotWheel([makeTicket({ identifier: "ENG-1" })], [filters[0]!], "Todo");
    expect(wheel.items.some((i) => i.id === "linear-filter")).toBe(false);
  });
});
