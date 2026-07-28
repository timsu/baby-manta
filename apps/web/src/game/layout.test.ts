import { describe, expect, it } from "vitest";
import { COLUMNS } from "@manta/shared";
import {
  buildWorldLayout,
  findWorldMatch,
  linearStateFilters,
  STREET_HALF,
  DEPOT_SAMPLES,
  DEPOT_WHEEL_ITEMS,
  MAX_KIOSKS_PER_DISTRICT,
  cardFace,
  filterCardsForMode,
  initialsFor,
  isWorkerLive,
  truncateLabel,
  zoneAt,
} from "./layout.ts";
import { makeCard, makeMember, makePr, makeTicket } from "./testFixtures.ts";
import type { WorldInput } from "./types.ts";

const baseInput: WorldInput & { boardMode: "team"; meId: string } = {
  cards: [],
  githubPrs: [],
  linearTickets: [],
  memberships: [{ workspaceId: "ws-1", name: "Acme" }],
  activeWorkspaceId: "ws-1",
  members: [makeMember({ userId: "user-1", name: "Dog Tester", email: "dog@example.com" })],
  pendingQuestionTaskIds: [],
  boardMode: "team",
  meId: "user-1",
};

describe("buildWorldLayout (boardwalk)", () => {
  it("lays districts along the street in board order, alternating sides", () => {
    const layout = buildWorldLayout(baseInput);
    expect(layout.zones.map((z) => z.status)).toEqual(COLUMNS.map((c) => c.status));
    // Board order flows west→east.
    for (let i = 1; i < layout.zones.length; i++) {
      expect(layout.zones[i]!.x).toBeGreaterThan(layout.zones[i - 1]!.x);
    }
    // Alternating sides, all plots clear of the street.
    layout.zones.forEach((z, i) => {
      expect(z.side).toBe(i % 2 === 0 ? -1 : 1);
      expect(Math.abs(z.z) - z.halfD).toBeGreaterThanOrEqual(STREET_HALF);
    });
  });

  it("keeps same-side neighbors from overlapping", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: Array.from({ length: 14 }, (_, i) => makeCard({ id: `c${i}`, cardStatus: i % 2 ? "bot_working" : "needs_help" })),
    });
    for (let i = 0; i + 2 < layout.zones.length; i += 1) {
      const a = layout.zones[i]!;
      const b = layout.zones[i + 2]!; // same side
      expect(Math.abs(a.x - b.x), `${a.status}↔${b.status}`).toBeGreaterThan(a.halfW + b.halfW);
    }
  });

  it("places every kiosk inside its own district plot", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: Array.from({ length: 7 }, (_, i) => makeCard({ id: `c${i}` })),
    });
    const kiosks = layout.interactables.filter((i) => i.kind === "card");
    expect(kiosks).toHaveLength(7);
    for (const k of kiosks) {
      expect(zoneAt(k.x, k.z, layout.zones)?.status, k.id).toBe("bot_working");
    }
  });

  it("caps kiosks per district at the freshest N and reports the remainder", () => {
    const cards = Array.from({ length: 20 }, (_, i) =>
      makeCard({ id: `c${i}`, updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const layout = buildWorldLayout({ ...baseInput, cards });
    const kiosks = layout.interactables.filter((i) => i.kind === "card");
    expect(kiosks).toHaveLength(MAX_KIOSKS_PER_DISTRICT);
    // Freshest first: c19 (latest updatedAt) must be shown, c0 must not.
    expect(kiosks.some((k) => k.id === "card:c19")).toBe(true);
    expect(kiosks.some((k) => k.id === "card:c0")).toBe(false);
    const bot = layout.zones.find((z) => z.status === "bot_working")!;
    expect(bot.count).toBe(20);
    expect(bot.moreCount).toBe(20 - MAX_KIOSKS_PER_DISTRICT);
  });

  it("keeps the street walkable — end to end in a few seconds", () => {
    // Half-extent ≤ ~32 → full street ≈ 60 units ≈ 6s at run speed.
    expect(buildWorldLayout(baseInput).bounds).toBeLessThanOrEqual(32);
  });

  it("keeps everything inside bounds when a column is huge", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: Array.from({ length: 40 }, (_, i) => makeCard({ id: `c${i}` })),
    });
    const bot = layout.zones.find((z) => z.status === "bot_working")!;
    expect(bot.count).toBe(40);
    for (const it of layout.interactables) {
      expect(Math.abs(it.x), it.id).toBeLessThanOrEqual(layout.bounds);
      expect(Math.abs(it.z), it.id).toBeLessThanOrEqual(layout.bounds);
    }
  });

  it("reports per-district card counts for gates and HUD", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: [makeCard({ id: "a" }), makeCard({ id: "b" }), makeCard({ id: "c", cardStatus: "done" })],
    });
    const byStatus = new Map(layout.zones.map((z) => [z.status, z.count]));
    expect(byStatus.get("bot_working")).toBe(2);
    expect(byStatus.get("done")).toBe(1);
    expect(byStatus.get("backlog")).toBe(0);
  });

  it("keeps the world about the work: no operation buildings, no brain orb", () => {
    const layout = buildWorldLayout({ ...baseInput, cards: [makeCard({ id: "a" })] });
    const kinds = new Set<string>(layout.interactables.map((i) => i.kind));
    expect([...kinds]).toEqual(["card"]);
    for (const gone of ["chat", "new-card", "workers", "settings", "debug", "spot-checks", "refresh", "board-mode"]) {
      expect(kinds.has(gone), gone).toBe(false);
    }
  });

  it("puts intake (depots, portals) west of the first district", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      memberships: [
        { workspaceId: "ws-1", name: "Acme" },
        { workspaceId: "ws-2", name: "Beta" },
      ],
      githubPrs: [makePr({ number: 1 })],
      linearTickets: [makeTicket({ identifier: "ENG-1" })],
    });
    const firstDistrictX = layout.zones[0]!.x - layout.zones[0]!.halfW;
    for (const kind of ["pr-depot", "linear-depot", "workspace"]) {
      const it = layout.interactables.find((i) => i.kind === kind)!;
      expect(it.x, kind).toBeLessThan(firstDistrictX);
    }
  });

  it("spawns a question beacon beside a card with a pending worker question", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: [makeCard({ id: "asked" })],
      pendingQuestionTaskIds: ["asked"],
    });
    const beacon = layout.interactables.find((i) => i.id === "question:asked");
    const kiosk = layout.interactables.find((i) => i.id === "card:asked")!;
    expect(beacon).toBeDefined();
    expect(Math.hypot(beacon!.x - kiosk.x, beacon!.z - kiosk.z)).toBeLessThan(3);
  });

  it("aggregates PRs and tickets into depots with sample items", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      githubPrs: Array.from({ length: 12 }, (_, i) => makePr({ number: i + 1 })),
      linearTickets: Array.from({ length: 10 }, (_, i) => makeTicket({ identifier: `ENG-${i}` })),
    });
    const prDepot = layout.interactables.find((i) => i.kind === "pr-depot")!;
    expect(prDepot.label).toContain("12 untracked PRs");
    expect(prDepot.data?.prs).toHaveLength(DEPOT_WHEEL_ITEMS);
    const linearDepot = layout.interactables.find((i) => i.kind === "linear-depot")!;
    expect(linearDepot.data?.tickets).toHaveLength(DEPOT_WHEEL_ITEMS);
    // Only a handful of physical sample items, never one per PR.
    expect(layout.interactables.filter((i) => i.kind === "github-pr")).toHaveLength(DEPOT_SAMPLES);
    expect(layout.interactables.filter((i) => i.kind === "linear-ticket")).toHaveLength(DEPOT_SAMPLES);
  });

  it("shows only the active Linear STATE NAME in the yard ('Todo' by default)", () => {
    // "Upcoming" and "Todo" are both type `unstarted` — they must be
    // separate filters, and only literal "Todo" shows by default.
    const tickets = [
      makeTicket({ identifier: "ENG-1" }), // state name "Todo", type unstarted
      makeTicket({ identifier: "ENG-2", state: { id: "s2", name: "Upcoming", type: "unstarted", position: 2 } }),
      makeTicket({ identifier: "ENG-3", state: { id: "s3", name: "On call triage", type: "unstarted", position: 3 } }),
      makeTicket({ identifier: "ENG-4", state: { id: "s4", name: "In Progress", type: "started", position: 1 } }),
    ];
    const byDefault = buildWorldLayout({ ...baseInput, linearTickets: tickets });
    const depot = byDefault.interactables.find((i) => i.kind === "linear-depot")!;
    expect(depot.label).toContain('1 "Todo" ticket');
    expect(depot.data?.tickets?.map((t) => t.identifier)).toEqual(["ENG-1"]);
    expect(depot.data?.ticketFilter).toBe("Todo");
    expect(depot.data?.ticketFilters?.map((f) => `${f.label}:${f.count}`)).toEqual([
      "Todo:1", "Upcoming:1", "On call triage:1", "In Progress:1",
    ]);
    expect(byDefault.interactables.filter((i) => i.kind === "linear-ticket")).toHaveLength(1);

    const upcoming = buildWorldLayout({ ...baseInput, linearTickets: tickets, linearYardStateType: "Upcoming" });
    expect(upcoming.interactables.find((i) => i.kind === "linear-depot")!.label).toContain('1 "Upcoming" ticket');
    expect(upcoming.interactables.filter((i) => i.kind === "linear-ticket")).toHaveLength(1);
    expect(upcoming.interactables.find((i) => i.kind === "linear-ticket")!.id).toBe("linear:ENG-2");
  });

  it("falls back to the first unstarted state when no state is named Todo", () => {
    const tickets = [
      makeTicket({ identifier: "ENG-1", state: { id: "s2", name: "Upcoming", type: "unstarted", position: 2 } }),
      makeTicket({ identifier: "ENG-2", state: { id: "s4", name: "In Progress", type: "started", position: 1 } }),
    ];
    const layout = buildWorldLayout({ ...baseInput, linearTickets: tickets });
    expect(layout.interactables.find((i) => i.kind === "linear-depot")!.data?.ticketFilter).toBe("Upcoming");
  });

  it("omits depots entirely when there is nothing to browse", () => {
    const layout = buildWorldLayout(baseInput);
    expect(layout.interactables.some((i) => i.kind === "pr-depot" || i.kind === "linear-depot")).toBe(false);
  });

  it("adds portals only for non-active workspaces, and PR/ticket stations", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      memberships: [
        { workspaceId: "ws-1", name: "Acme" },
        { workspaceId: "ws-2", name: "Beta" },
      ],
      githubPrs: [makePr({ number: 42, title: "Fix the flux capacitor" })],
      linearTickets: [makeTicket({ identifier: "ENG-7", repo: "org/repo" })],
    });
    const portals = layout.interactables.filter((i) => i.kind === "workspace");
    expect(portals).toHaveLength(1);
    expect(portals[0]!.data?.workspaceId).toBe("ws-2");
    const pr = layout.interactables.find((i) => i.kind === "github-pr")!;
    expect(pr.data?.pr?.number).toBe(42);
    const ticket = layout.interactables.find((i) => i.kind === "linear-ticket")!;
    expect(ticket.data?.linearIdentifier).toBe("ENG-7");
    expect(layout.interactables.find((i) => i.kind === "pr-depot")).toBeDefined();
  });
});

describe("zoneAt", () => {
  it("finds the plot containing a point, or null", () => {
    const layout = buildWorldLayout({ ...baseInput, cards: [makeCard({ id: "a" })] });
    const bot = layout.zones.find((z) => z.status === "bot_working")!;
    expect(zoneAt(bot.x, bot.z, layout.zones)?.status).toBe("bot_working");
    expect(zoneAt(0, 0, layout.zones)).toBeNull(); // the street is no district
  });
});

describe("cardFace", () => {
  it("derives the same display facts the 2D card shows", () => {
    const card = makeCard({
      id: "t1",
      title: "Ship the thing",
      cardStatus: "pr_review",
      taskNumber: 12,
      repo: "acme/app",
      prNumber: 7,
      checksStatus: "failing",
      linearIssueIdentifier: "ENG-9",
      characterEmoji: "🦴",
      createdBy: "user-1",
      workerActive: true,
      venueStatus: "active",
      workerStatus: "running",
    });
    const face = cardFace(card, new Map([["user-1", makeMember({ userId: "user-1", name: "Dog Tester", email: "dog@example.com" })]]), new Set());
    expect(face.displayId).toBe("app-12");
    expect(face.statusLabel).toBe("PR review");
    expect(face.assigneeInitials).toBe("DT");
    expect(face.workerLive).toBe(true);
  });

  it("leaves the assignee chip empty for automation cards", () => {
    const face = cardFace(makeCard({ id: "t1", createdBy: null }), new Map(), new Set());
    expect(face.assigneeInitials).toBe("");
  });
});

describe("isWorkerLive", () => {
  it("mirrors the 2D board's live-dot rule", () => {
    expect(isWorkerLive(makeCard({ id: "a", workerActive: true, venueStatus: "active", workerStatus: "running" }))).toBe(true);
    expect(isWorkerLive(makeCard({ id: "b", workerActive: true, venueStatus: "active", workerStatus: "failed" }))).toBe(false);
    expect(isWorkerLive(makeCard({ id: "c", workerActive: false, venueStatus: "active", workerStatus: "running" }))).toBe(false);
  });
});

describe("filterCardsForMode", () => {
  const cards = [
    makeCard({ id: "mine", createdBy: "user-1" }),
    makeCard({ id: "theirs", createdBy: "user-2" }),
    makeCard({ id: "hidden", createdBy: "user-1", hidden: true, backgroundMode: "spot_check" }),
    makeCard({ id: "hidden-other", createdBy: "user-1", hidden: true, backgroundMode: null }),
  ];

  it("'me' keeps only my visible cards (same rule as the 2D board)", () => {
    expect(filterCardsForMode(cards, "me", "user-1").map((c) => c.id)).toEqual(["mine"]);
  });

  it("'team' keeps all visible cards", () => {
    expect(filterCardsForMode(cards, "team", "user-1").map((c) => c.id)).toEqual(["mine", "theirs"]);
  });

  it("'automated' keeps only hidden automation-background cards (Board parity)", () => {
    expect(filterCardsForMode(cards, "automated", "user-1").map((c) => c.id)).toEqual(["hidden"]);
  });

  it("orders ties deterministically by id when updatedAt is equal", () => {
    const tied = Array.from({ length: 4 }, (_, i) => makeCard({ id: `t${3 - i}` })); // same updatedAt, ids t3..t0
    const layout = buildWorldLayout({ ...baseInput, cards: tied });
    const kioskIds = layout.interactables.filter((i) => i.kind === "card").map((i) => i.id);
    expect(kioskIds).toEqual(["card:t0", "card:t1", "card:t2", "card:t3"]);
  });
});

describe("initialsFor / truncateLabel", () => {
  it("derives initials from name parts, falling back to email", () => {
    expect(initialsFor("Dog Tester", "x@y.z")).toBe("DT");
    expect(initialsFor(null, "sam@example.com")).toBe("SE");
  });

  it("ellipsizes long labels", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("x".repeat(60)).endsWith("…")).toBe(true);
  });
});

describe("linearStateFilters", () => {
  it("groups by state name, ordered by type then state position", () => {
    const tickets = [
      makeTicket({ identifier: "a", state: { id: "1", name: "In Progress", type: "started", position: 2 } }),
      makeTicket({ identifier: "b" }),
      makeTicket({ identifier: "c" }),
      makeTicket({ identifier: "d", state: { id: "2", name: "Icebox", type: "backlog", position: 0 } }),
      makeTicket({ identifier: "e", state: { id: "3", name: "Upcoming", type: "unstarted", position: 5 } }),
    ];
    expect(linearStateFilters(tickets)).toEqual([
      { type: "backlog", label: "Icebox", count: 1 },
      { type: "unstarted", label: "Todo", count: 2 },
      { type: "unstarted", label: "Upcoming", count: 1 },
      { type: "started", label: "In Progress", count: 1 },
    ]);
  });
});

describe("trophies (Done district)", () => {
  const NOW = Date.parse("2026-07-01T00:00:00Z");

  it("counts cards merged within the last week", () => {
    const cards = [
      makeCard({ id: "fresh", cardStatus: "done", doneReason: "merged", updatedAt: "2026-06-29T00:00:00Z" }),
      makeCard({ id: "fresh2", cardStatus: "done", doneReason: "merged", updatedAt: "2026-06-30T12:00:00Z" }),
      makeCard({ id: "old", cardStatus: "done", doneReason: "merged", updatedAt: "2026-06-01T00:00:00Z" }),
      makeCard({ id: "abandoned", cardStatus: "done", doneReason: "abandoned", updatedAt: "2026-06-30T00:00:00Z" }),
      makeCard({ id: "working", cardStatus: "bot_working", updatedAt: "2026-06-30T00:00:00Z" }),
    ];
    const layout = buildWorldLayout({ ...baseInput, cards, now: NOW });
    const done = layout.zones.find((z) => z.status === "done")!;
    expect(done.trophyCount).toBe(2);
    expect(layout.zones.find((z) => z.status === "bot_working")!.trophyCount).toBe(0);
  });

  it("is zero without a clock (deterministic default)", () => {
    const layout = buildWorldLayout({
      ...baseInput,
      cards: [makeCard({ id: "a", cardStatus: "done", doneReason: "merged" })],
    });
    expect(layout.zones.find((z) => z.status === "done")!.trophyCount).toBe(0);
  });
});

describe("findWorldMatch (whistle)", () => {
  function world() {
    return buildWorldLayout({
      ...baseInput,
      cards: [
        makeCard({ id: "a", title: "Fix login redirect", taskNumber: 32, repo: "acme/app" }),
        makeCard({ id: "b", title: "Login page styles", taskNumber: 40, repo: "acme/app" }),
      ],
      githubPrs: [makePr({ number: 130, title: "Add OTEL spans" })],
      linearTickets: [makeTicket({ identifier: "ENG-501", title: "Meeting prep misses attendees" })],
    }).interactables;
  }

  it("prefers exact display-id hits over title substrings", () => {
    expect(findWorldMatch("app-40", world())?.id).toBe("card:b");
    expect(findWorldMatch("ENG-501", world())?.id).toBe("linear:ENG-501");
    expect(findWorldMatch("#130", world())?.id).toBe("github-pr:org/repo#130");
  });

  it("falls back to title substring, case-insensitive", () => {
    expect(findWorldMatch("otel", world())?.id).toBe("github-pr:org/repo#130");
    expect(findWorldMatch("LOGIN REDIRECT", world())?.id).toBe("card:a");
  });

  it("returns null for no match or empty query", () => {
    expect(findWorldMatch("zzz-nothing", world())).toBeNull();
    expect(findWorldMatch("  ", world())).toBeNull();
  });
});
