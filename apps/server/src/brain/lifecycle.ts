// Pure brain turn-lifecycle logic — the parts of the brain that need no DB, no
// network, and no credentials, so they can be fully unit-tested in isolation.
// The Pi-wired turn runner (Phase 3, after auth + DB) composes these helpers.
//
// Covers spec §6.1 (system-prompt composition), §6.3 (inbox drain), §6.5
// (sleep/wake), and §14.3 (message compaction).

// ─────────────────────── §6.1 System-prompt composition ───────────────────────

export interface PromptParts {
  /** Per-workspace base brain prompt (brain.md equivalent), hot-reloaded. */
  basePrompt: string;
  /** Team-wide memory (memory.md). May be empty. */
  teamMemory?: string;
  /** Acting member's personal memory (memory.local.md). May be empty. */
  personalMemory?: string;
  /** Active theme block (voice + character roster), if any. */
  themeBlock?: string;
  /** Enabled workspace repositories the brain can target with worker tools. */
  workspaceRepos?: Array<{ orgRepo: string; defaultBranch?: string }>;
  /** Slack origin context, if this turn was triggered from Slack. */
  slackContext?: { channel: string; threadTs: string; user: string; threadMessages?: string };
}

export const ATTACHMENT_GROUNDING_PROMPT = `## Visible-context and attachment grounding

Treat the current visible user message and any attachments/images in it as the primary evidence. Background inbox items, Scout/Linear/poller notes, Slack thread history, and other hidden context are lower-priority hints only; never assume they are visible to the user unless the current message explicitly references or includes them.

If the user provides an attachment/screenshot and uses ambiguous language like "this", "it", "that", "same thing", or "looks like it happened again", inspect and ground your response in the visible attachment/current UI context before escalating. Do not create Linear issues, assign people, create/spawn worker cards, message workers, or otherwise take side effects until you can cite concrete visible evidence from the attachment/current message; if you cannot inspect it or the evidence is unclear, ask a clarification first.`;

/**
 * Compose the brain system prompt fresh for a turn. Order matters: base rules
 * first, then memory, then personal preferences (override team), then theme,
 * then ephemeral Slack context last. Sections are omitted when empty so the
 * prompt stays tight. Deterministic given inputs → testable.
 */
export function composeBrainPrompt(parts: PromptParts): string {
  const sections: string[] = [parts.basePrompt.trim(), ATTACHMENT_GROUNDING_PROMPT];

  if (parts.teamMemory?.trim()) {
    sections.push(`## Team Memory\n\n${parts.teamMemory.trim()}`);
  }
  if (parts.personalMemory?.trim()) {
    sections.push(`## Personal Preferences (this engineer)\n\n${parts.personalMemory.trim()}`);
  }
  if (parts.themeBlock?.trim()) {
    sections.push(parts.themeBlock.trim());
  }
  if (parts.workspaceRepos?.length) {
    const inventory = parts.workspaceRepos
      .map((repo) => `- ${repo.orgRepo}${repo.defaultBranch ? ` (default branch ${repo.defaultBranch.replace(/[\r\n]/g, " ")})` : ""}`)
      .join("\n");
    sections.push(`## Workspace repository inventory\n\nUse this configured repository inventory to select the relevant repo for an issue when the request provides enough context; do not ask for a repo that is already identifiable here. For code changes, use create_task with one of these exact slugs. For code questions, use answer_question.\n${inventory}`);
  }
  if (parts.slackContext) {
    const { channel, threadTs, user, threadMessages } = parts.slackContext;
    sections.push(`[Slack context: channel=${channel}, thread_ts=${threadTs}, user=${user}]`);
    if (threadMessages?.trim()) {
      sections.push(`## Slack thread history\n\n${threadMessages.trim()}`);
    }
  }
  return sections.join("\n\n");
}

// ─────────────────────────────── §6.3 Inbox ───────────────────────────────

export type InboxSource = "poller" | "worker" | "peer" | "perm_session" | "linear" | "slack";

export interface InboxItem {
  id: string;
  body: string;
  source: InboxSource;
  /** Unix ms; used only for stable ordering. */
  createdAt: number;
}

export interface DrainedInbox {
  /** Text to prepend to the user message for the turn ("" if nothing pending). */
  prependText: string;
  /** Ids to mark consumed (atomically) once the turn is dispatched. */
  consumedIds: string[];
}

function sourceLabel(source: InboxSource): string {
  switch (source) {
    case "slack": return "Slack";
    case "linear": return "Linear";
    case "poller": return "background poller";
    case "worker": return "worker";
    case "peer": return "peer session";
    case "perm_session": return "permanent session";
  }
}

function formatInboxItem(i: InboxItem): string {
  return `[Hidden background context from ${sourceLabel(i.source)} — lower priority than the current visible user message and attachments; do not assume the user can see it unless explicitly surfaced]\n${i.body}`;
}

/**
 * Drain pending inbox items into a single prepended block, oldest first (stable
 * by createdAt then id). Returns the ids to mark consumed so the caller can do
 * the DB write atomically. Empty input → empty prepend, no consumed ids.
 */
export function drainInbox(items: readonly InboxItem[]): DrainedInbox {
  if (items.length === 0) return { prependText: "", consumedIds: [] };
  const ordered = [...items].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id),
  );
  const prependText = ordered.map(formatInboxItem).join("\n\n");
  return { prependText, consumedIds: ordered.map((i) => i.id) };
}

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const ATTACHMENT_REF_RE = /\b(this|it|that|these|those|same thing|again|happened again|looks like|screenshot|screen shot|image|attachment|attached)\b/i;

export function visibleAttachmentUrls(message: string): string[] {
  return [...message.matchAll(IMAGE_MARKDOWN_RE)].map((m) => m[1]).filter((u): u is string => Boolean(u));
}

export function isAmbiguousAttachmentRequest(message: string): boolean {
  return visibleAttachmentUrls(message).length > 0 && ATTACHMENT_REF_RE.test(message);
}

/** Combine drained inbox text with the user message (inbox first, §6.2). */
export function buildTurnInput(drained: DrainedInbox, userMessage: string): string {
  if (!drained.prependText) return userMessage;
  if (!userMessage) return drained.prependText;
  return `${drained.prependText}\n\n${userMessage}`;
}

// ─────────────────────────────── §6.5 Sleep/wake ───────────────────────────────

export const MAX_SLEEP_SECONDS = 600;

/** Clamp a requested sleep to [1, MAX_SLEEP_SECONDS] and compute the wake time. */
export function computeWake(now: Date, requestedSeconds: number): { wakeAt: Date; seconds: number } {
  const seconds = Math.max(1, Math.min(MAX_SLEEP_SECONDS, Math.floor(requestedSeconds)));
  return { wakeAt: new Date(now.getTime() + seconds * 1000), seconds };
}

/**
 * Whether a pending sleep should be cancelled in favor of running now. Any
 * inbound user message cancels the timer (§6.5); a scheduled wake firing does
 * not "cancel" — it proceeds.
 */
export function shouldCancelSleep(trigger: "user_message" | "wake_timer" | "inbox_push"): boolean {
  return trigger === "user_message" || trigger === "inbox_push";
}

// ─────────────────────────────── §14.3 Compaction ───────────────────────────────

export interface CompactableMessage {
  role: "user" | "assistant" | "status" | "system";
  content: string;
}

export interface CompactionPolicy {
  /** Compact once history exceeds this many messages. */
  threshold: number;
  /** How many of the oldest messages to collapse into one summary. */
  collapse: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = { threshold: 150, collapse: 50 };

export interface CompactionPlan {
  shouldCompact: boolean;
  /** The oldest messages to summarize (empty when shouldCompact is false). */
  toSummarize: CompactableMessage[];
  /** The messages to keep verbatim after the summary. */
  tail: CompactableMessage[];
}

/**
 * Decide whether/what to compact (spec §14.3): when history exceeds `threshold`,
 * the oldest `collapse` messages are summarized into a single assistant
 * "Session summary" message and the rest kept. The *summary text* is produced
 * by the agent elsewhere; this function is the pure decision + slicing so it can
 * be tested without an LLM.
 */
export function planCompaction(
  messages: readonly CompactableMessage[],
  policy: CompactionPolicy = DEFAULT_COMPACTION,
): CompactionPlan {
  if (messages.length <= policy.threshold) {
    return { shouldCompact: false, toSummarize: [], tail: [...messages] };
  }
  const toSummarize = messages.slice(0, policy.collapse);
  const tail = messages.slice(policy.collapse);
  return { shouldCompact: true, toSummarize, tail };
}

/** Apply a compaction plan given a produced summary, returning the new history. */
export function applyCompaction(plan: CompactionPlan, summaryText: string): CompactableMessage[] {
  if (!plan.shouldCompact) return plan.tail;
  const summary: CompactableMessage = {
    role: "assistant",
    content: `## Session summary\n\n${summaryText}`,
  };
  return [summary, ...plan.tail];
}
