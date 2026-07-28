// Dog-mode game types. Pure data — no three.js, no React — so layout,
// proximity, and action-dispatch logic stay unit-testable in node.

import type { CardStatus } from "@manta/shared";
import type { GithubPr, LinearTicket, Member, TaskCard } from "../api.ts";

/** Everything the dog can walk up to and press E on. App-level operations
 *  live in the hold-E wheel, not as world objects — the world is for work
 *  (cards, PRs, tickets) and travel (portals). */
export type InteractableKind =
  | "card"
  | "question"
  | "workspace"
  | "pr-depot"
  | "linear-depot"
  | "github-pr"
  | "linear-ticket";

/** Everything a card kiosk renders on its holo-face. Derived once in layout so
 *  the renderer and tests share one contract. */
export interface CardFace {
  taskId: string;
  title: string;
  emoji: string;
  displayId: string;
  repo: string;
  status: CardStatus;
  statusLabel: string;
  prNumber: number | null;
  checksStatus: string;
  mergeable: string;
  linearIssueIdentifier: string | null;
  /** Assignee initials + name for the avatar chip ("" when unassigned). */
  assigneeInitials: string;
  assigneeName: string;
  workerLive: boolean;
  hasPendingQuestion: boolean;
}

export interface Interactable {
  /** Stable id, e.g. `card:<taskId>` or `building:settings`. */
  id: string;
  kind: InteractableKind;
  /** Shown in the HUD prompt: "E — <label>". */
  label: string;
  x: number;
  z: number;
  /** Payload the dispatcher/renderer needs. */
  data?: {
    taskId?: string;
    workspaceId?: string;
    pr?: GithubPr;
    prs?: GithubPr[];
    ticket?: LinearTicket;
    tickets?: LinearTicket[];
    /** Linear yard: available status filters (with counts) + the active one. */
    ticketFilters?: { type: string; label: string; count: number }[];
    ticketFilter?: string;
    repo?: string | null;
    linearIdentifier?: string | null;
    status?: CardStatus;
    face?: CardFace;
  };
}

/** A board column rendered as a rectangular plot along the boardwalk. */
export interface ZoneDef {
  status: CardStatus;
  title: string;
  emoji: string;
  /** Plot center + half extents. */
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  /** Which side of the street the plot sits on (-1 = north, 1 = south). */
  side: -1 | 1;
  count: number;
  /** Cards beyond the kiosk cap (shown as a "+N" totem, listed on the 2D board). */
  moreCount: number;
  /** Done district only: cards merged within the last week (trophy row). */
  trophyCount: number;
}

/** Inputs the layout is derived from (a snapshot of app state). */
export interface WorldInput {
  cards: TaskCard[];
  githubPrs: GithubPr[];
  linearTickets: LinearTicket[];
  memberships: { workspaceId: string; name: string }[];
  activeWorkspaceId: string | null;
  members: Member[];
  /** Task ids with an unanswered worker question. */
  pendingQuestionTaskIds: string[];
  /** Which Linear state the yard displays (default: the one named "Todo"). */
  linearYardStateType?: string;
  /** Current time (ms) for time-windowed derivations (trophies). */
  now?: number;
}

export interface WorldLayout {
  zones: ZoneDef[];
  interactables: Interactable[];
  /** Half-extent of the walkable square, world units. */
  bounds: number;
}

/** What pressing E resolves to for world objects. App-level operations are
 *  dispatched by the wheel executor instead; cards and depots are
 *  special-cased in GameCanvas. */
export type GameAction =
  | { type: "open-task"; taskId: string }
  | { type: "new-card"; repo?: string; prompt?: string; linearIssueIdentifier?: string | null }
  | { type: "switch-workspace"; workspaceId: string }
  | { type: "track-pr"; pr: Pick<GithubPr, "repo" | "number" | "title" | "url" | "branch" | "state"> };
