// Pure builders for the hold-E radial wheel. Two contexts:
//  - near a card: open / carry / the card's ops (reassign, auto-merge, …)
//  - anywhere else: the global wheel — every app-level operation without
//    running to its building (the buildings stay as world anchors).
// Builders are pure so tests can assert the exact action surface.

import { STATUS_LABELS } from "@manta/shared";
import type { GithubPr, LinearTicket, Member, TaskCard } from "../api.ts";
import type { BoardMode } from "../stores.ts";
import { buildReassignChips, canAutoMerge, hasConflicts, hasFailingChecks } from "./cardOps.ts";
import { truncateLabel } from "./layout.ts";

export type WheelAction =
  | { type: "open-card" }
  | { type: "carry" }
  | { type: "reassign"; userId: string }
  | { type: "auto-merge" }
  | { type: "link-pr" }
  | { type: "fix-conflicts" }
  | { type: "fix-checks" }
  | { type: "submenu"; title: string; items: WheelItem[] }
  | { type: "global"; op: "new-card" | "refresh" | "workers" | "spot-checks" | "settings" | "debug" | "chat" }
  | { type: "board-mode"; mode: BoardMode }
  | { type: "track-pr"; pr: GithubPr }
  | { type: "start-linear"; identifier: string; repo: string | null }
  | { type: "linear-filter"; stateName: string };

export interface WheelItem {
  id: string;
  label: string;
  icon: string;
  accent?: string;
  action: WheelAction;
}

export interface WheelSpec {
  title: string;
  items: WheelItem[];
}

export function buildCardWheel(card: TaskCard, members: Member[]): WheelSpec {
  const items: WheelItem[] = [
    { id: "open", label: "Open card", icon: "📂", action: { type: "open-card" } },
    { id: "carry", label: "Carry (move status)", icon: "🦴", action: { type: "carry" } },
  ];
  const assignees = buildReassignChips(card, members);
  if (assignees.length > 0) {
    items.push({
      id: "reassign",
      label: "Reassign",
      icon: "👥",
      action: {
        type: "submenu",
        title: "Reassign to…",
        items: assignees.map((chip) => ({
          id: chip.id,
          label: chip.label,
          icon: "👤",
          action: { type: "reassign", userId: (chip.action as { type: "reassign"; userId: string }).userId },
        })),
      },
    });
  }
  if (canAutoMerge(card)) {
    items.push({
      id: "automerge",
      label: card.autoMergeEnabled ? "Auto-merge: on" : "Auto-merge: off",
      icon: "⚡",
      accent: card.autoMergeEnabled ? "#3ddc84" : undefined,
      action: { type: "auto-merge" },
    });
  }
  items.push({
    id: "linkpr",
    label: card.prNumber !== null ? `PR #${card.prNumber} linked` : "Link a PR",
    icon: "🔗",
    action: { type: "link-pr" },
  });
  if (hasConflicts(card)) items.push({ id: "fix-conflicts", label: "Fix conflicts", icon: "🧩", accent: "#ff8a5d", action: { type: "fix-conflicts" } });
  if (hasFailingChecks(card)) items.push({ id: "fix-checks", label: "Fix checks", icon: "🚑", accent: "#ff5d5d", action: { type: "fix-checks" } });
  return { title: card.title, items };
}

const BOARD_MODES: readonly BoardMode[] = ["me", "team", "automated"];
const BOARD_MODE_LABEL: Record<BoardMode, string> = { me: "Mine", team: "All team", automated: "Automated" };

export function buildGlobalWheel(boardMode: BoardMode): WheelSpec {
  return {
    title: "Manta",
    items: [
      { id: "new-card", label: "New card", icon: "✚", action: { type: "global", op: "new-card" } },
      { id: "refresh", label: "Refresh board", icon: "↻", action: { type: "global", op: "refresh" } },
      {
        id: "board-mode",
        label: `Scope: ${BOARD_MODE_LABEL[boardMode]}`,
        icon: "👁",
        action: {
          type: "submenu",
          title: "Board scope",
          items: BOARD_MODES.map((mode) => ({
            id: `mode:${mode}`,
            label: mode === boardMode ? `${BOARD_MODE_LABEL[mode]} ✓` : BOARD_MODE_LABEL[mode],
            icon: mode === "me" ? "🐶" : mode === "team" ? "👥" : "🤖",
            action: { type: "board-mode", mode },
          })),
        },
      },
      { id: "workers", label: "Workers", icon: "🤖", action: { type: "global", op: "workers" } },
      { id: "spot-checks", label: "Spot checks", icon: "🔭", action: { type: "global", op: "spot-checks" } },
      { id: "settings", label: "Settings", icon: "⚙️", action: { type: "global", op: "settings" } },
      { id: "debug", label: "Server logs", icon: "📡", action: { type: "global", op: "debug" } },
      { id: "chat", label: "Brain chat", icon: "🧠", action: { type: "global", op: "chat" } },
    ],
  };
}

/** Browse wheel for the PR depot — confirm = track as a card. */
export function buildPrDepotWheel(prs: GithubPr[]): WheelSpec {
  return {
    title: "Untracked PRs",
    items: prs.map((pr) => ({
      id: `pr:${pr.repo}#${pr.number}`,
      label: `#${pr.number} ${truncateLabel(pr.title, 30)}`,
      icon: "⬡",
      action: { type: "track-pr", pr },
    })),
  };
}

/** Browse wheel for the Linear yard: the tickets in the ACTIVE status filter,
 *  plus a "Showing: X" submenu to switch which status the yard displays. */
export function buildLinearDepotWheel(
  tickets: LinearTicket[],
  filters: { type: string; label: string; count: number }[],
  currentFilter: string,
): WheelSpec {
  const currentLabel = currentFilter;
  const items: WheelItem[] = tickets.map((t) => ({
    id: `linear:${t.identifier}`,
    label: `${t.identifier} ${truncateLabel(t.title, 26)}`,
    icon: "📋",
    action: { type: "start-linear", identifier: t.identifier, repo: t.repo },
  }));
  if (filters.length > 1 || tickets.length === 0) {
    items.push({
      id: "linear-filter",
      label: `Showing: ${currentLabel}`,
      icon: "🔀",
      accent: "#8a63ff",
      action: {
        type: "submenu",
        title: "Show tickets…",
        items: filters.map((f) => ({
          id: `filter:${f.label}`,
          label: `${f.label} (${f.count})${f.label === currentFilter ? " ✓" : ""}`,
          icon: "📋",
          action: { type: "linear-filter", stateName: f.label },
        })),
      },
    });
  }
  return { title: `Linear · ${currentLabel}`, items };
}

/** HUD label for a status a carried card would drop into. */
export function statusLabel(status: keyof typeof STATUS_LABELS): string {
  return STATUS_LABELS[status];
}
