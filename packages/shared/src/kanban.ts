// Shared kanban contract: statuses, labels, columns, allowed transitions,
// done-reason rules, and the user drag-affordance rule.
//
// PORT NOTE: this is a 1:1 port of the prototype's `shared/kanban.ts`, kept
// structurally identical so the two can be diffed during the cloud rebuild.
// The backend (apps/server) remains authoritative for validation; the web app
// imports the same constants for drag affordances. Do not "improve" the logic
// here without diffing against the source — divergence is a bug in the port.

// --- Types ---

export type CardStatus =
  | "backlog"
  | "bot_working"
  | "needs_help"
  | "ready_to_test"
  | "interactive"
  | "pr_review"
  | "investigation_complete"
  | "done"
  | "canceled";

export type DoneReason = "merged" | "abandoned" | "completed" | "investigation_complete" | "closed_unmerged";

/** Card type — set at creation, immutable.
 *
 * Triage is **not** a separate card type. A triage request creates an
 * "interactive" card whose description is prefixed with a
 * `Skill({"skill":"triage"})` invocation. */
export type CardType = "bot" | "investigation" | "interactive" | "backlog" | "plan";

/** Who initiated a status transition. */
export type TransitionActor = "worker" | "brain" | "poller" | "human";

/** Append-only transition log entry on Task.transitions[]. */
export interface CardTransition {
  from: string;
  to: string;
  /** ISO date string. */
  at: string;
  by: TransitionActor;
  reason?: string;
}

/** Cached GitHub PR state, refreshed by the poller. */
export interface PrCache {
  isDraft: boolean;
  isMerged: boolean;
  isClosed: boolean;
  /** Raw GitHub state ("OPEN" | "MERGED" | "CLOSED" | "DRAFT" or similar). */
  state: string;
  /** ISO timestamp of the last successful refresh. */
  checkedAt: string;
}

// --- Statuses, labels, columns ---

export const STATUSES = [
  "backlog",
  "bot_working",
  "needs_help",
  "ready_to_test",
  "interactive",
  "pr_review",
  "investigation_complete",
  "done",
  "canceled",
] as const satisfies readonly CardStatus[];

export const STATUS_LABELS: Readonly<Record<CardStatus, string>> = {
  backlog: "Backlog",
  bot_working: "Bot working",
  needs_help: "Needs help",
  ready_to_test: "Ready to test",
  interactive: "Interactive",
  pr_review: "PR review",
  investigation_complete: "Investigation complete",
  done: "Done",
  canceled: "Canceled",
};

export interface ColumnDef {
  status: CardStatus;
  title: string;
  emoji: string;
}

/** Board columns in left-to-right render order. */
export const COLUMNS: readonly ColumnDef[] = [
  { status: "backlog",       title: "Backlog",             emoji: "🗂"  },
  { status: "bot_working",   title: "Bot Working",         emoji: "🤖"  },
  { status: "needs_help",    title: "Needs Help",          emoji: "🚨"  },
  { status: "ready_to_test", title: "Ready to Test",       emoji: "🧪"  },
  { status: "interactive",   title: "Interactive Session", emoji: "💬"  },
  { status: "pr_review",     title: "PR Review",           emoji: "👀"  },
  { status: "investigation_complete", title: "Investigation Complete", emoji: "🔎" },
  { status: "done",          title: "Done",                emoji: "✅"  },
  { status: "canceled",      title: "Canceled",            emoji: "🚫"  },
];

/** Columns with a "+ New card" button, and the cardType the button creates. */
export const QUICKADD_COLUMNS: Readonly<Partial<Record<CardStatus, CardType>>> = {
  backlog: "backlog",
  bot_working: "bot",
  interactive: "interactive",
};

// --- Transitions ---

/**
 * Backend allow-list for stored-status transitions. Edge format `${from}->${to}`,
 * value is the actors permitted to initiate. PR-state-driven derived states
 * (e.g. ready_to_test ↔ pr_review by un-drafting, *→done by merge) are
 * deliberately absent: those are derived from PR cache, not stored.
 */
export const ALLOWED_EDGES: Readonly<Record<string, readonly TransitionActor[]>> = {
  "backlog->bot_working":      ["human", "brain", "worker"],
  "interactive->bot_working":  ["human", "brain"],
  "interactive->ready_to_test":["human"],
  "interactive->pr_review":    ["human"],
  "ready_to_test->bot_working":["human", "brain"],
  "pr_review->bot_working":    ["human", "brain"],
  "done->bot_working":         ["human", "brain"],
  "bot_working->needs_help":   ["worker", "poller"],
  "needs_help->bot_working":   ["worker", "human"],
  "bot_working->ready_to_test":["worker", "human"],
  "bot_working->investigation_complete": ["worker"],
  "bot_working->done":         ["worker"],
  "interactive->done":         ["human", "poller"],
  "ready_to_test->done":       ["poller"],
  "pr_review->done":           ["poller"],
  "investigation_complete->done": ["human", "brain"],
  "investigation_complete->bot_working": ["human", "brain"],
  "pr_review->interactive":    ["human"],
  "ready_to_test->interactive":["human"],
};

/** Done-reasons that permit a wildcard `*→done` transition. */
export const WILDCARD_TO_DONE_REASONS: readonly DoneReason[] = ["abandoned", "completed", "investigation_complete"];

export const DONE_REASONS: readonly DoneReason[] = ["merged", "abandoned", "completed", "investigation_complete", "closed_unmerged"];

/**
 * Whether `actor` may move a card `from → to` as a *stored-status* transition.
 * Encodes ALLOWED_EDGES plus the wildcard `*→done` rule (spec §5.4): any actor
 * in {human, brain, poller} may force `*→done` when the done-reason is
 * `abandoned` or `completed`. Backend validation entry point.
 */
export function isTransitionAllowed(
  from: CardStatus,
  to: CardStatus,
  actor: TransitionActor,
  doneReason?: DoneReason,
): boolean {
  if (from === to) return false;
  if (
    to === "done" &&
    doneReason !== undefined &&
    WILDCARD_TO_DONE_REASONS.includes(doneReason) &&
    (actor === "human" || actor === "brain" || actor === "poller")
  ) {
    return true;
  }
  // Humans can cancel from the board; the brain can cancel when a tool-backed
  // orchestration decision aborts active work before archiving/replacing it.
  if (to === "canceled" && from !== "canceled" && (actor === "human" || actor === "brain")) return true;
  const actors = ALLOWED_EDGES[`${from}->${to}`];
  return actors !== undefined && actors.includes(actor);
}

// --- Derived status (spec §5.2) ---

/** Inputs to deriveStatus: the stored status + PR/claim context. */
export interface DeriveStatusInput {
  cardStatus: CardStatus;
  doneReason?: DoneReason;
  prCache?: PrCache;
}

/**
 * Resolve the *displayed* status from stored status + PR cache, in priority
 * order (spec §5.2). The stored status is what gets persisted; this is what the
 * user sees. Kept as a pure function so it can be unit-tested and shared.
 */
export function deriveStatus(input: DeriveStatusInput): CardStatus {
  const { cardStatus, doneReason, prCache } = input;

  // 1. Stored done with reason abandoned/completed wins, regardless of PR state.
  if (cardStatus === "done" && (doneReason === "abandoned" || doneReason === "completed")) {
    return "done";
  }
  // 1b. Canceled is terminal.
  if (cardStatus === "canceled") return "canceled";
  // Investigation-complete cards are pending human acknowledgement, not done.
  if (cardStatus === "investigation_complete") return "investigation_complete";
  // 2. Stored interactive wins over an open/draft PR (explicit human claim).
  if (cardStatus === "interactive") return "interactive";
  // 3. Terminal PR (merged or closed) → done.
  if (prCache && (prCache.isMerged || prCache.isClosed)) return "done";
  // 4. Stored bot_working / needs_help on a PR-bearing card wins over open/draft.
  if ((cardStatus === "bot_working" || cardStatus === "needs_help") && prCache) {
    return cardStatus;
  }
  // 5. PR cache present → derive from PR state.
  if (prCache) {
    if (prCache.isDraft) return "ready_to_test";
    if (prCache.state.toUpperCase() === "OPEN") return "pr_review";
    return "done"; // terminal handled above; any other state treated as done
  }
  // 6. Stored status as-is.
  if (STATUSES.includes(cardStatus)) return cardStatus;
  // 7. Fallback.
  return "bot_working";
}

// --- UI drag affordance ---

/** Runtime state about the source card the UI uses to evaluate drag rules. */
export interface DragContext {
  hasPr: boolean;
  isPrOnly: boolean;
  isPrDraft: boolean;
}

/**
 * Whether the user is allowed to *initiate* a drag. A human dragging on the
 * board is an explicit, intentional act, so a real card may be moved to ANY
 * other column — the edge allow-list (ALLOWED_EDGES) disciplines the automated
 * actors (worker/poller/brain), not direct human manipulation. The status route
 * forces the resulting human transition and runs the side effects (worker
 * dispatch, terminal/sandbox cleanup, PR-status reset) regardless of edge.
 *
 * The only restrictions: no self-drag, and a PR-only card (a tracked GitHub PR
 * with no task behind it) can only become a real task via bot_working.
 */
export function isUserDragAllowed(from: CardStatus, to: CardStatus, ctx: DragContext): boolean {
  if (from === to) return false;
  if (ctx.isPrOnly) return to === "bot_working";
  return true;
}
