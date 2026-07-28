// nanostores app state. WS streaming (Phase 5) will push into $cards/chat; for
// now they're populated by REST calls after actions.

import { atom } from "nanostores";
import type { Me, TaskCard, Repo, GithubPr, Member, LinearTicket, ModelInfo } from "./api.ts";
import type { AskQuestion } from "@manta/shared";

/** undefined = still loading; null = signed out; Me = signed in. */
export const $me = atom<Me | null | undefined>(undefined);

/** Active workspace id (the board/chat target). */
export const $activeWorkspaceId = atom<string | null>(null);

/** Board scope: "me" shows just my cards + PRs; "team" shows everyone in swimlanes; "automated" shows hidden background-worker cards. */
export type BoardMode = "me" | "team" | "automated";
const storedBoardMode = (() => {
  try { return localStorage.getItem("manta:boardMode"); } catch { return null; }
})();
export const $boardMode = atom<BoardMode>(storedBoardMode === "team" ? "team" : storedBoardMode === "automated" || storedBoardMode === "scheduled" || storedBoardMode === "spot_checks" ? "automated" : "me");
$boardMode.listen((v) => { try { localStorage.setItem("manta:boardMode", v); } catch { /* ignore */ } });

/** Members of the active workspace (for team-mode swimlanes + avatars). */
export const $members = atom<Member[]>([]);

/** Board cards for the active workspace. */
export const $cards = atom<TaskCard[]>([]);

/** Open GitHub PRs not tracked as Manta cards. */
export const $githubPrs = atom<GithubPr[]>([]);

/** Not-completed Linear tickets assigned to the signed-in user. */
export const $linearTickets = atom<LinearTicket[]>([]);

/** Repos defined in the active workspace. */
export const $repos = atom<Repo[]>([]);

/** Available models for the active workspace (used in the model switcher). */
export const $workspaceModels = atom<ModelInfo[]>([]);
/** Workspace default model, used to initialize model pickers. */
export const $workspaceDefaultModel = atom<string | null>(null);

/** A chat turn is in flight (the brain is thinking). */
export const $thinking = atom<boolean>(false);

export interface ChatLine {
  role: "user" | "assistant" | "status" | "tool" | "thinking" | "setup";
  text: string;
  /** For tool lines: the args/params preview shown when expanded. */
  argsPreview?: string;
}
export const $chat = atom<ChatLine[]>([]);

/** The task whose detail view is open (null = board). */
export const $openTaskId = atom<string | null>(null);
/**
 * Streamed worker transcripts keyed by task id. Each card owns its own slot, so
 * a stream for one card can never bleed into another's view — cards and their
 * chats are modular by construction (mirrors $taskContextUsage). Reading the
 * open card's transcript is `$taskChats.get()[taskId] ?? []`.
 */
export const $taskChats = atom<Record<string, ChatLine[]>>({});
/** Per-card "a worker turn is in flight" flags, keyed by task id. */
export const $taskThinkingByCard = atom<Record<string, boolean>>({});

/** Read one card's transcript (empty when the card has no streamed lines yet). */
export function getTaskChat(taskId: string): ChatLine[] {
  return $taskChats.get()[taskId] ?? [];
}

/** Replace one card's transcript without touching any other card's slot. */
export function setTaskChat(taskId: string, lines: ChatLine[]): void {
  $taskChats.set({ ...$taskChats.get(), [taskId]: lines });
}

/** Read one card's in-flight flag. */
export function getTaskThinking(taskId: string): boolean {
  return $taskThinkingByCard.get()[taskId] ?? false;
}

/** Set one card's in-flight flag, leaving every other card's flag untouched. */
export function setTaskThinking(taskId: string, value: boolean): void {
  const cur = $taskThinkingByCard.get();
  if ((cur[taskId] ?? false) === value) return;
  $taskThinkingByCard.set({ ...cur, [taskId]: value });
}

/** Drop all per-card chat state (e.g. when switching workspaces). */
export function resetAllTaskChats(): void {
  $taskChats.set({});
  $taskThinkingByCard.set({});
}
/** Set to taskId when the server emits task_updated — triggers detail reload. */
export const $lastTaskUpdated = atom<string | null>(null);

export interface Toast {
  id: number;
  msg: string;
  type: "error" | "info";
  action?: { label: string; onClick: () => void };
}
export const $toasts = atom<Toast[]>([]);

const storedMantaHidden = (() => {
  try {
    const stored = localStorage.getItem("manta:blackMantaHidden");
    return stored === null ? true : stored === "true";
  } catch { return true; }
})();
export const $mantaHidden = atom<boolean>(storedMantaHidden);
$mantaHidden.listen((hidden) => {
  try { localStorage.setItem("manta:blackMantaHidden", hidden ? "true" : "false"); } catch { /* ignore */ }
});

let _toastId = 0;
export function addToast(msg: string, type: Toast["type"] = "info", action?: Toast["action"], duration = 4500) {
  const id = ++_toastId;
  $toasts.set([...$toasts.get(), { id, msg, type, action }]);
  setTimeout(() => { $toasts.set($toasts.get().filter((t) => t.id !== id)); }, duration);
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

/** Brain context usage (tokens / contextWindow / percent) from the Pi session. */
export const $brainContextUsage = atom<ContextUsage | null>(null);

/** Worker context usage keyed by task id. */
export const $taskContextUsage = atom<Record<string, ContextUsage>>({});

export interface PendingUserQuestion {
  questionId: string;
  taskId: string;
  ownerUserId: string | null;
  questions: AskQuestion[];
}

/** Worker ask_user_question prompts awaiting the user's answer. */
export const $pendingUserQuestions = atom<PendingUserQuestion[]>([]);
