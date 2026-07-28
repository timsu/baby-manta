// Pure world-layout builder: derives every zone and interactable position from
// a snapshot of app state. Deterministic (no randomness, no Date) so unit
// tests and e2e assertions can rely on exact positions.
//
// Shape: THE BOARDWALK — a straight street running west→east. District plots
// line both sides in board order (alternating north/south), so the kanban flow
// is spatial: intake (PR wharf, Linear yard, workspace portals) sits at the
// west end and work travels east toward Done. Carrying a card east = progress.

import { COLUMNS, STATUS_LABELS } from "@manta/shared";
import { taskDisplayId } from "../lib/format.ts";
import type { BoardMode } from "../stores.ts";
import type { LinearTicket, Member, TaskCard } from "../api.ts";
import type { CardFace, Interactable, WorldInput, WorldLayout, ZoneDef } from "./types.ts";

/** Kiosk grid inside a plot: 2 columns (along the street), rows going away. */
export const CARD_COL_OFFSET = 1.6;
export const CARD_ROW_PITCH = 2.9;
/** Most kiosks a district shows — the freshest cards; the rest are a "+N"
 *  totem. Keeps big production columns walkable (full list lives in 2D). */
export const MAX_KIOSKS_PER_DISTRICT = 8;
/** Sample items physically standing in each intake yard. */
export const DEPOT_SAMPLES = 6;
/** Items listed in a yard's browse wheel. */
export const DEPOT_WHEEL_ITEMS = 8;

/** Street geometry. */
export const STREET_HALF = 3.4;
const GATE_GAP = 1.1;
const DISTRICT_PITCH = 5.4;
const PLOT_HALF_W = 4.0;
const ROW_INSET = 1.6;

export function truncateLabel(text: string, max = 44): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function initialsFor(name: string | null, email: string): string {
  const src = name?.trim() || email;
  const parts = src.split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Same visibility rule the 2D board applies per mode (Board.tsx). */
export function filterCardsForMode(cards: TaskCard[], mode: BoardMode, meId: string): TaskCard[] {
  if (mode === "automated") {
    return cards.filter((c) =>
      c.hidden &&
      (c.backgroundMode === "scheduled_slack" || c.backgroundMode === "spot_check" || c.backgroundMode === "linear_status_automation"));
  }
  const visible = cards.filter((c) => !c.hidden);
  if (mode === "me") return visible.filter((c) => c.createdBy === meId);
  return visible;
}

/** Same live-worker rule the 2D card uses for its green dot. */
export function isWorkerLive(c: TaskCard): boolean {
  return c.workerActive && c.venueStatus === "active" && !["failed", "stalled"].includes(c.workerStatus);
}

export function cardFace(
  c: TaskCard,
  memberById: ReadonlyMap<string, Member>,
  pendingQuestionTaskIds: ReadonlySet<string>,
): CardFace {
  const assignee = c.createdBy ? memberById.get(c.createdBy) : undefined;
  return {
    taskId: c.id,
    title: c.title,
    emoji: c.characterEmoji ?? "🤖",
    displayId: taskDisplayId(c),
    repo: c.repo,
    status: c.cardStatus,
    statusLabel: STATUS_LABELS[c.cardStatus],
    prNumber: c.prNumber,
    checksStatus: c.checksStatus,
    mergeable: c.mergeable,
    linearIssueIdentifier: c.linearIssueIdentifier,
    assigneeInitials: assignee ? initialsFor(assignee.name, assignee.email) : "",
    assigneeName: assignee ? (assignee.name?.trim() || assignee.email) : "",
    workerLive: isWorkerLive(c),
    hasPendingQuestion: pendingQuestionTaskIds.has(c.id),
  };
}

// Linear workspaces define many states per type ("Upcoming", "On call
// triage", and "Todo" can all be type `unstarted`), so the yard filters by
// the actual STATE NAME. Type only orders the switcher along the pipeline.
const LINEAR_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

/** The status filters available for the Linear yard — one per distinct state
 *  name, with counts, ordered by type then Linear's own state position. */
export function linearStateFilters(tickets: readonly LinearTicket[]): { type: string; label: string; count: number }[] {
  const byName = new Map<string, { type: string; position: number; count: number }>();
  for (const t of tickets) {
    const cur = byName.get(t.state.name);
    if (cur) {
      cur.count += 1;
      cur.position = Math.min(cur.position, t.state.position);
    } else {
      byName.set(t.state.name, { type: t.state.type, position: t.state.position, count: 1 });
    }
  }
  return [...byName.entries()]
    .sort((a, b) => {
      const ai = LINEAR_TYPE_ORDER.indexOf(a[1].type);
      const bi = LINEAR_TYPE_ORDER.indexOf(b[1].type);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      if (a[1].position !== b[1].position) return a[1].position - b[1].position;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, v]) => ({ type: v.type, label: name, count: v.count }));
}

/** What the yard shows before the user picks: the state literally named
 *  "Todo" if it exists, else the first unstarted-type state, else the first
 *  filter in pipeline order. */
export function defaultLinearYardState(filters: readonly { type: string; label: string }[]): string | null {
  return (
    filters.find((f) => f.label.toLowerCase() === "todo")?.label ??
    filters.find((f) => f.type === "unstarted")?.label ??
    filters[0]?.label ??
    null
  );
}

/** The zone plot the point lies in, if any (used for carry-and-drop). */
export function zoneAt(x: number, z: number, zones: readonly ZoneDef[]): ZoneDef | null {
  for (const zone of zones) {
    if (Math.abs(x - zone.x) <= zone.halfW && Math.abs(z - zone.z) <= zone.halfD) return zone;
  }
  return null;
}

function plotDepth(kioskCount: number): number {
  const rows = Math.max(1, Math.ceil(kioskCount / 2));
  return ROW_INSET * 2 + (rows - 1) * CARD_ROW_PITCH + 1.6;
}

/** West end of the district row — the dog spawns just before it. */
export const STREET_START_X = -((COLUMNS.length - 1) * DISTRICT_PITCH) / 2;

export function buildWorldLayout(input: WorldInput & { boardMode: BoardMode; meId: string }): WorldLayout {
  const zones: ZoneDef[] = [];
  const interactables: Interactable[] = [];

  const cards = filterCardsForMode(input.cards, input.boardMode, input.meId);
  const memberById = new Map(input.members.map((m) => [m.userId, m] as const));
  const pendingQuestions = new Set(input.pendingQuestionTaskIds);

  const startX = STREET_START_X;

  const byStatus = COLUMNS.map((col) =>
    cards
      .filter((c) => c.cardStatus === col.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
  );

  COLUMNS.forEach((col, i) => {
    const shown = byStatus[i]!.slice(0, MAX_KIOSKS_PER_DISTRICT);
    const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
    const x = startX + i * DISTRICT_PITCH;
    const depth = plotDepth(shown.length);
    const halfD = depth / 2;
    const innerZ = side * (STREET_HALF + GATE_GAP);
    const z = innerZ + side * halfD;
    // The Done district earns a trophy per card merged in the last week.
    const trophyCount = col.status === "done" && input.now
      ? byStatus[i]!.filter((c) => c.doneReason === "merged" && input.now! - Date.parse(c.updatedAt) < 7 * 24 * 3600 * 1000).length
      : 0;
    zones.push({
      status: col.status,
      title: col.title,
      emoji: col.emoji,
      x,
      z,
      halfW: PLOT_HALF_W,
      halfD,
      side,
      count: byStatus[i]!.length,
      moreCount: byStatus[i]!.length - shown.length,
      trophyCount,
    });

    shown.forEach((card, idx) => {
      const row = Math.floor(idx / 2);
      const colSide = idx % 2 === 0 ? -1 : 1;
      const kx = x + colSide * CARD_COL_OFFSET;
      const kz = innerZ + side * (ROW_INSET + row * CARD_ROW_PITCH);
      const face = cardFace(card, memberById, pendingQuestions);
      interactables.push({
        id: `card:${card.id}`,
        kind: "card",
        label: `${truncateLabel(card.title)}`,
        x: kx,
        z: kz,
        data: { taskId: card.id, status: card.cardStatus, face },
      });
      if (face.hasPendingQuestion) {
        interactables.push({
          id: `question:${card.id}`,
          kind: "question",
          label: `answer the worker's question on "${truncateLabel(card.title, 28)}"`,
          x: kx + 1.4,
          z: kz,
          data: { taskId: card.id },
        });
      }
    });
  });

  // Intake end (west of the first district): PR wharf north, Linear yard
  // south — inbound work enters the street where the pipeline begins.
  const intakeX = startX - 9;
  if (input.githubPrs.length > 0) {
    const side = -1;
    const innerZ = side * (STREET_HALF + 0.6);
    interactables.push({
      id: "depot:github-prs",
      kind: "pr-depot",
      label: `browse ${input.githubPrs.length} untracked PR${input.githubPrs.length === 1 ? "" : "s"}`,
      x: intakeX,
      z: innerZ,
      data: { prs: input.githubPrs.slice(0, DEPOT_WHEEL_ITEMS) },
    });
    input.githubPrs.slice(0, DEPOT_SAMPLES).forEach((pr, i) => {
      const row = Math.floor(i / 2);
      const colSide = i % 2 === 0 ? -1 : 1;
      interactables.push({
        id: `github-pr:${pr.repo}#${pr.number}`,
        kind: "github-pr",
        label: `track PR #${pr.number} "${truncateLabel(pr.title, 28)}"`,
        x: intakeX + colSide * CARD_COL_OFFSET,
        z: innerZ + side * (ROW_INSET + 0.6 + row * CARD_ROW_PITCH),
        data: { pr },
      });
    });
  }
  if (input.linearTickets.length > 0) {
    const side = 1;
    const innerZ = side * (STREET_HALF + 0.6);
    // The yard displays ONE state at a time (default: the one named "Todo")
    // — the banner shouts which one, and the depot wheel switches it.
    const filters = linearStateFilters(input.linearTickets);
    const yardState = input.linearYardStateType ?? defaultLinearYardState(filters) ?? "";
    const yardTickets = input.linearTickets.filter((t) => t.state.name === yardState);
    interactables.push({
      id: "depot:linear",
      kind: "linear-depot",
      label: `browse ${yardTickets.length} "${yardState}" ticket${yardTickets.length === 1 ? "" : "s"}`,
      x: intakeX,
      z: innerZ,
      data: {
        tickets: yardTickets.slice(0, DEPOT_WHEEL_ITEMS),
        ticketFilters: filters,
        ticketFilter: yardState,
      },
    });
    yardTickets.slice(0, DEPOT_SAMPLES).forEach((t, i) => {
      const row = Math.floor(i / 2);
      const colSide = i % 2 === 0 ? -1 : 1;
      interactables.push({
        id: `linear:${t.identifier}`,
        kind: "linear-ticket",
        label: `start ${t.identifier} "${truncateLabel(t.title, 28)}"`,
        x: intakeX + colSide * CARD_COL_OFFSET,
        z: innerZ + side * (ROW_INSET + 0.6 + row * CARD_ROW_PITCH),
        data: { linearIdentifier: t.identifier, repo: t.repo, ticket: t },
      });
    });
  }

  // Workspace portals stand at the street's west entrance.
  input.memberships.forEach((m, i) => {
    if (m.workspaceId === input.activeWorkspaceId) return;
    interactables.push({
      id: `workspace:${m.workspaceId}`,
      kind: "workspace",
      label: `travel to "${truncateLabel(m.name, 24)}"`,
      x: intakeX - 7,
      z: (i - (input.memberships.length - 2) / 2) * 5,
      data: { workspaceId: m.workspaceId },
    });
  });

  const maxZoneX = zones.reduce((m, zn) => Math.max(m, Math.abs(zn.x) + zn.halfW), 0);
  const maxZoneZ = zones.reduce((m, zn) => Math.max(m, Math.abs(zn.z) + zn.halfD), 0);
  const maxIt = interactables.reduce((m, it) => Math.max(m, Math.abs(it.x), Math.abs(it.z)), 0);
  const bounds = Math.ceil(Math.max(maxZoneX, maxZoneZ, maxIt)) + 5;

  return { zones, interactables, bounds };
}

/** Whistle search: first interactable matching the query (id, title, label). */
export function findWorldMatch(query: string, interactables: readonly Interactable[]): Interactable | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const haystack = (it: Interactable): string => {
    const face = it.data?.face;
    const pr = it.data?.pr;
    const ticket = it.data?.ticket;
    return [
      it.label,
      face?.title, face?.displayId, face?.linearIssueIdentifier,
      pr ? `pr #${pr.number} ${pr.title} ${pr.branch}` : "",
      ticket ? `${ticket.identifier} ${ticket.title}` : "",
    ].filter(Boolean).join(" ").toLowerCase();
  };
  // Prefer id-ish hits (displayId / identifier / PR number) over title hits.
  const idHit = interactables.find((it) => {
    const face = it.data?.face;
    return (
      face?.displayId.toLowerCase() === q ||
      face?.linearIssueIdentifier?.toLowerCase() === q ||
      it.data?.ticket?.identifier.toLowerCase() === q ||
      (it.data?.pr && `#${it.data.pr.number}` === q)
    );
  });
  if (idHit) return idHit;
  return interactables.find((it) => haystack(it).includes(q)) ?? null;
}
