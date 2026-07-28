// Card operations for the 3D world — the exact api calls, optimistic updates,
// and toasts the 2D board uses, minus any DOM. The ring-chip builders are pure
// so unit tests can assert the full action surface per card state.

import { COLUMNS, isUserDragAllowed, STATUS_LABELS, type CardStatus } from "@manta/shared";
import { api, type Member, type TaskCard } from "../api.ts";
import { $cards, addToast } from "../stores.ts";
import { refreshTasks } from "../actions.ts";

export type RingAction =
  | { type: "reassign-menu" }
  | { type: "reassign"; userId: string }
  | { type: "auto-merge" }
  | { type: "link-pr" }
  | { type: "fix-conflicts" }
  | { type: "fix-checks" };

export interface CardRingChip {
  id: string;
  label: string;
  accent?: string;
  action: RingAction;
}

export function memberDisplayName(m: Member): string {
  return m.name?.trim() || m.email;
}

export function canAutoMerge(card: TaskCard): boolean {
  return card.prNumber !== null && card.cardStatus !== "done" && card.cardStatus !== "canceled" && card.prState !== "closed";
}

export function hasConflicts(card: TaskCard): boolean {
  return card.prNumber !== null && card.mergeable === "CONFLICTING" && card.cardStatus !== "bot_working";
}

export function hasFailingChecks(card: TaskCard): boolean {
  return card.prNumber !== null && card.checksStatus === "failing" && card.cardStatus !== "bot_working";
}

/** Statuses the card may be carried to — identical to 2D drag affordances. */
export function carryTargets(card: TaskCard): CardStatus[] {
  return COLUMNS
    .filter((c) => c.status !== card.cardStatus && isUserDragAllowed(card.cardStatus, c.status, { hasPr: card.prNumber !== null, isPrOnly: false, isPrDraft: false }))
    .map((c) => c.status);
}

/** The floating action chips shown around a kiosk on R. */
export function buildCardRingChips(card: TaskCard, members: Member[]): CardRingChip[] {
  const chips: CardRingChip[] = [];
  if (members.length > 1) chips.push({ id: "reassign", label: "Reassign…", action: { type: "reassign-menu" } });
  if (canAutoMerge(card)) {
    chips.push({
      id: "automerge",
      label: card.autoMergeEnabled ? "Auto-merge: on" : "Auto-merge: off",
      accent: card.autoMergeEnabled ? "#3ddc84" : undefined,
      action: { type: "auto-merge" },
    });
  }
  chips.push({
    id: "linkpr",
    label: card.prNumber !== null ? `PR #${card.prNumber} linked` : "Link PR…",
    action: { type: "link-pr" },
  });
  if (hasConflicts(card)) chips.push({ id: "fix-conflicts", label: "Fix conflicts", accent: "#ff8a5d", action: { type: "fix-conflicts" } });
  if (hasFailingChecks(card)) chips.push({ id: "fix-checks", label: "Fix checks", accent: "#ff5d5d", action: { type: "fix-checks" } });
  return chips;
}

/** Second-level ring after choosing Reassign. */
export function buildReassignChips(card: TaskCard, members: Member[]): CardRingChip[] {
  return members
    .filter((m) => m.userId !== card.createdBy)
    .map((m) => ({ id: `assign:${m.userId}`, label: memberDisplayName(m), action: { type: "reassign", userId: m.userId } as const }));
}

export async function doTransition(workspaceId: string, card: TaskCard, to: CardStatus): Promise<boolean> {
  try {
    // Same doneReason rule as the 2D board's drag handler (Board.tsx).
    const doneReason = to === "done" ? (card.cardStatus === "investigation_complete" ? "completed" : "abandoned") : undefined;
    await api.transitionStatus(workspaceId, card.id, to, doneReason);
    await refreshTasks();
    addToast(`Moved to ${STATUS_LABELS[to]}.`, "info");
    return true;
  } catch (err) {
    addToast(err instanceof Error ? err.message : "Failed to move card", "error");
    return false;
  }
}

export async function doReassign(workspaceId: string, card: TaskCard, member: Member): Promise<void> {
  if (card.createdBy === member.userId) return;
  const snapshot = $cards.get();
  $cards.set(snapshot.map((c) => c.id === card.id ? { ...c, createdBy: member.userId } : c));
  try {
    await api.reassignTask(workspaceId, card.id, member.userId);
    await refreshTasks();
    addToast(`Reassigned to ${memberDisplayName(member)}.`, "info");
  } catch (err) {
    const prev = snapshot.find((c) => c.id === card.id);
    if (prev) $cards.set($cards.get().map((c) => c.id === card.id ? prev : c));
    addToast(err instanceof Error ? err.message : "Failed to reassign card", "error");
  }
}

export async function doAutoMerge(workspaceId: string, card: TaskCard): Promise<void> {
  const enabled = !card.autoMergeEnabled;
  const snapshot = $cards.get();
  $cards.set(snapshot.map((c) => c.id === card.id ? { ...c, autoMergeEnabled: enabled } : c));
  try {
    await api.setAutoMerge(workspaceId, card.id, enabled);
    await refreshTasks();
    addToast(enabled ? "Auto-merge on." : "Auto-merge off.", "info");
  } catch (err) {
    const prev = snapshot.find((c) => c.id === card.id);
    if (prev) $cards.set($cards.get().map((c) => c.id === card.id ? prev : c));
    addToast(err instanceof Error ? err.message : "Failed to update auto-merge", "error");
  }
}

export async function doLinkPr(workspaceId: string, card: TaskCard): Promise<void> {
  const prUrl = window.prompt("Paste the GitHub PR URL", card.prUrl ?? "")?.trim();
  if (!prUrl) return;
  try {
    await api.linkTaskPr(workspaceId, card.id, prUrl);
    await refreshTasks();
    addToast("Linked PR to card.", "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to link PR";
    addToast({
      invalid_github_pr_url: "Paste a GitHub PR URL like https://github.com/org/repo/pull/123",
      pr_repo_mismatch: "That PR belongs to a different repo than this card.",
      pr_already_linked: "That PR is already linked to another card.",
    }[message] ?? message, "error");
  }
}

export async function doFix(workspaceId: string, card: TaskCard, kind: "conflicts" | "checks"): Promise<void> {
  try {
    await (kind === "conflicts" ? api.fixConflicts(workspaceId, card.id) : api.fixChecks(workspaceId, card.id));
    await refreshTasks();
    addToast(kind === "conflicts" ? "Asked the worker to fix conflicts." : "Asked the worker to fix checks.", "info");
  } catch (err) {
    addToast(err instanceof Error ? err.message : `Failed to fix ${kind}`, "error");
  }
}
