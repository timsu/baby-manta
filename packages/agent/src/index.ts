// The agent abstraction — the seam that makes the backend (Pi primary, Claude
// optional) swappable and the runtime location (in-server brain vs. in-sandbox
// worker) irrelevant to callers. Models the prototype's `pi-session.ts` /
// `pi.ts`, generalized so brain, workers, and permanent sessions share it.
//
// "One call = one turn." A turn takes a system prompt + tools + a user message
// + optional prior-session handle, and yields a stream of AgentEvents,
// terminating with `done` (or `error`). Session continuity is a blob (Pi JSONL)
// the caller persists and passes back.

import type { AgentEvent } from "@manta/shared";

/** Canonical task fields a tool can record during a turn so callers can build
 * deterministic follow-up messaging from the stored task record instead of the
 * model's freeform memory. */
export interface CreatedTaskSummary {
  id: string;
  title: string;
  repo: string;
  cardStatus: string;
  taskNumber: number | null;
  reusedExisting?: boolean;
}

export interface TurnState {
  createdTasks?: CreatedTaskSummary[];
  /** Set after the brain performs support-triage duplicate lookup in a Slack turn. */
  linearSupportTriage?: boolean;
}

/** A tool the agent can call. The handler runs control-plane logic and returns
 * a JSON-serializable result that becomes the tool_result. */
export interface ToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  /** JSON Schema for the args (validated before the handler runs). */
  parameters: Record<string, unknown>;
  handler: (args: Args, ctx: ToolContext) => Promise<Result> | Result;
}

/**
 * Author a tool with typed args while storing it type-erased. Tool args arrive
 * already validated against `parameters` (JSON Schema) by the agent loop, so the
 * handler can trust the shape; this helper lets authors write `(args: MyArgs)`
 * and still collect tools into a `ToolDefinition[]` (whose handler arg is
 * `unknown` — function-param variance otherwise rejects the specific types).
 */
export function defineTool<A = unknown, R = unknown>(def: ToolDefinition<A, R>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** Context passed to every tool handler. Always carries the workspace scope so
 * tools can never act cross-workspace. */
export interface ToolContext {
  workspaceId: string;
  /** The channel this turn is running on (brain, <taskId>, scout, ...). */
  channel: string;
  /** Acting user, when the turn was triggered by a human. */
  userId?: string;
  /** Slack origin, present when the turn was triggered by a Slack request. Lets
   * task-creating tools stamp the card so the outbound notifier replies in-thread. */
  slackOrigin?: SlackOrigin;
  /** The visible user-authored message that started this turn, without hidden inbox context. */
  currentUserMessage?: string;
  /** Attachment/image URLs explicitly visible in the current user message. */
  visibleAttachmentUrls?: string[];
  /** True when the visible message references an attachment ambiguously ("this", "it", "again", etc.). */
  ambiguousAttachmentRequest?: boolean;
  /** Mutable per-turn state shared across tool calls in one run. */
  turnState?: TurnState;
}

/** Where a Slack-originated turn came from, threaded into tool context. */
export interface SlackOrigin {
  channel: string;
  threadTs?: string;
  slackUserId?: string;
  slackBotId?: string;
}

export interface RunTurnInput {
  /** Fully composed system prompt (hot-reloaded upstream each turn). */
  systemPrompt: string;
  /** The user/inbound message text for this turn. */
  message: string;
  /** Tools available this turn. */
  tools: ToolDefinition[];
  /** Backend id, e.g. "pi-openai-codex:gpt-5.5". */
  backend: string;
  ctx: ToolContext;
  /** Opaque handle to a prior session (Pi JSONL blob key); omit to start fresh. */
  resumeFrom?: string;
  /** When `resumeFrom` is missing or points at a file absent on this venue, fall
   * back to resuming the most-recent session that already exists for this turn's
   * cwd instead of forking a brand-new one. Only safe when the cwd is unique to a
   * single logical conversation (e.g. a worker task's own git worktree) — never
   * set this for the brain, whose channels share one process cwd. */
  resumeRecentForCwd?: boolean;
  /** Aborts the in-flight turn. */
  signal?: AbortSignal;
  /** Called once when a new session blob is created, so the caller can persist it. */
  onSession?: (sessionKey: string) => void | Promise<void>;
}

/** A backend implements this. Pi is the production backend. The
 * server brain and the sandbox worker-runner both drive turns through an
 * AgentBackend — only the *location* differs. */
export interface AgentBackend {
  readonly id: string;
  /** Whether this backend can serve the given backend id (e.g. "pi-*"). */
  supports(backend: string): boolean;
  /** Run exactly one turn, streaming events. MUST end with a `done` or `error`. */
  runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, void, void>;
}

/** Registry of available backends; resolves a task/brain's pinned backend id. */
export class BackendRegistry {
  private readonly backends: AgentBackend[] = [];

  register(backend: AgentBackend): this {
    this.backends.push(backend);
    return this;
  }

  resolve(backend: string): AgentBackend {
    const found = this.backends.find((b) => b.supports(backend));
    if (!found) throw new Error(`No agent backend supports "${backend}"`);
    return found;
  }

  list(): readonly AgentBackend[] {
    return this.backends;
  }
}

export { ScriptedBackend, type ScriptStep } from "./fake-backend.ts";
export {
  PiBackend,
  pickBrainBackendId,
  pickScoutBackendId,
  pickScoutBackendIdForAuth,
  authStorageFromBlob,
  authBlob,
  setRawCredential,
  removeCredential,
  listAvailableModels,
  listProviders,
  isAuthError,
  expiredCredentialHint,
  usesClaudeBridgeBackend,
  type PiBackendOptions,
  type ResolvedAuth,
  type AuthBlob,
  type AuthFailureReason,
  type PiModelInfo,
  type PiProviderStatus,
} from "./pi-backend.ts";
export {
  loginCodex,
  CODEX_PROVIDER_ID,
  type CodexCredential,
  type CodexLoginCallbacks,
} from "./codex-oauth.ts";
export {
  ensureConfiguredPiExtensionsInstalled,
  setPiExtensionEnvDefaults,
} from "./pi-extensions.ts";
export {
  ProcessIsolatedPiBackend,
  type IsolatedPiChild,
  type IsolatedPiChildFactory,
} from "./pi-process-backend.ts";
