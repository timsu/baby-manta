// Real Pi backend: wraps @earendil-works/pi-coding-agent as a Manta AgentBackend.
// Modeled on the prototype's src/backends/pi-session.ts. Auth comes from the local
// Pi auth store (`pi /login`), so no API key is needed here. Used in-server for
// the brain & permanent sessions (no built-in file tools — only our custom
// control-plane tools).

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  getAgentDir,
  defineTool as definePiTool,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Model, type Api } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  getConfiguredPiExtensionPaths,
  getExtensionToolNames,
  logPiExtensionDiagnostics,
} from "./pi-extensions.ts";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { AgentEvent } from "@manta/shared";
import type { AgentBackend, RunTurnInput, ToolDefinition } from "./index.ts";
import { MantaAuthStorage as AuthStorage } from "./auth-storage.ts";

function isContextLengthExceededError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context_length_exceeded|context window|maximum context length|input exceeds/i.test(msg);
}

/** Compact BEFORE a turn once the session reaches this % of the context window.
 * Pi only auto-compacts BETWEEN turns and on the top-level context-full error, so
 * a session that starts a turn already near-full can balloon past the window
 * mid-turn — inside session.prompt()'s agent loop (e.g. a large subagent result),
 * where the context-full catch never sees it — and wedge on "working…" forever.
 * Compacting first keeps headroom. Default 80%; MANTA_COMPACT_AT_PERCENT overrides,
 * 0 disables. */
const PROACTIVE_COMPACT_PERCENT = Number(process.env["MANTA_COMPACT_AT_PERCENT"] ?? 80);

/** Whether to compact before the next prompt, given the session's current context
 * usage. Pure so it can be unit-tested without a live session. */
export function shouldCompactBeforeTurn(
  usage: { percent: number | null } | undefined,
  thresholdPercent: number = PROACTIVE_COMPACT_PERCENT,
): boolean {
  if (!(thresholdPercent > 0)) return false; // 0/NaN disables
  if (!usage || usage.percent === null) return false;
  return usage.percent >= thresholdPercent;
}

/** Constructors for a session manager, injectable so the selection logic below
 * can be unit-tested without a live backend or touching `~/.pi`. */
export interface SessionManagerFactory<T> {
  /** Resume the exact prior session at `path`, forcing this turn's cwd when supplied. */
  open: (path: string, cwd: string) => T;
  /** Start a brand-new session for `cwd`. */
  create: (cwd: string) => T;
  /** Resume the most-recent existing session for `cwd`, else start fresh. */
  continueRecent: (cwd: string) => T;
  /** Defaults to `fs.existsSync`; injectable for tests. */
  exists?: (path: string) => boolean;
}

/**
 * Decide which session a turn should run in. Precedence:
 *  1. An explicit `resumeFrom` that exists on this venue — resume it exactly.
 *  2. Otherwise, when `resumeRecentForCwd` is set (worker tasks, whose cwd is a
 *     git worktree unique to one card), resume the most-recent session already
 *     in that cwd. This recovers an in-progress conversation when the session
 *     key was lost between turns (e.g. a redeploy/daemon-reconnect dropped the
 *     not-yet-persisted key) instead of forking a blank session.
 *  3. Otherwise start fresh — the brain's default, since its channels share one
 *     process cwd and must never cross-resume.
 *
 * `resuming` is true only for case 1, mirroring the venue-migration semantics:
 * a recovered/fresh session still reports itself via `onSession` so the new
 * venue-local path is persisted.
 */
export function selectSessionManager<T>(
  input: { cwd: string; resumeFrom?: string; resumeRecentForCwd?: boolean },
  factory: SessionManagerFactory<T>,
): { sessionManager: T; resuming: boolean } {
  const exists = factory.exists ?? existsSync;
  const resuming = Boolean(input.resumeFrom && exists(input.resumeFrom));
  if (resuming) return { sessionManager: factory.open(input.resumeFrom!, input.cwd), resuming: true };
  if (input.resumeRecentForCwd) return { sessionManager: factory.continueRecent(input.cwd), resuming: false };
  return { sessionManager: factory.create(input.cwd), resuming: false };
}

const processEnvOverlay = new AsyncLocalStorage<Record<string, string | undefined>>();
let processEnvOverlayInstalled = false;

/**
 * Claude Code's Agent SDK reads subscription auth from the child-process env,
 * and the Claude bridge snapshots `process.env` when it starts a query. Avoid a
 * cross-workspace race by overlaying per-turn env via AsyncLocalStorage instead
 * of mutating the process-wide environment object.
 */
function installProcessEnvOverlay(): void {
  if (processEnvOverlayInstalled) return;
  processEnvOverlayInstalled = true;

  const baseEnv = process.env;
  process.env = new Proxy(baseEnv, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const overlay = processEnvOverlay.getStore();
        if (overlay && Object.prototype.hasOwnProperty.call(overlay, prop)) return overlay[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string") {
        const overlay = processEnvOverlay.getStore();
        if (overlay && Object.prototype.hasOwnProperty.call(overlay, prop)) {
          return { configurable: true, enumerable: true, writable: true, value: overlay[prop] };
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      const overlay = processEnvOverlay.getStore();
      return Boolean(typeof prop === "string" && overlay && Object.prototype.hasOwnProperty.call(overlay, prop)) ||
        Reflect.has(target, prop);
    },
    ownKeys(target) {
      const overlay = processEnvOverlay.getStore();
      return overlay ? [...new Set([...Reflect.ownKeys(target), ...Object.keys(overlay)])] : Reflect.ownKeys(target);
    },
    set(target, prop, value) {
      // Forward writes straight to the real env without passing `receiver`. With
      // a receiver of this proxy, the spec's [[Set]] re-defines the property on
      // the receiver via a value-only descriptor, which Node's strict `process.env`
      // proxy rejects ("only accepts a configurable, writable, and enumerable data
      // descriptor") — breaking extensions that do `process.env[x] = y` at load.
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      return Reflect.deleteProperty(target, prop);
    },
  }) as NodeJS.ProcessEnv;
}

function withProcessEnvOverlay<T>(overlay: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  installProcessEnvOverlay();
  return processEnvOverlay.run({ ...(processEnvOverlay.getStore() ?? {}), ...overlay }, fn);
}

/** backend id (e.g. "pi-openai-codex:gpt-5.5") → Pi provider/model. */
function resolvePiModel(backendId: string, registry: ModelRegistry): Model<Api> {
  const map: Record<string, { provider: string; modelId: string }> = {
    "pi-gpt-5.4": { provider: "openai-codex", modelId: "gpt-5.4" },
    "pi-gpt-5.5": { provider: "openai-codex", modelId: "gpt-5.5" },
  };
  // Fallback: "pi-<provider>:<modelId>".
  const spec =
    map[backendId] ??
    (() => {
      const rest = backendId.replace(/^pi-/, "");
      const [provider, modelId] = rest.includes(":") ? rest.split(":") : ["openai-codex", rest];
      return { provider: provider!, modelId: modelId! };
    })();

  const model = registry.find(spec.provider, spec.modelId);
  if (!model) throw new Error(`Pi model not found for backend "${backendId}" (${spec.provider}/${spec.modelId})`);
  return model;
}

/** Convert a plain JSON-Schema object into a typebox schema (what Pi's
 * defineTool expects). Handles the subset Manta tools use, including nested
 * objects and arrays. Anything outside that subset falls back to Type.Unsafe
 * (pass-through). */
export function jsonSchemaToTypebox(schema: Record<string, unknown>): unknown {
  return jsonSchemaNodeToTypebox(schema);
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaOptions(schema: Record<string, unknown>): { description: string } | undefined {
  return typeof schema["description"] === "string" ? { description: schema["description"] } : undefined;
}

function jsonSchemaNodeToTypebox(schema: unknown): unknown {
  if (!isJsonSchemaObject(schema)) return Type.Unknown();

  const opts = schemaOptions(schema);

  if (Array.isArray(schema["enum"])) {
    const literals = schema["enum"].map((value) => {
      if (value === null) return Type.Null();
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return Type.Literal(value);
      }
      return Type.Unsafe({ const: value });
    });
    return literals.length > 0 ? Type.Union(literals as never, opts) : Type.Never(opts);
  }

  switch (schema["type"]) {
    case "object": {
      if (!isJsonSchemaObject(schema["properties"])) return Type.Unsafe(schema);
      const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
      const fields: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(schema["properties"])) {
        const field = jsonSchemaNodeToTypebox(def);
        fields[key] = required.includes(key) ? field : Type.Optional(field as never);
      }
      return Type.Object(fields as never, opts);
    }
    case "array":
      return Type.Array(jsonSchemaNodeToTypebox(schema["items"]) as never, opts);
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    default:
      return Type.Unsafe(schema);
  }
}

/** Translate Manta tools → Pi customTools. Pi owns execution; we forward to the
 * handler with the turn's ToolContext and wrap the result as a text result. */
function toPiTools(tools: ToolDefinition[], ctx: RunTurnInput["ctx"]): PiToolDefinition[] {
  return tools.map((t) =>
    definePiTool({
      name: t.name,
      label: t.name,
      description: t.description,
      // Manta parameters are plain JSON Schema; convert to the typebox schema
      // Pi's defineTool expects so the tool is exposed to the model correctly.
      parameters: jsonSchemaToTypebox(t.parameters) as never,
      async execute(_id: string, args: unknown) {
        const result = await t.handler(args, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: undefined };
      },
    }),
  );
}

/** Preferred models in order, as Pi {provider, modelId} pairs. */
const PREFERRED_MODELS = [
  { provider: "openai-codex", modelId: "gpt-5.6-sol" },
  { provider: "openai-codex", modelId: "gpt-5.5" },
  { provider: "openai-codex", modelId: "gpt-5.4" },
];

/** Stored auth provider used by Manta for Claude Code subscription tokens. */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/** Pi provider registered by @timsu/pi-claude-bridge at runtime. */
export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";

/**
 * Cheap models for low-stakes background jobs (Scout). Scout does a tiny,
 * read-mostly triage pass every 30 min, so it must NOT burn the flagship model.
 * Ordered cheapest-capable first; falls back to the brain model if none are
 * logged in.
 */
const SCOUT_PREFERRED_MODELS = [
  { provider: "openai-codex", modelId: "gpt-5.1-codex-mini" },
  { provider: "openai", modelId: "gpt-5-mini" },
  { provider: "openai", modelId: "gpt-5-nano" },
];

/** Convert a Pi provider id + model id to the `pi-{provider}:{modelId}` backend id used by Manta. */
function toBackendId(provider: string, modelId: string): string {
  return `pi-${provider}:${modelId}`;
}

/** Pi models attach a provider as either a string or a `{ id }` object. */
function providerIdOf(m: { provider: unknown }): string {
  return (m.provider as { id?: string })?.id ?? String(m.provider);
}

/**
 * Custom (non-built-in) providers registered at runtime so their models resolve
 * like any other. The API key comes from the per-workspace AuthStorage
 * credential (set via the provider-login UI), never baked in here. pi-ai's
 * registerProvider requires an apiKey when models are listed, so a custom
 * provider is only registered for an auth store that actually has its key —
 * which also keeps it out of `getAvailable()` until the workspace configures it.
 */
interface CustomProvider {
  id: string;
  baseUrl: string;
  api: Api;
  apiKey?: string;
  isConfigured?: (auth: AuthStorage) => boolean;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
}

const CUSTOM_PROVIDERS: ReadonlyArray<CustomProvider> = [
  {
    id: CLAUDE_BRIDGE_PROVIDER_ID,
    baseUrl: "claude-bridge",
    api: "claude-bridge" as Api,
    apiKey: "not-used",
    isConfigured: (auth) => Boolean(storedClaudeCodeOAuthToken(auth)),
    models: [
      { id: "claude-fable-5", name: "Claude Fable 5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  {
    id: "wafer",
    baseUrl: "https://pass.wafer.ai/v1",
    api: "openai-completions" as Api,
    models: [
      { id: "GLM-5.1", name: "GLM 5.1", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 32_768, cost: { input: 1.5, output: 4.5, cacheRead: 0.15, cacheWrite: 0 } },
      { id: "Qwen3.5-397B-A17B", name: "Qwen 3.5 397B A17B", reasoning: false, input: ["text"], contextWindow: 262_000, maxTokens: 32_768, cost: { input: 0.6, output: 3.6, cacheRead: 0.06, cacheWrite: 0 } },
      { id: "Qwen3.6-35B-A3B", name: "Qwen 3.6 35B A3B", reasoning: false, input: ["text"], contextWindow: 262_000, maxTokens: 32_768, cost: { input: 0.19, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },
    ],
  },
];

/** Read a provider's stored API key from an AuthStorage, if present. */
function storedApiKey(auth: AuthStorage, provider: string): string | undefined {
  const cred = (auth.getAll() as Record<string, { type?: string; key?: string }>)[provider];
  return cred && cred.type === "api_key" ? cred.key : undefined;
}

function storedClaudeCodeOAuthToken(auth: AuthStorage): string | undefined {
  const cred = (auth.getAll() as Record<string, { type?: string; token?: string }>)[CLAUDE_CODE_PROVIDER_ID];
  return cred && cred.type === "oauth" && typeof cred.token === "string" && cred.token.trim()
    ? cred.token.trim()
    : undefined;
}

/** A Pi 0.81 runtime/registry pair that also knows about Manta's custom
 * providers. The runtime owns async auth refresh; the registry is the
 * synchronous compatibility facade used for model lookup and extensions. */
async function createRegistry(auth: AuthStorage): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
  for (const p of CUSTOM_PROVIDERS) {
    const apiKey = p.apiKey ?? storedApiKey(auth, p.id);
    if (!apiKey || (p.isConfigured && !p.isConfigured(auth))) continue;
    runtime.registerProvider(p.id, { baseUrl: p.baseUrl, api: p.api, apiKey, models: p.models });
  }
  return { runtime, registry: new ModelRegistry(runtime) };
}

function availableModelsForAuth(auth: AuthStorage): Model<Api>[] {
  const configured = explicitlyConfiguredProviderIds(auth);
  const models: Model<Api>[] = [];
  const builtins = new Set<string>(getBuiltinProviders());
  for (const provider of configured) {
    if (builtins.has(provider)) {
      models.push(...getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]);
    }
  }
  for (const custom of CUSTOM_PROVIDERS) {
    if (!configured.has(custom.id)) continue;
    models.push(...custom.models.map((model) => ({
      ...model,
      provider: custom.id,
      api: custom.api,
      baseUrl: custom.baseUrl,
    } as Model<Api>)));
  }
  return models;
}

/**
 * Scan a Pi auth store and return the backend id for the first available
 * (logged-in) model from PREFERRED_MODELS. Pass a workspace-scoped AuthStorage
 * to resolve against stored credentials; omit it to read the local Pi auth
 * store (`pi /login`). Falls back to the first available model, then to a bare
 * fallback that will fail at turn time with a clear "not logged in" error.
 */
function pickAvailableBackendId(
  preferred: ReadonlyArray<{ provider: string; modelId: string }>,
  fallback: () => string,
  auth: AuthStorage = AuthStorage.create(),
): string {
  const available = availableModelsForAuth(auth);

  // Try preferred models first.
  for (const { provider, modelId } of preferred) {
    if (available.some((m) => providerIdOf(m) === provider && m.id === modelId)) {
      return toBackendId(provider, modelId);
    }
  }

  return fallback();
}

export function pickBrainBackendId(auth: AuthStorage = AuthStorage.create()): string {
  return pickAvailableBackendId(
    PREFERRED_MODELS,
    () => {
      // Fall back to the first available model, then to a bare fallback that will
      // error at turn time with a clear "not logged in" message.
      const available = availableModelsForAuth(auth);
      if (available.length > 0) {
        const first = available[0]!;
        return toBackendId(providerIdOf(first), first.id);
      }
      return toBackendId(PREFERRED_MODELS[0]!.provider, PREFERRED_MODELS[0]!.modelId);
    },
    auth,
  );
}

/**
 * Backend id for the Scout's cheap model. Honors `SCOUT_BACKEND_ID` (e.g.
 * "pi-openai-codex:gpt-5.1-codex-mini") when set; otherwise picks the first
 * logged-in model from SCOUT_PREFERRED_MODELS, falling back to the brain model
 * so Scout still runs even if no small model is available.
 */
export function pickScoutBackendId(): string {
  const override = process.env["SCOUT_BACKEND_ID"];
  if (override) return override;
  return pickAvailableBackendId(SCOUT_PREFERRED_MODELS, pickBrainBackendId);
}

/**
 * Scout backend id resolved against a SPECIFIC workspace's credentials: the
 * cheapest available SCOUT model, else the given fallback (the workspace's
 * brain default), else the brain pick for that auth store. Unlike
 * `pickScoutBackendId` this never consults the server process's ambient
 * credentials, so a hosted server's IAM-derived Bedrock access can't leak in.
 */
export function pickScoutBackendIdForAuth(auth: AuthStorage, fallback?: string): string {
  return pickAvailableBackendId(SCOUT_PREFERRED_MODELS, () => fallback || pickBrainBackendId(auth), auth);
}

// ── Workspace credential & model configuration ───────────────────────────────
// These helpers let the server build a per-workspace AuthStorage from a stored
// auth.json blob (the encrypted `pi` WorkspaceSecret) and introspect which
// providers/models are configured — without the server importing Pi directly.

/** An opaque Pi auth.json blob: provider id → credential. */
export type AuthBlob = Record<string, unknown>;

/** A model offered to the UI, keyed by its Manta backend id. */
export interface PiModelInfo {
  /** Backend id, e.g. "pi-openai-codex:gpt-5.5". */
  id: string;
  label: string;
  provider: string;
  modelId: string;
}

/** A provider's auth status for the settings UI. */
export interface PiProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  /** How this provider authenticates: an OAuth subscription or an API key. */
  authKind: "subscription" | "api_key" | "other";
  /** How many models become available once configured. */
  modelCount: number;
  /** True when a recent turn failed because this credential expired and could
   * not refresh — the user must re-login. Set by the server from runtime
   * failures (not derivable from the stored blob alone), so it's optional here. */
  needsReauth?: boolean;
}

/** Providers we surface in the UI even before they're configured, with a
 * friendly label and the auth method the user should use. */
const KNOWN_PROVIDERS: ReadonlyArray<{ id: string; label: string; authKind: PiProviderStatus["authKind"] }> = [
  { id: "openai-codex", label: "ChatGPT Codex", authKind: "subscription" },
  { id: CLAUDE_CODE_PROVIDER_ID, label: "Claude Code", authKind: "subscription" },
  { id: "anthropic", label: "Anthropic", authKind: "api_key" },
  { id: "openai", label: "OpenAI", authKind: "api_key" },
  { id: "google", label: "Google Gemini", authKind: "api_key" },
  { id: "openrouter", label: "OpenRouter", authKind: "api_key" },
  { id: "groq", label: "Groq", authKind: "api_key" },
  { id: "xai", label: "xAI", authKind: "api_key" },
  { id: "wafer", label: "Wafer", authKind: "api_key" },
];

/** Build an in-memory AuthStorage from a stored auth.json blob. */
export function authStorageFromBlob(blob: AuthBlob): AuthStorage {
  return AuthStorage.inMemory(blob as never);
}

/** Serialize an AuthStorage back to a blob for persistence. */
export function authBlob(auth: AuthStorage): AuthBlob {
  return auth.getAll() as AuthBlob;
}

/** Set a raw Pi credential (already in `{ type: "oauth" | "api_key", ... }` form). */
export function setRawCredential(auth: AuthStorage, provider: string, credential: unknown): void {
  auth.set(provider, credential as never);
}

/** Remove a provider's stored credential. */
export function removeCredential(auth: AuthStorage, provider: string): void {
  auth.remove(provider);
}

/** Provider IDs that are explicitly configured in this auth store (have real
 * credentials). Used to filter out providers Pi's built-in registry exposes via
 * ambient env vars (e.g. amazon-bedrock via AWS_ACCESS_KEY_ID) that the user
 * hasn't explicitly set up in Manta. */
function explicitlyConfiguredProviderIds(auth: AuthStorage): Set<string> {
  const ids = new Set<string>();
  for (const p of CUSTOM_PROVIDERS) {
    const isConf = p.isConfigured ? p.isConfigured(auth) : Boolean(storedApiKey(auth, p.id));
    if (isConf) ids.add(p.id);
  }
  for (const id of Object.keys(auth.getAll() as AuthBlob)) ids.add(id);
  return ids;
}

/** All text models available given the configured credentials, as backend ids. */
export function listAvailableModels(auth: AuthStorage): PiModelInfo[] {
  return availableModelsForAuth(auth)
    .filter((m) => (m.input as string[]).includes("text"))
    .map((m) => {
      const provider = providerIdOf(m);
      const displayProvider = provider === CLAUDE_BRIDGE_PROVIDER_ID ? "Claude Code" : provider;
      return { id: toBackendId(provider, m.id), label: `${m.id} · ${displayProvider}`, provider, modelId: m.id };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Auth status for every provider we know about or that has stored credentials. */
export function listProviders(auth: AuthStorage): PiProviderStatus[] {
  const counts = new Map<string, number>();
  const rawProviderIds = new Set(Object.keys(auth.getAll() as AuthBlob));
  for (const m of availableModelsForAuth(auth)) {
    const p = providerIdOf(m);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const claudeBridgeModelCount = counts.get(CLAUDE_BRIDGE_PROVIDER_ID) ?? 0;
  if (claudeBridgeModelCount > 0) counts.set(CLAUDE_CODE_PROVIDER_ID, claudeBridgeModelCount);
  const raw = auth.getAll() as Record<string, { type?: string }>;
  const oauthProviderIds = new Set(Object.entries(raw).filter(([, credential]) => credential.type === "oauth").map(([id]) => id));
  const ids = new Set<string>([
    ...KNOWN_PROVIDERS.map((p) => p.id),
    ...[...counts.keys()].filter((id) => id !== CLAUDE_BRIDGE_PROVIDER_ID),
    ...oauthProviderIds,
    ...rawProviderIds,
  ]);
  return Array.from(ids)
    .map((id) => {
      const known = KNOWN_PROVIDERS.find((p) => p.id === id);
      const authKind: PiProviderStatus["authKind"] =
        known?.authKind ?? (oauthProviderIds.has(id) ? "subscription" : "api_key");
      return {
        id,
        label: known?.label ?? id,
        configured: rawProviderIds.has(id),
        authKind,
        modelCount: counts.get(id) ?? 0,
      };
    })
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        b.modelCount - a.modelCount ||
        a.label.localeCompare(b.label),
    );
}

export interface PiBackendOptions {
  /** Working directory: a worktree for workers, scratch for the brain. */
  cwd?: string;
  /** Built-in Pi coding tools to enable (workers); empty for the brain. */
  builtinTools?: string[];
  /**
   * Load Manta's Pi SDK extensions (vision proxy, web access, codex conversion,
   * automatic reasoning, context-mode, loop) for this backend's turns. Packages
   * must already be installed via
   * `ensureConfiguredPiExtensionsInstalled()` (done once at daemon startup).
   */
  extensions?: boolean;
  /** Optional allowlist for extension-provided tools. When omitted, every loaded
   * extension tool is enabled; when present, only matching names are exposed. */
  extensionToolAllowlist?: string[];
  /** Optional denylist for extension-provided tools, applied after the allowlist.
   * For hiding specific extension tools (e.g. ones that assume a persistent
   * session) without having to enumerate everything else. */
  extensionToolDenylist?: string[];
  /**
   * Additional local extension paths to load alongside the configured Pi
   * extensions. Used by the worker to register dynamically-generated skill-repo
   * extensions (cloned alongside the main repo at turn time).
   */
  additionalExtensionPaths?: string[];
  /** Per-turn environment variables exposed to tools/model child processes. */
  env?: Record<string, string>;
  /**
   * Resolve a workspace-scoped AuthStorage (from stored credentials) for the
   * turn. Return null to fall back to the local Pi auth store. Injected by the
   * server so the agent package stays free of DB/crypto deps.
   *
   * `exclude` lists credential keys ("userId:provider") that already failed this
   * turn, so the resolver can pick a different team member's subscription on
   * retry (round-robin failover across the workspace's credential pool).
   */
  resolveAuth?: (workspaceId: string, exclude?: string[]) => Promise<ResolvedAuth | null>;
  /**
   * Called after a turn when the resolved AuthStorage's credentials changed
   * (e.g. an OAuth token was refreshed mid-turn), so the server can persist the
   * rotated tokens. `credentialKeys` identifies which member's credentials backed
   * the turn, so rotation persists back to the owning user. Only fires when
   * `resolveAuth` returned a storage.
   */
  onAuthChanged?: (workspaceId: string, blob: AuthBlob, credentialKeys?: string[]) => void | Promise<void>;
  /**
   * Called when a turn produced no output or failed with an auth error, so the
   * server can blacklist the backing credential(s) and the next turn skips them.
   * `backendId` identifies the model/provider the failed turn used. `reason`
   * distinguishes a hard auth error from an empty turn (an expired subscription
   * that couldn't refresh) so the server can flag the credential for re-login.
   */
  onAuthFailure?: (
    workspaceId: string,
    backendId: string,
    credentialKeys: string[],
    reason: AuthFailureReason,
  ) => void | Promise<void>;
}

/** Why a turn's credential failed: a hard auth/401 error, or an empty turn that
 * almost always means an expired subscription that couldn't refresh. */
export type AuthFailureReason = "auth_error" | "empty_turn";

/** An AuthStorage plus the credential keys ("userId:provider") backing it, so a
 * failed turn can report which to blacklist and rotation can persist to the owner. */
export interface ResolvedAuth {
  storage: AuthStorage;
  credentialKeys?: string[];
}

/** Result of one model attempt inside runTurn (see #runOnce). `credentialKeys`
 * and `producedOutput` let runTurn decide whether to fail the backing credential
 * over and retry with the next subscription in the pool. `elapsedMs` separates a
 * turn that reached the model and came back empty from one that died during
 * setup (extension load, spawn failure) before any request went out. */
type RunOnceOutcome =
  | {
      status: "ok";
      credentialKeys: string[];
      producedOutput: boolean;
      elapsedMs: number;
      // Whether auth was actually present for this attempt — see the
      // computation site in #runOnce for why this differs from credentialKeys.
      hadCredentials: boolean;
    }
  | { status: "error"; error: unknown; overloaded: boolean; credentialKeys: string[] };

/** A turn that failed because the backing subscription is dead/unauthorized —
 * worth blacklisting the credential and retrying with the next in the pool.
 * Narrow on purpose so a genuine tool/code error never blacklists a good account. */
export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b401\b|\b403\b|unauthor|invalid[_\s-]?(?:api[_\s-]?key|token|grant)|token (?:has )?expired|expired token|no (?:credentials|auth)|authentication/i.test(msg);
}

/** Friendly provider name for a backend id (e.g. "pi-openai-codex:gpt-5.5" →
 * "ChatGPT Codex"). Falls back to the raw provider slug. */
function providerLabelFor(backendId: string): string {
  const rest = backendId.startsWith("pi-") ? backendId.slice(3) : backendId;
  const provider = rest.split(":")[0] || rest;
  if (provider === "openai-codex") return "ChatGPT Codex";
  if (provider === CLAUDE_BRIDGE_PROVIDER_ID || provider === "claude-code") return "Claude Code";
  return provider;
}

/** Shorter than any real model round-trip, so a turn this fast never reached the
 * provider — it died locally during setup (extension load, spawn failure). */
const SETUP_FAILURE_MS = 3_000;

/** Credentials already tried this turn before runTurn stops rotating. Bounded so
 * a workspace with many dead subscriptions can't loop forever. */
const MAX_CRED_FAILOVERS = 4;

/** What runTurn should do about an empty turn: blacklist the credential that
 * produced it, and/or rotate to the next subscription in the pool. Split out as a
 * pure function so the decision is testable without booting a Pi runtime — the
 * expensive-to-reach branch is exactly the one that misfired in production.
 *
 * A turn too fast to have reached the provider failed locally (extension load,
 * spawn) — the credential is irrelevant there, so neither blacklist it nor burn
 * the rest of the pool retrying a failure that will just repeat. */
export function planEmptyTurnFailover(opts: {
  elapsedMs: number;
  credentialKeys: string[];
  excludedCreds: string[];
}): { notifyAuthFailure: boolean; retryWith: string[] } {
  const { elapsedMs, credentialKeys, excludedCreds } = opts;
  const setupFailure = elapsedMs < SETUP_FAILURE_MS;
  if (setupFailure || !credentialKeys.length) return { notifyAuthFailure: false, retryWith: [] };
  const fresh = credentialKeys.filter((k) => !excludedCreds.includes(k));
  const canRetry = fresh.length > 0 && excludedCreds.length < MAX_CRED_FAILOVERS;
  return { notifyAuthFailure: true, retryWith: canRetry ? fresh : [] };
}

/** User-facing message for an empty turn. The cause is genuinely ambiguous here:
 * a dead subscription, a crash during setup, and a model that simply said
 * nothing all surface identically. Claiming "your subscription expired" for all
 * three sends people to re-login repeatedly against healthy credentials, so only
 * say that when a credential was actually in play, and say it as a possibility
 * rather than a diagnosis. A turn too fast to have reached the provider gets
 * pointed at the logs instead. */
export function expiredCredentialHint(backendId: string, opts: { elapsedMs: number; hadCredentials?: boolean }): string {
  const provider = providerLabelFor(backendId);
  // Default to false: when presence is unknown, the safe failure is the neutral
  // "no credential" wording, not blaming a subscription we have no evidence about.
  const { elapsedMs, hadCredentials = false } = opts;
  if (elapsedMs < SETUP_FAILURE_MS) {
    return `⚠️ ${provider} returned no response after ${elapsedMs}ms — too fast to have reached the model, so the turn failed locally during startup rather than upstream. Check the worker log (\`./start-worker --logs\`) for the underlying error; re-login will not help.`;
  }
  if (!hadCredentials) {
    return `⚠️ ${provider} returned no response, and no credential was attached to the turn. Check the worker log (\`./start-worker --logs\`) for the underlying error.`;
  }
  return `⚠️ ${provider} returned no response. This is often an expired subscription that could not refresh — if re-login (the prompt on your board, or Settings → Providers) does not fix it, check the worker log (\`./start-worker --logs\`) for the underlying error.`;
}

/** Overload fallback order for claude-bridge models, most- to least-capable.
 * Deliberately separate from the display/model list: Fable 5 is a premium model
 * (higher effective cost, opt-in data retention), so an automatic overload retry
 * must never route a turn *to* it. Opus 5 leads the chain instead. Fable 5 is
 * absent as a target but still degrades to the chain head if it overloads. */
const CLAUDE_BRIDGE_OVERLOAD_FALLBACK_ORDER = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/** The next model to try when `backendId` is overloaded, per the fallback order
 * above. Only claude-bridge has a fallback today; null for the last model in the
 * chain or any other backend. A bridge model outside the chain (Fable 5) is
 * never returned as a fallback but still degrades to the chain head. */
export function nextOverloadFallback(backendId: string): string | null {
  const prefix = `pi-${CLAUDE_BRIDGE_PROVIDER_ID}:`;
  if (!backendId.startsWith(prefix)) return null;
  const modelId = backendId.slice(prefix.length);
  const idx = CLAUDE_BRIDGE_OVERLOAD_FALLBACK_ORDER.indexOf(modelId as (typeof CLAUDE_BRIDGE_OVERLOAD_FALLBACK_ORDER)[number]);
  const next = idx === -1 ? CLAUDE_BRIDGE_OVERLOAD_FALLBACK_ORDER[0] : CLAUDE_BRIDGE_OVERLOAD_FALLBACK_ORDER[idx + 1];
  return next ? toBackendId(CLAUDE_BRIDGE_PROVIDER_ID, next) : null;
}

/** A retryable upstream-capacity failure (HTTP 529 "overloaded", or the Claude
 * bridge's stalled-stream watchdog which it labels a retryable 529) — worth a model
 * fallback. Narrow on purpose so a real coding/tool error never downgrades. */
export function isOverloadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b529\b|overloaded|stream idle timeout/i.test(msg);
}

/** True when a Manta backend id routes through the claude-bridge Pi provider
 * (e.g. "pi-claude-bridge:claude-opus-4-8"). */
export function usesClaudeBridgeBackend(backendId: string): boolean {
  return backendId.includes(CLAUDE_BRIDGE_PROVIDER_ID);
}

/** The globalThis guard the claude-bridge extension uses to keep exactly one
 * module instance's streamSimple registered as the provider implementation
 * (Symbol.for, so it is shared process-wide and reachable from here). */
const CLAUDE_BRIDGE_ACTIVE_STREAM_KEY = Symbol.for("claude-bridge:activeStreamSimple");

/**
 * Drop the claude-bridge extension's active-instance registration so the NEXT
 * extension load (this turn's `resourceLoader.reload()`) registers a fresh
 * instance as the provider implementation.
 *
 * Why this is load-bearing: pi loads extensions via jiti with `moduleCache:
 * false`, so every reload creates a NEW bridge module instance — but the bridge
 * only registers the FIRST instance's streamSimple (guarded by this symbol) and
 * later instances no-op. In a long-lived multi-task process (the laptop worker
 * daemon), that first instance lives forever, and its module-global Claude CLI
 * session pointer (`sharedSession`) is never cleared: the lifecycle events that
 * would clear/restore it fire on each turn's fresh THROWAWAY instance, and the
 * embedded agent session emits `session_start` with reason "startup", which the
 * bridge doesn't treat as a new conversation anyway. The stale pointer then
 * passes the bridge's "history in sync" reuse check on a NEW task's first turn
 * (zero prior messages ⇒ nothing looks missed) and silently RESUMES the
 * previous card's Claude CLI conversation — which is how several cards' work
 * ended up on one card's branch/PR.
 *
 * Clearing the guard before each bridge turn makes the freshly loaded instance
 * authoritative. Its session pointer starts null and is restored ONLY from the
 * current pi session's own persisted bridge markers (guarded by pi session id +
 * cwd + history fingerprint), i.e. the pointer is effectively keyed to the
 * task. Follow-up turns of the same task still resume/reuse their own CLI
 * session (warm prompt cache); other tasks can never be resumed.
 *
 * MUST NOT run while another bridge query is in flight in this process:
 * re-registration mid-query breaks the active query's tool-result delivery
 * (the bridge's own re-registration guard exists for that reason). Worker
 * claude-bridge turns uphold this by running one turn per isolated process.
 */
export function resetClaudeBridgeRegistration(): void {
  (globalThis as Record<symbol, unknown>)[CLAUDE_BRIDGE_ACTIVE_STREAM_KEY] = undefined;
}

export class PiBackend implements AgentBackend {
  readonly id = "pi";
  private readonly cwd: string;
  private readonly builtinTools: string[];
  private readonly extensions: boolean;
  private readonly extensionToolAllowlist?: Set<string>;
  private readonly extensionToolDenylist?: Set<string>;
  private readonly additionalExtensionPaths: string[];
  private readonly env: Record<string, string>;
  private readonly resolveAuth?: (workspaceId: string, exclude?: string[]) => Promise<ResolvedAuth | null>;
  private readonly onAuthChanged?: (workspaceId: string, blob: AuthBlob, credentialKeys?: string[]) => void | Promise<void>;
  private readonly onAuthFailure?: (
    workspaceId: string,
    backendId: string,
    credentialKeys: string[],
    reason: AuthFailureReason,
  ) => void | Promise<void>;
  private _resourceLoader: DefaultResourceLoader | null = null;
  private _settingsManager: SettingsManager | null = null;
  private _systemPrompt: string | undefined;

  constructor(opts: PiBackendOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.builtinTools = opts.builtinTools ?? [];
    this.extensions = opts.extensions ?? false;
    this.extensionToolAllowlist = opts.extensionToolAllowlist ? new Set(opts.extensionToolAllowlist) : undefined;
    this.extensionToolDenylist = opts.extensionToolDenylist ? new Set(opts.extensionToolDenylist) : undefined;
    this.additionalExtensionPaths = opts.additionalExtensionPaths ?? [];
    this.env = opts.env ?? {};
    this.resolveAuth = opts.resolveAuth;
    this.onAuthChanged = opts.onAuthChanged;
    this.onAuthFailure = opts.onAuthFailure;
  }

  supports(backend: string): boolean {
    return backend.startsWith("pi-") || backend === "pi";
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, void, void> {
    // On an upstream overload (Anthropic 529), retry the turn on the next model in
    // line rather than failing the task — the bridge's own fallback only covers
    // Fable→Opus. Non-overload failures and non-bridge backends just run once.
    let backendId = input.backend;
    // Credential keys already tried (and failed) this turn — excluded so the next
    // attempt rotates to a different team member's subscription. Bounded so a
    // workspace with many dead subs can't loop forever.
    const excludedCreds: string[] = [];
    for (;;) {
      const outcome = yield* this.#runOnce(input, backendId, excludedCreds);

      // Empty turn (no text + no tool calls) ⇒ the subscription is almost
      // certainly dead/unavailable (a healthy brain answers or calls `ignore`).
      // Exception: a turn the user interrupted produces no output *by design* —
      // attributing that to an expired subscription is a false positive, so skip
      // the credential-failure path (and its re-login hint) when aborted.
      if (outcome.status === "ok" && !outcome.producedOutput && !input.signal?.aborted) {
        const plan = planEmptyTurnFailover({
          elapsedMs: outcome.elapsedMs,
          credentialKeys: outcome.credentialKeys,
          excludedCreds,
        });
        // With a credential pool, report it (so the server flags the credential
        // for re-login) and retry with the next subscription before giving up.
        if (plan.notifyAuthFailure) {
          await this.#notifyAuthFailure(input.ctx.workspaceId, backendId, outcome.credentialKeys, "empty_turn");
        }
        if (plan.retryWith.length) {
          excludedCreds.push(...plan.retryWith);
          continue;
        }
        // Nothing came back and nothing left to try. Surface it instead of ending
        // silently — a silent empty turn is exactly what made a whole fleet of
        // cards look "stalled" with no error to act on. Workers have no pool to
        // fail over, so this is the only signal they get.
        yield {
          type: "text",
          text: expiredCredentialHint(backendId, {
            elapsedMs: outcome.elapsedMs,
            hadCredentials: outcome.hadCredentials,
          }),
        };
      }
      if (outcome.status === "ok") {
        yield { type: "done", reason: "end_turn" };
        return;
      }

      const fallback = outcome.overloaded ? nextOverloadFallback(backendId) : null;
      if (fallback) {
        const label = (id: string) => id.split(":").pop() ?? id;
        yield { type: "text", text: `⚠️ ${label(backendId)} is overloaded (HTTP 529) — retrying on ${label(fallback)}.` };
        backendId = fallback;
        continue;
      }
      // An auth error means the backing subscription is dead/unauthorized: blacklist
      // it and retry with the next credential in the pool before giving up.
      if (isAuthError(outcome.error) && outcome.credentialKeys.length) {
        await this.#notifyAuthFailure(input.ctx.workspaceId, backendId, outcome.credentialKeys, "auth_error");
        const fresh = outcome.credentialKeys.filter((k) => !excludedCreds.includes(k));
        if (fresh.length && excludedCreds.length < MAX_CRED_FAILOVERS) {
          excludedCreds.push(...fresh);
          continue;
        }
      }
      yield { type: "error", message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
      return;
    }
  }

  /** Invoke the auth-failure hook defensively: a throwing hook must not crash the
   * turn, or it would prevent the credential failover/retry this is meant to drive. */
  async #notifyAuthFailure(
    workspaceId: string,
    backendId: string,
    credentialKeys: string[],
    reason: AuthFailureReason,
  ): Promise<void> {
    if (!this.onAuthFailure) return;
    try {
      await this.onAuthFailure(workspaceId, backendId, credentialKeys, reason);
    } catch {
      /* best-effort blacklist; ignore so failover still proceeds */
    }
  }

  async *#runOnce(input: RunTurnInput, backendId: string, excludeCreds: string[] = []): AsyncGenerator<AgentEvent, RunOnceOutcome, void> {
    const agentDir = getAgentDir();
    // Per-workspace credentials when a resolver is wired (cloud, multi-tenant);
    // otherwise the local Pi auth store (`pi /login`) for single-tenant/dev.
    const resolved = this.resolveAuth ? await this.resolveAuth(input.ctx.workspaceId, excludeCreds) : null;
    const authStorage = resolved?.storage ?? AuthStorage.create();
    const credentialKeys = resolved?.credentialKeys ?? [];
    // Whether auth is actually present, checked against the storage that will back
    // this attempt — not credentialKeys, which is empty for the local-auth path
    // (`resolveAuth` unset, or a resolver that doesn't return credentialKeys) even
    // though real credentials from `pi /login` are loaded and in play.
    const hadCredentials = Object.keys(authStorage.getAll() as AuthBlob).length > 0;
    // Whether the model emitted anything actionable (text or a tool call). An
    // empty turn *may* signal a dead subscription — see the failover loop in
    // runTurn, which weighs this against how long the attempt took.
    let producedOutput = false;
    const startedAt = Date.now();
    // Snapshot auth before the turn so we can detect (and persist) an in-place
    // OAuth refresh afterward. Captured for the local-auth path too (workers),
    // not just the resolver path — see the onAuthChanged block below.
    const authBefore = JSON.stringify(authStorage.getAll());
    const { runtime: modelRuntime, registry: modelRegistry } = await createRegistry(authStorage);
    const settingsManager = (this._settingsManager ??= SettingsManager.create(this.cwd, agentDir));
    const model = resolvePiModel(backendId, modelRegistry);

    // Workers load Manta's Pi extensions (already installed in the stable cache
    // at startup); the brain runs without them. An empty array is a no-op.
    const extensionPaths = [
      ...(this.extensions ? getConfiguredPiExtensionPaths() : []),
      ...this.additionalExtensionPaths,
    ];
    // Update the mutable system-prompt ref before reloading so the override
    // closure sees the current turn's value without spawning a new loader.
    this._systemPrompt = input.systemPrompt;
    const resourceLoader = (this._resourceLoader ??= new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      systemPromptOverride: () => this._systemPrompt,
    }));
    // Bridge turns: make THIS turn's freshly loaded bridge instance the active
    // provider implementation, so the Claude CLI session pointer in play is the
    // one keyed to this turn's own pi session — see resetClaudeBridgeRegistration.
    // Safe here because worker bridge turns never overlap in one process (each
    // runs in a disposable child); a stale first instance would otherwise silently
    // resume the previous task's conversation.
    if (this.extensions && usesClaudeBridgeBackend(backendId)) resetClaudeBridgeRegistration();
    await resourceLoader.reload();
    // Extension-registered tools must be added to the allowlist below or they
    // stay disabled. Log which extensions loaded (and any load failures).
    const extensionToolNames = this.extensions
      ? getExtensionToolNames(resourceLoader).filter(
          (name) =>
            (!this.extensionToolAllowlist || this.extensionToolAllowlist.has(name)) &&
            !this.extensionToolDenylist?.has(name),
        )
      : [];
    if (this.extensions) logPiExtensionDiagnostics("pi", resourceLoader);

    // A session key (resumeFrom) is an ABSOLUTE, venue-specific path
    // (~/.pi/agent/sessions/<encoded-cwd>/…). When a task migrates venues — e.g. a
    // laptop turn then a cloud-sandbox follow-up — the stored path doesn't exist on
    // the new venue, and SessionManager.open would try to mkdir a foreign path
    // (e.g. /Users/<you>/… on Linux) and crash with EACCES. Only resume when the
    // file is actually present here; otherwise start fresh on this venue. Context
    // continuity across venues needs the session content carried as a blob (future
    // work) — the branch + re-sent task messages are the durable artifact for now.
    const { sessionManager, resuming } = selectSessionManager(
      { cwd: this.cwd, resumeFrom: input.resumeFrom, resumeRecentForCwd: input.resumeRecentForCwd },
      {
        // Worker turns pass the task worktree as `cwd`. Session files can outlive
        // or be crossed by Claude/bridge session bugs, so don't let an old header
        // cwd pull built-in tools back to the daemon/default checkout.
        open: (p, cwd) => SessionManager.open(p, undefined, cwd),
        create: (cwd) => SessionManager.create(cwd),
        continueRecent: (cwd) => SessionManager.continueRecent(cwd),
      },
    );

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      // `tools` is an allowlist of ENABLED tool names — must list our custom
      // control-plane tools, the built-in coding tools (workers), AND any
      // extension-registered tools; an empty array would disable everything,
      // including the custom tools. Dedupe in case names overlap.
      tools: [...new Set([...input.tools.map((t) => t.name), ...this.builtinTools, ...extensionToolNames])],
      customTools: toPiTools(input.tools, input.ctx),
    });

    // Report the session file whenever we started a fresh one (no resumeFrom, or a
    // resumeFrom that didn't exist on this venue) so the new venue-local path is
    // persisted and subsequent same-venue turns resume correctly.
    if (!resuming && session.sessionFile && input.onSession) {
      await input.onSession(session.sessionFile);
    }

    const queue: AgentEvent[] = [];
    let done = false;
    let resolveWait: (() => void) | null = null;
    const wake = () => {
      const r = resolveWait;
      resolveWait = null;
      r?.();
    };

    /** Push a context_usage event if the session reports current usage. */
    const pushContextUsage = async () => {
      try {
        const usage = (session as { getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined }).getContextUsage?.();
        if (usage && usage.tokens !== null && usage.percent !== null) {
          queue.push({ type: "context_usage", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent });
          wake();
        }
      } catch {
        /* best-effort; ignore errors */
      }
    };

    const unsubscribe = session.subscribe((ev: { type: string; [k: string]: unknown }) => {
      if (ev.type === "message_update") {
        const inner = ev["assistantMessageEvent"] as { type: string; content?: string } | undefined;
        if (inner?.type === "text_end" && inner.content) {
          queue.push({ type: "text", text: inner.content });
          wake();
          void pushContextUsage();
        }
      } else if (ev.type === "tool_execution_start") {
        let argsPreview = "";
        try {
          argsPreview = JSON.stringify(ev["args"]).slice(0, 300);
        } catch {
          /* ignore */
        }
        queue.push({ type: "tool_use", toolName: String(ev["toolName"]), argsPreview });
        wake();
      } else if (ev.type === "compaction_start") {
        // Compaction runs an LLM summarization before the turn proceeds — on a
        // resumed, near-full session it can take many seconds. Surface it as an
        // ephemeral status so the UI shows *why* it's waiting instead of a silent
        // "working…". (`thinking` events are relayed live but not persisted.)
        queue.push({ type: "thinking", text: "Compacting conversation to free up context…\n" });
        wake();
      } else if (ev.type === "compaction_end") {
        if (!ev["aborted"]) {
          void pushContextUsage();
        }
      } else if (ev.type === "auto_retry_start") {
        const attempt = Number(ev["attempt"] ?? 0);
        const maxAttempts = Number(ev["maxAttempts"] ?? 0);
        const why = String(ev["errorMessage"] ?? "transient error");
        queue.push({ type: "thinking", text: `Model call failed (${why}) — retrying (${attempt}/${maxAttempts})…\n` });
        wake();
      }
      // Note: agent_end does NOT set done here. Pi may auto-compact after
      // agent_end (before prompt() resolves), emitting compaction_start events
      // that must still reach the queue. done is set in the session.prompt()
      // finally block so we exit only after Pi is fully done.
    });

    const onAbort = () => void session.abort();
    input.signal?.addEventListener("abort", onAbort);

    const claudeOAuthToken = storedClaudeCodeOAuthToken(authStorage);
    let promptError: unknown = null;
    // Stamped when the prompt settles, NOT at generator return: the drain loop
    // below suspends on `yield` until the consumer resumes it, so measuring at
    // return would fold consumer latency into the attempt. A slow consumer
    // draining context_usage/thinking events (neither sets producedOutput, so
    // the turn still counts as empty) could push a genuinely local failure past
    // SETUP_FAILURE_MS and resurrect the credential blame this change removes.
    let promptSettledAt: number | null = null;
    const runPrompt = async () => {
      try {
        // Setup can await auth/session callbacks after the caller aborts. Check
        // again at the last side-effect boundary so a canceled turn never reaches
        // compact() or session.prompt() after setup eventually unwinds.
        if (input.signal?.aborted) return;
        // Handle /compact slash command: compact the session instead of prompting.
        const compactMatch = /^\/compact(?:\s+([\s\S]*))?$/.exec(input.message.trim());
        if (compactMatch) {
          const instructions = compactMatch[1]?.trim();
          try {
            await (session as { compact(instructions?: string): Promise<unknown> }).compact(instructions);
            queue.push({ type: "text", text: "✅ Compacted Pi session context." });
            wake();
            await pushContextUsage();
          } catch (compactErr) {
            const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
            if (/already compacted/i.test(msg)) {
              queue.push({ type: "text", text: "ℹ️ Pi session context is already compacted." });
              wake();
              await pushContextUsage();
            } else {
              promptError = compactErr;
            }
          }
          return;
        }
        // Proactively compact before prompting when the session is near the
        // context ceiling, so a near-full session doesn't start a turn that
        // overflows mid-flight and wedges (see shouldCompactBeforeTurn). Best
        // effort: a failed pre-compact must not block the turn — the reactive
        // context-full catch below is still the backstop.
        try {
          const usage = (session as { getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined }).getContextUsage?.();
          if (shouldCompactBeforeTurn(usage)) {
            queue.push({ type: "thinking", text: `Context at ${Math.round(usage!.percent!)}% — compacting before continuing…\n` });
            wake();
            await (session as { compact(instructions?: string): Promise<unknown> }).compact(
              "Preserve the active task state, recent tool outputs needed to continue, blockers, and exact next steps.",
            );
            await pushContextUsage();
          }
        } catch {
          /* best-effort; fall through to prompt (and the reactive catch below) */
        }
        if (input.signal?.aborted) return;
        await session.prompt(input.message);
      } catch (err) {
        if (!isContextLengthExceededError(err)) {
          promptError = err;
          return;
        }
        // Context window was full — compact and retry the original message.
        queue.push({ type: "thinking", text: "Context window full — compacting and retrying…\n" });
        wake();
        try {
          if (input.signal?.aborted) return;
          await (session as { compact(instructions?: string): Promise<unknown> }).compact(
            "The previous prompt could not be sent because the model context was full. Preserve the active task state, recent tool outputs needed to continue, blockers, and exact next steps.",
          );
          if (input.signal?.aborted) return;
          await session.prompt(input.message);
        } catch (retryErr) {
          promptError = retryErr;
        }
      } finally {
        promptSettledAt = Date.now();
        done = true;
        wake();
      }
    };

    const envOverlay = { ...this.env, ...(claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOAuthToken } : {}) };
    const promptPromise = Object.keys(envOverlay).length
      ? withProcessEnvOverlay(envOverlay, runPrompt)
      : runPrompt();

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolveWait = r;
          });
          continue;
        }
        const ev = queue.shift()!;
        if (ev.type === "text" || ev.type === "tool_use") producedOutput = true;
        yield ev;
      }
      await promptPromise;
      if (promptError) {
        return { status: "error", error: promptError, overloaded: isOverloadError(promptError), credentialKeys };
      }
      return { status: "ok", credentialKeys, producedOutput, elapsedMs: (promptSettledAt ?? Date.now()) - startedAt, hadCredentials };
    } finally {
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      // Persist rotated OAuth tokens (Pi refreshes in-place during the turn). Pass
      // credentialKeys so the server routes the refreshed token back to the member
      // who owns it (not the workspace blob, which would shadow round-robin).
      // Fire for the local-auth path too (workers): OpenAI rotates the refresh
      // token on every refresh, so a worker that refreshes but never reports it
      // back leaves the server holding a now-invalid token — the exact split that
      // forces a manual re-login. credentialKeys is empty there; the handler then
      // persists the whole blob.
      if (this.onAuthChanged) {
        const blob = authStorage.getAll() as AuthBlob;
        if (JSON.stringify(blob) !== authBefore) {
          try {
            await this.onAuthChanged(input.ctx.workspaceId, blob, credentialKeys);
          } catch {
            /* persistence is best-effort; a failure just re-refreshes next turn */
          }
        }
      }
    }
  }
}
