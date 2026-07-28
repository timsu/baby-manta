import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  STATUSES,
  ALLOWED_EDGES,
  WILDCARD_TO_DONE_REASONS,
  DONE_REASONS,
  isTransitionAllowed,
  isUserDragAllowed,
  deriveStatus,
  type CardStatus,
  type TransitionActor,
  type DoneReason,
  type PrCache,
} from "./kanban.ts";

const ACTORS: TransitionActor[] = ["worker", "brain", "poller", "human"];

const arbStatus = () => fc.constantFrom<CardStatus>(...STATUSES);
const arbActor = () => fc.constantFrom<TransitionActor>(...ACTORS);
const arbDoneReason = () =>
  fc.option(fc.constantFrom<DoneReason>(...DONE_REASONS), { nil: undefined });

describe("isTransitionAllowed", () => {
  it("never allows a self-transition", () => {
    fc.assert(
      fc.property(arbStatus(), arbActor(), arbDoneReason(), (s, actor, dr) => {
        expect(isTransitionAllowed(s, s, actor, dr)).toBe(false);
      }),
    );
  });

  it("agrees with ALLOWED_EDGES for non-wildcard edges", () => {
    fc.assert(
      fc.property(arbStatus(), arbStatus(), arbActor(), (from, to, actor) => {
        if (from === to) return; // covered above
        if (to === "done") return; // wildcard rule tested separately
        // `*→canceled` by a human/brain is a wildcard (tested separately); every
        // other actor still falls through to the ALLOWED_EDGES table.
        const wildcardCancel = to === "canceled" && (actor === "human" || actor === "brain");
        const expected =
          wildcardCancel || (ALLOWED_EDGES[`${from}->${to}`]?.includes(actor) ?? false);
        expect(isTransitionAllowed(from, to, actor)).toBe(expected);
      }),
    );
  });

  it("allows wildcard *→canceled for a human or brain from any non-canceled status", () => {
    fc.assert(
      fc.property(arbStatus(), fc.constantFrom<TransitionActor>("human", "brain"), (from, actor) => {
        if (from === "canceled") return; // self-transition
        expect(isTransitionAllowed(from, "canceled", actor)).toBe(true);
      }),
    );
  });

  it("does NOT grant wildcard *→canceled to worker or poller actors", () => {
    fc.assert(
      fc.property(
        arbStatus(),
        fc.constantFrom<TransitionActor>("worker", "poller"),
        (from, actor) => {
          if (from === "canceled") return;
          // No ALLOWED_EDGES entry targets canceled, so these actors never reach it.
          expect(isTransitionAllowed(from, "canceled", actor)).toBe(false);
        },
      ),
    );
  });

  it("allows wildcard *→done for human/brain/poller with abandoned|completed", () => {
    fc.assert(
      fc.property(
        arbStatus(),
        fc.constantFrom<TransitionActor>("human", "brain", "poller"),
        fc.constantFrom<DoneReason>(...WILDCARD_TO_DONE_REASONS),
        (from, actor, reason) => {
          if (from === "done") return; // self-transition
          expect(isTransitionAllowed(from, "done", actor, reason)).toBe(true);
        },
      ),
    );
  });

  it("does NOT grant wildcard *→done to a worker", () => {
    fc.assert(
      fc.property(
        arbStatus(),
        fc.constantFrom<DoneReason>(...WILDCARD_TO_DONE_REASONS),
        (from, reason) => {
          if (from === "done") return;
          // worker only gets explicit edges; none of them target done
          const explicit = ALLOWED_EDGES[`${from}->done`]?.includes("worker") ?? false;
          expect(isTransitionAllowed(from, "done", "worker", reason)).toBe(explicit);
        },
      ),
    );
  });

  it("does NOT grant wildcard *→done for merged|closed_unmerged reasons", () => {
    fc.assert(
      fc.property(
        arbStatus(),
        fc.constantFrom<TransitionActor>("human", "brain", "poller"),
        fc.constantFrom<DoneReason>("merged", "closed_unmerged"),
        (from, actor, reason) => {
          if (from === "done") return;
          const explicit = ALLOWED_EDGES[`${from}->done`]?.includes(actor) ?? false;
          expect(isTransitionAllowed(from, "done", actor, reason)).toBe(explicit);
        },
      ),
    );
  });

  it("allows humans to move interactive sessions into testing/review", () => {
    expect(isTransitionAllowed("interactive", "ready_to_test", "human")).toBe(true);
    expect(isTransitionAllowed("interactive", "pr_review", "human")).toBe(true);
  });
});

describe("deriveStatus", () => {
  const openPr: PrCache = {
    isDraft: false,
    isMerged: false,
    isClosed: false,
    state: "OPEN",
    checkedAt: "2026-01-01T00:00:00Z",
  };
  const draftPr: PrCache = { ...openPr, isDraft: true, state: "DRAFT" };
  const mergedPr: PrCache = { ...openPr, isMerged: true, state: "MERGED" };
  const closedPr: PrCache = { ...openPr, isClosed: true, state: "CLOSED" };

  it("is total — returns a valid status for any input", () => {
    fc.assert(
      fc.property(
        arbStatus(),
        arbDoneReason(),
        fc.option(fc.constantFrom(openPr, draftPr, mergedPr, closedPr), { nil: undefined }),
        (cardStatus, doneReason, prCache) => {
          const out = deriveStatus({ cardStatus, doneReason, prCache });
          expect(STATUSES.includes(out)).toBe(true);
        },
      ),
    );
  });

  it("abandoned/completed done wins over any PR", () => {
    for (const reason of ["abandoned", "completed"] as const) {
      expect(deriveStatus({ cardStatus: "done", doneReason: reason, prCache: openPr })).toBe("done");
    }
  });

  it("stored investigation_complete stays separate from done", () => {
    expect(deriveStatus({ cardStatus: "investigation_complete", doneReason: "investigation_complete", prCache: openPr })).toBe("investigation_complete");
  });

  it("stored interactive wins over an open PR", () => {
    expect(deriveStatus({ cardStatus: "interactive", prCache: openPr })).toBe("interactive");
  });

  it("terminal PR derives done", () => {
    expect(deriveStatus({ cardStatus: "bot_working", prCache: mergedPr })).toBe("done");
    expect(deriveStatus({ cardStatus: "bot_working", prCache: closedPr })).toBe("done");
  });

  it("bot_working/needs_help win over open/draft PR", () => {
    expect(deriveStatus({ cardStatus: "bot_working", prCache: openPr })).toBe("bot_working");
    expect(deriveStatus({ cardStatus: "needs_help", prCache: draftPr })).toBe("needs_help");
  });

  it("draft PR → ready_to_test, open PR → pr_review when no overriding stored status", () => {
    expect(deriveStatus({ cardStatus: "ready_to_test", prCache: draftPr })).toBe("ready_to_test");
    expect(deriveStatus({ cardStatus: "ready_to_test", prCache: openPr })).toBe("pr_review");
  });

  it("no PR → stored status as-is", () => {
    expect(deriveStatus({ cardStatus: "backlog" })).toBe("backlog");
  });
});

describe("isUserDragAllowed", () => {
  const base = { hasPr: false, isPrOnly: false, isPrDraft: false };

  it("never allows self-drag", () => {
    fc.assert(
      fc.property(arbStatus(), (s) => {
        expect(isUserDragAllowed(s, s, base)).toBe(false);
      }),
    );
  });

  it("PR-only cards can only drag to bot_working", () => {
    fc.assert(
      fc.property(arbStatus(), arbStatus(), (from, to) => {
        if (from === to) return;
        expect(isUserDragAllowed(from, to, { ...base, isPrOnly: true })).toBe(to === "bot_working");
      }),
    );
  });

  // A human dragging on the board may move a real card to ANY other column —
  // the edge allow-list disciplines the automated actors, not direct human
  // manipulation. The backend forces the resulting human transition.
  it("allows a real card to be dragged to any other status", () => {
    fc.assert(
      fc.property(arbStatus(), arbStatus(), (from, to) => {
        if (from === to) return;
        expect(isUserDragAllowed(from, to, base)).toBe(true);
      }),
    );
  });

  it("offers moves the curated set used to withhold", () => {
    // Previously gated affordances are now all permitted for a real card.
    expect(isUserDragAllowed("bot_working", "ready_to_test", base)).toBe(true);
    expect(isUserDragAllowed("bot_working", "pr_review", base)).toBe(true);
    expect(isUserDragAllowed("done", "needs_help", base)).toBe(true);
    expect(isUserDragAllowed("needs_help", "backlog", base)).toBe(true);
  });
});
