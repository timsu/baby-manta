import { describe, expect, it, vi } from "vitest";
import { actionForInteractable, dispatchGameAction, type GameHandlers } from "./gameActions.ts";
import { makePr } from "./testFixtures.ts";
import type { Interactable } from "./types.ts";

function handlers(): GameHandlers {
  return {
    openTask: vi.fn(),
    openNewCard: vi.fn(),
    openWorkers: vi.fn(),
    openSettings: vi.fn(),
    openDebug: vi.fn(),
    toggleSpotChecks: vi.fn(),
    refresh: vi.fn(),
    toggleChat: vi.fn(),
    switchWorkspace: vi.fn(),
    trackPr: vi.fn(),
  };
}

describe("actionForInteractable", () => {
  it("maps a question beacon to open-task", () => {
    const it_: Interactable = { id: "question:t1", kind: "question", label: "x", x: 0, z: 0, data: { taskId: "t1" } };
    expect(actionForInteractable(it_)).toEqual({ type: "open-task", taskId: "t1" });
  });

  it("returns null for cards and depots — those are wheel/carry territory", () => {
    expect(actionForInteractable({ id: "card:a", kind: "card", label: "x", x: 0, z: 0, data: { taskId: "a" } })).toBeNull();
    expect(actionForInteractable({ id: "depot:github-prs", kind: "pr-depot", label: "x", x: 0, z: 0 })).toBeNull();
    expect(actionForInteractable({ id: "depot:linear", kind: "linear-depot", label: "x", x: 0, z: 0 })).toBeNull();
  });

  it("maps a linear ticket sample to a prefilled new-card (same prompt as the 2D board)", () => {
    const it_: Interactable = {
      id: "linear:ENG-7", kind: "linear-ticket", label: "x", x: 0, z: 0,
      data: { linearIdentifier: "ENG-7", repo: "org/repo" },
    };
    expect(actionForInteractable(it_)).toEqual({
      type: "new-card",
      prompt: "Work on ENG-7",
      repo: "org/repo",
      linearIssueIdentifier: "ENG-7",
    });
  });

  it("maps portals and PR samples to their operations", () => {
    expect(actionForInteractable({ id: "workspace:w2", kind: "workspace", label: "x", x: 0, z: 0, data: { workspaceId: "w2" } }))
      .toEqual({ type: "switch-workspace", workspaceId: "w2" });
    const pr = makePr({ number: 5 });
    expect(actionForInteractable({ id: "github-pr:x#5", kind: "github-pr", label: "x", x: 0, z: 0, data: { pr } }))
      .toEqual({ type: "track-pr", pr });
  });
});

describe("dispatchGameAction", () => {
  it("routes open-task to the Shell handler", () => {
    const h = handlers();
    dispatchGameAction({ type: "open-task", taskId: "t9" }, h);
    expect(h.openTask).toHaveBeenCalledWith("t9");
  });

  it("routes track-pr with the full PR payload", () => {
    const h = handlers();
    const pr = makePr({ number: 5 });
    dispatchGameAction({ type: "track-pr", pr }, h);
    expect(h.trackPr).toHaveBeenCalledWith(pr);
  });

  it("routes switch-workspace and prefilled new-card", () => {
    const h = handlers();
    dispatchGameAction({ type: "switch-workspace", workspaceId: "ws-2" }, h);
    expect(h.switchWorkspace).toHaveBeenCalledWith("ws-2");
    dispatchGameAction({ type: "new-card", prompt: "p", repo: "r", linearIssueIdentifier: "ENG-1" }, h);
    expect(h.openNewCard).toHaveBeenCalledWith({ prompt: "p", repo: "r", linearIssueIdentifier: "ENG-1" });
  });
});
