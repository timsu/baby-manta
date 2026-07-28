interface ResumeTaskContext {
  title: string;
  repo: string;
  prNumber?: number | null;
  prUrl?: string | null;
  linearIssueIdentifier?: string | null;
  planDocument?: string | null;
}

interface ResumeMessageContext {
  role: string;
  content: string;
}

const DEFAULT_RESUME_INSTRUCTION = "Please continue where you left off.";
const MAX_RESUME_CONTEXT_CHARS = 24_000;
const RESUME_CONTEXT_PREFIX = "Resume this card. The previous worker may have disconnected";

function truncatePreservingEnds(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.6));
  const tail = Math.max(0, maxChars - head - 80);
  return `${text.slice(0, head).trimEnd()}\n\n[...omitted ${text.length - head - tail} characters from the middle...]\n\n${text.slice(-tail).trimStart()}`;
}

function priorUserInstructions(messages: ResumeMessageContext[]): string[] {
  return messages
    .filter((m) => m.role === "user" && m.content.trim())
    .map((m) => priorUserInstruction(m.content.trim()))
    .filter((content): content is string => Boolean(content));
}

function priorUserInstruction(content: string): string | null {
  if (!content.startsWith(RESUME_CONTEXT_PREFIX)) return content;

  // Resume prompts are themselves appended as user messages before dispatch. If
  // a card is resumed repeatedly, re-including the whole generated resume prompt
  // would recursively embed all older resume prompts and crowd out the original
  // task brief. Keep only any explicit human retry instruction from that prompt.
  const retryInstruction = /\n\nCurrent instruction:\n([\s\S]*?)\n\nCard title:/.exec(content)?.[1]?.trim();
  if (!retryInstruction || retryInstruction === DEFAULT_RESUME_INSTRUCTION) return null;
  return `Resume instruction: ${retryInstruction}`;
}

/**
 * Build a resurrection prompt that re-sends the durable card context. A worker can
 * disconnect after the server has marked a turn active but before Pi receives the
 * prompt (or before a resumed session has loaded the original prompt). In that
 * uncertain state, a bare "continue" asks the model to infer requirements from a
 * short title. Prefer a duplicate prompt: if the session already has the context,
 * this is harmless; if it does not, this is the authoritative task brief.
 */
export function buildWorkerResumeMessage(
  task: ResumeTaskContext,
  messages: ResumeMessageContext[],
  instruction?: string,
): string {
  const requestedInstruction = instruction?.trim() || DEFAULT_RESUME_INSTRUCTION;
  const priorInstructions = priorUserInstructions(messages);
  const context = priorInstructions.length > 0
    ? priorInstructions.map((content, index) => `### User instruction ${index + 1}\n${content}`).join("\n\n")
    : "No prior user instruction was found in the transcript. Use the card title/repo and ask for clarification if requirements are missing.";

  const prLine = task.prNumber ? `\nExisting PR: #${task.prNumber}${task.prUrl ? ` (${task.prUrl})` : ""}` : "";
  const linearLine = task.linearIssueIdentifier ? `\nLinear issue: ${task.linearIssueIdentifier}` : "";
  const planSection = task.planDocument?.trim()
    ? `\n\nApproved plan document:\n\n${task.planDocument.trim()}`
    : "";

  return truncatePreservingEnds(`${RESUME_CONTEXT_PREFIX} before receiving the full task context, so the durable context is included again below. If this duplicates context already in your session, treat the repeated context as authoritative and continue from the current repo/worktree state; do not infer requirements from the short title alone.\n\nCurrent instruction:\n${requestedInstruction}\n\nCard title: ${task.title}\nRepo: ${task.repo}${prLine}${linearLine}${planSection}\n\nPrior user instructions for this card (oldest to newest):\n\n${context}`, MAX_RESUME_CONTEXT_CHARS);
}
