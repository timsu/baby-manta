// The brain turn runner — composes the lifecycle helpers, the agent backend,
// the tool registry, and the message store into one turn (spec §6.2). It is
// backend-agnostic (Pi in prod, ScriptedBackend in tests) and location-agnostic
// (the same shape will drive worker turns). Live broadcast is an injected
// callback so the WS hub (Phase 5) plugs in without the runner knowing about it.
//
// Sleep/wake scheduling and inbox-consumption persistence are the caller's job
// (they touch pg-boss + the inbox table); the runner returns what it consumed so
// the caller can commit those atomically.

import type { AgentBackend, ToolDefinition, SlackOrigin, CreatedTaskSummary } from "@manta/agent";
import type { AgentEvent } from "@manta/shared";
import { cardImages, messages, type WorkspaceScope } from "@manta/db";
import {
  composeBrainPrompt,
  drainInbox,
  buildTurnInput,
  visibleAttachmentUrls,
  isAmbiguousAttachmentRequest,
  type PromptParts,
  type InboxItem,
} from "./lifecycle.ts";
import { resolveMessageImageAttachments } from "./imageAttachments.ts";

export interface RunBrainTurnInput {
  scope: WorkspaceScope;
  /** Channel to run on; "brain" for the orchestrator. */
  channel: string;
  /** The inbound user message (raw, as the human typed it). */
  userMessage: string;
  backend: AgentBackend;
  /** The task/brain's pinned backend/model selector (e.g. "pi-openai-codex:gpt-5.5"). Passed
   * to the backend to resolve the model. Defaults to the backend's own id. */
  backendId?: string;
  tools: ToolDefinition[];
  promptParts: PromptParts;
  /** Pending inbox items to fold into this turn (already fetched by the caller). */
  inbox?: InboxItem[];
  /** Acting user, when human-triggered. */
  userId?: string;
  /** Slack origin, when this turn was triggered by a Slack request. Threaded into
   * the tool context so create_task can attribute + stamp the card. */
  slackOrigin?: SlackOrigin;
  /** Live event sink (WS broadcast). Optional so the runner is testable headless. */
  onEvent?: (event: AgentEvent) => void;
  /** Resume a prior agent session (Pi JSONL key) for conversation continuity. */
  resumeFrom?: string;
  /** Called when a fresh session is created so the caller can persist its key. */
  onSession?: (sessionKey: string) => void | Promise<void>;
  signal?: AbortSignal;
  /** When true, skip persisting the user message (caller already persisted it synchronously). */
  skipUserMessagePersist?: boolean;
  /** When true, skip persisting the assistant result (for dry-run previews). */
  skipAssistantMessagePersist?: boolean;
}

export interface BrainTurnResult {
  events: AgentEvent[];
  assistantText: string;
  createdTasks: CreatedTaskSummary[];
  /** Inbox item ids the caller should now mark consumed. */
  consumedInboxIds: string[];
  /** Terminal reason from the backend's `done` event, if any. */
  terminalReason?: string;
}

/**
 * Run one brain turn: drain inbox → persist the user message → compose the
 * system prompt → stream the backend (which owns tool execution) → persist the
 * assistant message. Returns the collected events + what to mark consumed.
 */
export async function runBrainTurn(input: RunBrainTurnInput): Promise<BrainTurnResult> {
  const { scope, channel, backend, tools } = input;

  const drained = drainInbox(input.inbox ?? []);
  const resolvedUserMessage = await resolveMessageImageAttachments(input.userMessage, {
    workspaceId: scope.workspaceId,
    getImage: (id) => cardImages.get(id),
  });
  const turnInput = buildTurnInput(drained, resolvedUserMessage);
  const attachmentUrls = visibleAttachmentUrls(resolvedUserMessage);

  // Persist the user's message as they said it (inbox items are context, not
  // part of the user's turn text).
  if (input.userMessage && !input.skipUserMessagePersist) {
    await messages.append(scope, { channel, role: "user", content: input.userMessage });
  }

  const systemPrompt = composeBrainPrompt(input.promptParts);

  const events: AgentEvent[] = [];
  let assistantText = "";
  let terminalReason: string | undefined;
  const turnState: { createdTasks?: CreatedTaskSummary[]; linearSupportTriage?: boolean } = {};

  for await (const event of backend.runTurn({
    systemPrompt,
    message: turnInput,
    tools,
    backend: input.backendId ?? backend.id,
    ctx: {
      workspaceId: scope.workspaceId,
      channel,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.slackOrigin ? { slackOrigin: input.slackOrigin } : {}),
      currentUserMessage: input.userMessage,
      visibleAttachmentUrls: attachmentUrls,
      ambiguousAttachmentRequest: isAmbiguousAttachmentRequest(input.userMessage),
      turnState,
    },
    ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
    ...(input.onSession ? { onSession: input.onSession } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })) {
    events.push(event);
    input.onEvent?.(event);
    if (event.type === "text") assistantText += event.text;
    else if (event.type === "done") terminalReason = event.reason;
  }

  // Persist the assistant turn (text + a compact tool-call trace for replay).
  const toolTrace = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_use" }> => e.type === "tool_use")
    .map((e) => ({ tool: e.toolName, args: e.argsPreview }));
  if (!input.skipAssistantMessagePersist) {
    await messages.append(scope, {
      channel,
      role: "assistant",
      content: assistantText,
      ...(toolTrace.length ? { meta: { tools: toolTrace } } : {}),
    });
  }

  return {
    events,
    assistantText,
    createdTasks: turnState.createdTasks ?? [],
    consumedInboxIds: drained.consumedIds,
    ...(terminalReason ? { terminalReason } : {}),
  };
}
