// Maps a world interactable (what the dog pressed E on) to a GameAction, and
// dispatches actions against handlers supplied by Shell. Cards and depots are
// handled directly in GameCanvas (wheel/carry); app-level operations dispatch
// through the wheel executor — both use the same GameHandlers, so game mode
// reuses — never forks — app behavior.

import type { GameAction, Interactable } from "./types.ts";

export function actionForInteractable(it: Interactable): GameAction | null {
  switch (it.kind) {
    case "question":
      return it.data?.taskId ? { type: "open-task", taskId: it.data.taskId } : null;
    case "workspace":
      return it.data?.workspaceId ? { type: "switch-workspace", workspaceId: it.data.workspaceId } : null;
    case "github-pr":
      return it.data?.pr ? { type: "track-pr", pr: it.data.pr } : null;
    case "linear-ticket":
      return it.data?.linearIdentifier
        ? {
            type: "new-card",
            prompt: `Work on ${it.data.linearIdentifier}`,
            repo: it.data.repo ?? undefined,
            linearIssueIdentifier: it.data.linearIdentifier,
          }
        : null;
    default:
      return null; // cards + depots are wheel/carry territory
  }
}

/** Shell-provided handlers — the exact callbacks the 2D board uses. */
export interface GameHandlers {
  openTask: (taskId: string) => void;
  openNewCard: (initial?: { prompt?: string; repo?: string | null; linearIssueIdentifier?: string | null }) => void;
  openWorkers: () => void;
  openSettings: () => void;
  openDebug: () => void;
  toggleSpotChecks: () => void;
  refresh: () => void;
  toggleChat: () => void;
  switchWorkspace: (workspaceId: string) => void;
  trackPr: (pr: { repo: string; number: number; title: string; url: string; branch: string; state: string }) => void;
}

export function dispatchGameAction(action: GameAction, handlers: GameHandlers): void {
  switch (action.type) {
    case "open-task":
      handlers.openTask(action.taskId);
      return;
    case "new-card":
      handlers.openNewCard({
        prompt: action.prompt,
        repo: action.repo ?? null,
        linearIssueIdentifier: action.linearIssueIdentifier,
      });
      return;
    case "switch-workspace":
      handlers.switchWorkspace(action.workspaceId);
      return;
    case "track-pr":
      handlers.trackPr(action.pr);
      return;
  }
}
