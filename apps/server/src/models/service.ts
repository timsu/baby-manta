// Workspace model & provider configuration. Owns the encrypted `pi`
// WorkspaceSecret (the full Pi auth.json blob) and the workspace's model
// settings. This is the bridge between the HTTP routes / agent backend and the
// encrypted credential store: it decrypts the blob into a Pi AuthStorage, lets
// callers introspect and mutate it, and re-encrypts on write.

import { workspaces, workspaceSecrets, userSecrets } from "@manta/db";
import {
  authStorageFromBlob,
  authBlob,
  setRawCredential,
  removeCredential,
  listAvailableModels,
  listProviders,
  pickScoutBackendIdForAuth,
  type AuthBlob,
  type AuthFailureReason,
  type PiModelInfo,
  type PiProviderStatus,
} from "@manta/agent";
import { encryptJson, decryptJson } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Models");
const KIND = "pi" as const;

/** Decrypt the workspace's Pi auth.json blob (empty object if none/corrupt). */
async function loadBlob(workspaceId: string): Promise<AuthBlob> {
  const row = await workspaceSecrets.get({ workspaceId }, KIND);
  if (!row) return {};
  try {
    return decryptJson<AuthBlob>(Buffer.from(row.ciphertext));
  } catch (err) {
    logger.error("failed to decrypt workspace pi secret", { workspaceId, err });
    return {};
  }
}

async function saveBlob(workspaceId: string, blob: AuthBlob): Promise<void> {
  // Record which providers are configured in `meta` (non-secret) for quick
  // inspection without decrypting.
  const providers = Object.keys(blob);
  await workspaceSecrets.upsert({ workspaceId }, KIND, encryptJson(blob), { providers });
}

// ── Brain credential pool: round-robin + blacklist ───────────────────────────
// The brain runs on team members' personal subscriptions (Codex, Claude). A
// single dead subscription must not take the brain down, so we round-robin one
// credential per provider across the pool and temporarily blacklist any
// credential whose turn produced no output or failed with an auth error (see
// PiBackend.onAuthFailure → reportBrainAuthFailure). In-memory state is fine: a
// restart just re-learns which creds are dead on the next failed turn.
const BRAIN_CRED_BLACKLIST_MS = 15 * 60_000;
const brainCredBlacklist = new Map<string, number>(); // "userId:provider" -> expiry epoch ms
const brainRoundRobin = new Map<string, number>(); // "workspaceId:provider" -> next index

// Credentials that need a user re-login: a turn failed because the subscription
// expired and couldn't refresh. Unlike the 15-min blacklist (a failover hint),
// this is STICKY until the user reconnects or the token successfully rotates — it
// drives the re-login prompt in the web onboarding panel. Keyed "userId:provider".
const credNeedsReauth = new Set<string>();

/** True if this user's provider credential has been flagged as needing re-login. */
export function credentialNeedsReauth(userId: string, provider: string): boolean {
  return credNeedsReauth.has(`${userId}:${provider}`);
}

/** Clear the re-login flag for a user's provider — call when the credential is
 * reconnected or successfully refreshed. */
export function clearCredentialReauth(userId: string, provider: string): void {
  credNeedsReauth.delete(`${userId}:${provider}`);
}

function credBlacklisted(key: string): boolean {
  const until = brainCredBlacklist.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    brainCredBlacklist.delete(key);
    return false;
  }
  return true;
}

/**
 * Blacklist the credential(s) behind a failed brain turn so the next turn skips
 * them. Scoped to the provider the failed turn used (derived from backendId), so
 * a dead Codex sub doesn't also disable that member's working Claude sub. Wired
 * into PiBackend.onAuthFailure. Also flags the credential for re-login so the
 * owner sees a prompt instead of a silently-stalled board (`reason` is the same
 * for empty turns and hard auth errors — both mean the sub needs re-connecting).
 */
export function reportBrainAuthFailure(
  workspaceId: string,
  backendId: string,
  credentialKeys: string[],
  reason: AuthFailureReason,
): void {
  const provider = piProviderFromBackendId(backendId);
  // When the provider is known, blacklist only that provider's credentials — never
  // fall back to all keys, which would disable members' unrelated (working) subs.
  // Only when the provider can't be derived do we blacklist every backing key.
  const target = provider ? credentialKeys.filter((k) => k.endsWith(`:${provider}`)) : credentialKeys;
  const until = Date.now() + BRAIN_CRED_BLACKLIST_MS;
  for (const k of target) {
    brainCredBlacklist.set(k, until);
    credNeedsReauth.add(k);
  }
  if (target.length) {
    logger.warn("brain credential blacklisted — flagged for re-login", {
      workspaceId,
      backendId,
      keys: target,
      reason,
      minutes: BRAIN_CRED_BLACKLIST_MS / 60_000,
    });
  }
}

/** Mark the single member credential used by a worker-hosted background run as
 * unhealthy. Unlike an in-process brain turn, these runs cannot report their
 * credential key through PiBackend, so callers use this after recognizing the
 * standard expired-subscription response in the completed output. */
export function reportBackgroundRunAuthFailure(
  workspaceId: string,
  ownerUserId: string,
  backendId: string,
): void {
  const provider = piProviderFromBackendId(backendId);
  if (!provider) return;
  reportBrainAuthFailure(workspaceId, backendId, [`${ownerUserId}:${provider}`], "empty_turn");
}

/**
 * Build a workspace-scoped AuthStorage for the agent backend, or null when the
 * workspace has no usable credentials (so the backend falls back to local Pi
 * auth — the dev/single-tenant path). Wired into PiBackend.resolveAuth.
 *
 * Pools subscription (OAuth) credentials from every workspace member and
 * round-robins one per provider, skipping any credential excluded for this turn
 * (already tried) or currently blacklisted. The round-robin member pick takes
 * precedence over the workspace blob so it isn't shadowed by a previously-rotated
 * token. `credentialKeys` flows back so a failed turn blacklists the right
 * member's credential.
 */
export async function workspaceAuthStorage(workspaceId: string, exclude: string[] = []) {
  const blob = await loadBlob(workspaceId);
  const members = await workspaces.listMembers(workspaceId);
  const eligible = await userSecrets.listUsersWithSecret(members.map((m) => m.userId));

  // provider -> live candidate credentials from across the team.
  const byProvider = new Map<string, { key: string; cred: unknown }[]>();
  for (const userId of eligible) {
    const userBlob = await loadUserBlob(userId);
    for (const [provider, cred] of Object.entries(userBlob)) {
      if (!isOAuthCredential(cred)) continue;
      const key = `${userId}:${provider}`;
      if (exclude.includes(key) || credBlacklisted(key)) continue;
      const list = byProvider.get(provider) ?? [];
      list.push({ key, cred });
      byProvider.set(provider, list);
    }
  }

  const subBlob: AuthBlob = {};
  const credentialKeys: string[] = [];
  for (const [provider, candidates] of byProvider) {
    if (candidates.length === 0) continue;
    const rrKey = `${workspaceId}:${provider}`;
    const idx = (brainRoundRobin.get(rrKey) ?? 0) % candidates.length;
    brainRoundRobin.set(rrKey, idx + 1);
    const picked = candidates[idx]!;
    subBlob[provider] = picked.cred as AuthBlob[string];
    credentialKeys.push(picked.key);
  }

  // Round-robin member picks win over the workspace blob (which may hold a stale
  // rotated token); workspace API keys and any workspace-only provider survive.
  const merged = { ...blob, ...subBlob };
  if (Object.keys(merged).length === 0) return null;
  return { storage: authStorageFromBlob(merged), credentialKeys };
}

/**
 * Persist a (possibly token-rotated) auth blob from a brain turn. Routes each
 * provider's credential to its owner: pooled member credentials (identified by
 * `credentialKeys`, formatted "userId:provider") are written back to that
 * member's personal secret store, so a refreshed OAuth token isn't stranded in —
 * or shadowing the round-robin via — the workspace blob. Any remaining providers
 * (workspace-owned API keys, or a provider with no pooled owner) stay in the
 * workspace blob. Wired into PiBackend.onAuthChanged.
 */
export async function saveWorkspaceAuth(
  workspaceId: string,
  blob: AuthBlob,
  credentialKeys: string[] = [],
): Promise<void> {
  // provider -> owning userId, from the round-robin picks that backed this turn.
  const ownerByProvider = new Map<string, string>();
  for (const key of credentialKeys) {
    const sep = key.lastIndexOf(":");
    if (sep <= 0) continue;
    ownerByProvider.set(key.slice(sep + 1), key.slice(0, sep));
  }

  const byUser = new Map<string, AuthBlob>();
  const workspaceBlob: AuthBlob = {};
  for (const [provider, cred] of Object.entries(blob)) {
    const owner = ownerByProvider.get(provider);
    if (owner) {
      const u = byUser.get(owner) ?? {};
      u[provider] = cred;
      byUser.set(owner, u);
    } else {
      workspaceBlob[provider] = cred;
    }
  }

  // Merge each member's rotated provider(s) into their existing secret so other
  // providers they own are preserved. A successful rotation means the token is
  // healthy again, so clear any pending re-login flag for it.
  for (const [userId, providers] of byUser) {
    const existing = await loadUserBlob(userId);
    await saveUserBlob(userId, { ...existing, ...providers });
    for (const provider of Object.keys(providers)) clearCredentialReauth(userId, provider);
  }
  if (Object.keys(workspaceBlob).length) {
    const existing = await loadBlob(workspaceId);
    await saveBlob(workspaceId, { ...existing, ...workspaceBlob });
  }
}

/** The raw decrypted Pi auth.json blob for a workspace, or null if none stored.
 * Used to vend credentials into a cloud sandbox (written to ~/.pi/auth.json so
 * the in-sandbox Pi backend runs on the workspace's subscription). */
export async function getWorkspaceAuthBlob(workspaceId: string): Promise<AuthBlob | null> {
  const blob = await loadBlob(workspaceId);
  return Object.keys(blob).length === 0 ? null : blob;
}

export interface ModelsView {
  models: PiModelInfo[];
  providers: PiProviderStatus[];
  defaultModel: string | null;
  scoutModel: string | null;
  cardModels: string[];
}

const DEFAULT_CARD_BACKEND = "pi-openai-codex:gpt-5.6-sol";

function isOAuthCredential(cred: unknown): boolean {
  return Boolean(cred && typeof cred === "object" && (cred as Record<string, unknown>)["type"] === "oauth");
}

function oauthOnly(blob: AuthBlob): AuthBlob {
  return Object.fromEntries(Object.entries(blob).filter(([, cred]) => isOAuthCredential(cred)));
}

function apiKeyOnly(blob: AuthBlob): AuthBlob {
  return Object.fromEntries(
    Object.entries(blob).filter(([, cred]) => Boolean(cred && typeof cred === "object" && !isOAuthCredential(cred))),
  );
}

function piProviderFromBackendId(backendId?: string | null): string | null {
  if (!backendId?.startsWith("pi-")) return null;
  if (backendId === "pi-gpt-5.4" || backendId === "pi-gpt-5.5") return "openai-codex";
  const rest = backendId.slice("pi-".length);
  const provider = rest.includes(":") ? rest.split(":")[0] || null : "openai-codex";
  if (provider === "openai-codex") return "openai-codex";
  if (provider === "claude-bridge") return "claude-code";
  return provider;
}

function providerCredential(blob: AuthBlob, provider: string | null | undefined): unknown {
  return provider ? blob[provider] : undefined;
}

function hasOAuthForProvider(blob: AuthBlob, provider: string | null | undefined): boolean {
  return provider ? isOAuthCredential(providerCredential(blob, provider)) : Object.keys(oauthOnly(blob)).length > 0;
}

/** Auth used to list models available to a specific user in a workspace:
 * personal subscription providers plus workspace-level API keys. */
async function modelListingBlob(workspaceId: string, userId?: string): Promise<AuthBlob> {
  const wsBlob = await loadBlob(workspaceId);
  if (!userId) return wsBlob;

  const userOAuth = oauthOnly(await loadUserBlob(userId));
  // Legacy fallback: before subscriptions moved to UserSecret, OAuth lived in
  // the workspace secret. Keep those models visible for old workspaces.
  const subscriptionBlob = Object.keys(userOAuth).length ? userOAuth : oauthOnly(wsBlob);
  return { ...subscriptionBlob, ...apiKeyOnly(wsBlob) };
}

function preferredCardModelIds(settings: { defaultModel?: string | null; cardModels?: string[] | null }): string[] {
  return Array.from(new Set([settings.defaultModel, ...(settings.cardModels ?? [])].filter((x): x is string => !!x)));
}

/** Everything the settings UI needs: available models, provider statuses, config.
 * Pass userId to merge the caller's subscription (OAuth) credentials so
 * subscription-gated models (e.g. claude-bridge) appear in the picker. */
export async function getModelsView(workspaceId: string, userId?: string): Promise<ModelsView> {
  const [listingBlob, providerBlob, settings] = await Promise.all([
    modelListingBlob(workspaceId, userId),
    loadBlob(workspaceId),
    workspaces.getSettings(workspaceId),
  ]);
  return {
    models: listAvailableModels(authStorageFromBlob(listingBlob)),
    providers: listProviders(authStorageFromBlob(providerBlob)),
    defaultModel: settings.defaultModel ?? null,
    scoutModel: settings.scoutModel ?? null,
    cardModels: settings.cardModels ?? [],
  };
}

/** First model a newly-created card should run on for this user. Mirrors the
 * New-card picker order (workspace default + card models, else all available),
 * but skips stale/unavailable configured ids before falling back. */
export async function firstAvailableCardBackendForUser(workspaceId: string, userId?: string): Promise<string> {
  const view = await getModelsView(workspaceId, userId);
  const available = new Set(view.models.map((m) => m.id));
  return (
    preferredCardModelIds(view).find((id) => available.has(id)) ??
    view.models[0]?.id ??
    DEFAULT_CARD_BACKEND
  );
}

/** Resolve a task's persisted/explicit backend against the credentials that
 * will actually be vended to a cloud sandbox. This repairs stale Codex defaults
 * for users who only have another subscription provider (for example Claude
 * Code OAuth) before the sandbox starts and fails with a provider-specific auth
 * error. If there are no vendable credentials, keep the requested backend so
 * dev/local-image defaults continue to fail clearly at turn time. */
export async function resolveCloudTaskBackend(
  workspaceId: string,
  createdBy: string | null | undefined,
  requested: string,
): Promise<{ backend: string; changed: boolean; availableModels: string[] }> {
  const blob =
    (await getTaskAuthBlob(workspaceId, createdBy, requested)) ??
    (await getTaskAuthBlob(workspaceId, createdBy));
  if (!blob) return { backend: requested, changed: false, availableModels: [] };

  const models = listAvailableModels(authStorageFromBlob(blob));
  const availableModels = models.map((m) => m.id);
  if (availableModels.includes(requested)) return { backend: requested, changed: false, availableModels };

  const preferred = await firstAvailableCardBackendForUser(workspaceId, createdBy ?? undefined);
  const fallback = availableModels.includes(preferred) ? preferred : availableModels[0];
  return fallback
    ? { backend: fallback, changed: fallback !== requested, availableModels }
    : { backend: requested, changed: false, availableModels };
}

/** Normalize a pasted credential into Pi's `{ type, ... }` shape. Accepts the
 * stored auth.json value (already tagged), a bare OAuth credential, or a bare
 * API key object. */
function normalizeCredential(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj["type"] === "string") return obj; // already { type: "oauth" | "api_key", ... }
    if (typeof obj["access"] === "string" && typeof obj["refresh"] === "string") {
      return { type: "oauth", ...obj };
    }
    if (typeof obj["token"] === "string") return { type: "oauth", token: obj["token"] };
    if (typeof obj["key"] === "string") return { type: "api_key", key: obj["key"] };
  }
  throw new Error("Unrecognized credential format");
}

export interface SetProviderInput {
  /** An API key to store as `{ type: "api_key", key }`. */
  apiKey?: string;
  /** A pasted credential (object or JSON string). A bare OAuth credential, a
   * tagged credential, or a whole auth.json (provider → credential) map. */
  authJson?: unknown;
}

/** Store/replace credentials for a provider. Returns the refreshed view. */
export async function setProvider(
  workspaceId: string,
  provider: string,
  input: SetProviderInput,
  userId?: string,
): Promise<ModelsView> {
  const blob = await loadBlob(workspaceId);
  const auth = authStorageFromBlob(blob);

  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    setRawCredential(auth, provider, { type: "api_key", key: input.apiKey.trim() });
  } else if (input.authJson !== undefined && input.authJson !== null && input.authJson !== "") {
    const parsed =
      typeof input.authJson === "string" ? (JSON.parse(input.authJson) as unknown) : input.authJson;
    if (
      parsed &&
      typeof parsed === "object" &&
      !("type" in (parsed as object)) &&
      !("access" in (parsed as object)) &&
      !("token" in (parsed as object)) &&
      !("key" in (parsed as object))
    ) {
      // A whole auth.json: provider → credential. Merge every entry.
      for (const [p, cred] of Object.entries(parsed as Record<string, unknown>)) {
        setRawCredential(auth, p, normalizeCredential(cred));
      }
    } else {
      setRawCredential(auth, provider, normalizeCredential(parsed));
    }
  } else {
    throw new Error("apiKey or authJson required");
  }

  await saveBlob(workspaceId, authBlob(auth));
  return getModelsView(workspaceId, userId);
}

/** Remove a provider's credentials. Returns the refreshed view. */
export async function removeProvider(workspaceId: string, provider: string, userId?: string): Promise<ModelsView> {
  const blob = await loadBlob(workspaceId);
  const auth = authStorageFromBlob(blob);
  removeCredential(auth, provider);
  await saveBlob(workspaceId, authBlob(auth));
  return getModelsView(workspaceId, userId);
}

/** Update the workspace's model settings (brain default, scout, card-picker). */
export async function updateModelSettings(
  workspaceId: string,
  patch: { defaultModel?: string | null; scoutModel?: string | null; cardModels?: string[] },
  userId?: string,
): Promise<ModelsView> {
  const settingsPatch: { defaultModel?: string | undefined; scoutModel?: string | undefined; cardModels?: string[] } = {};
  if (patch.defaultModel !== undefined) {
    // null clears the workspace default (revert to the server/global default —
    // the "Auto" choice). updateSettings drops the undefined key from the blob.
    settingsPatch.defaultModel = patch.defaultModel ?? undefined;
  }
  if (patch.scoutModel !== undefined) {
    // null clears it → Scout auto-picks a cheap available model per workspace.
    settingsPatch.scoutModel = patch.scoutModel ?? undefined;
  }
  if (patch.cardModels !== undefined) settingsPatch.cardModels = patch.cardModels;
  await workspaces.updateSettings(workspaceId, settingsPatch);
  return getModelsView(workspaceId, userId);
}

/** Resolve the backend id a brain turn should use for a workspace: the
 * configured default model, else the provided fallback (global default). */
export async function brainBackendIdFor(workspaceId: string, fallback: string): Promise<string> {
  const settings = await workspaces.getSettings(workspaceId);
  return settings.defaultModel || fallback;
}

/**
 * Resolve the backend id a Scout turn should use for a workspace: the configured
 * scout model, else the cheapest model available to THIS workspace's
 * credentials (falling back to its brain default). Returns null when the
 * workspace has no stored credentials, so the caller can fall back to a plain
 * text digest instead of running an LLM turn on the server's ambient creds.
 */
export async function resolveScoutBackendId(workspaceId: string): Promise<string | null> {
  const [blob, settings] = await Promise.all([loadBlob(workspaceId), workspaces.getSettings(workspaceId)]);
  if (settings.scoutModel) return settings.scoutModel;
  if (Object.keys(blob).length === 0) return null;
  return pickScoutBackendIdForAuth(authStorageFromBlob(blob), settings.defaultModel);
}

// ── Per-user credentials (subscription providers like Codex) ─────────────────

async function loadUserBlob(userId: string): Promise<AuthBlob> {
  const row = await userSecrets.get(userId);
  if (!row) return {};
  try {
    return decryptJson<AuthBlob>(Buffer.from(row.ciphertext));
  } catch (err) {
    logger.error("failed to decrypt user secret", { userId, err });
    return {};
  }
}

async function saveUserBlob(userId: string, blob: AuthBlob): Promise<void> {
  const providers = Object.keys(blob);
  await userSecrets.upsert(userId, encryptJson(blob), { providers });
}

/** The raw decrypted Pi auth.json blob for a user, or null if none stored. */
export async function getUserAuthBlob(userId: string): Promise<AuthBlob | null> {
  const blob = await loadUserBlob(userId);
  return Object.keys(blob).length === 0 ? null : blob;
}

/** Provider statuses for a user's personal credentials, with the runtime
 * re-login flag merged in (the stored blob alone can't tell us a refresh failed). */
export async function getUserProvidersView(userId: string): Promise<{ providers: PiProviderStatus[] }> {
  const blob = await loadUserBlob(userId);
  const auth = authStorageFromBlob(blob);
  const providers = listProviders(auth)
    .filter((p) => p.authKind === "subscription")
    .map((p) => ({ ...p, needsReauth: credentialNeedsReauth(userId, p.id) }));
  return { providers };
}

/** Persist a provider credential into the user's personal secret store. */
export async function setUserProvider(
  userId: string,
  provider: string,
  input: SetProviderInput,
): Promise<{ providers: PiProviderStatus[] }> {
  const blob = await loadUserBlob(userId);
  const auth = authStorageFromBlob(blob);
  // Track every provider actually written so we clear the re-login flag for all
  // of them (an authJson blob can carry multiple providers, not just the route param).
  const written = new Set<string>();
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    setRawCredential(auth, provider, { type: "api_key", key: input.apiKey.trim() });
    written.add(provider);
  } else if (input.authJson !== undefined && input.authJson !== null && input.authJson !== "") {
    const parsed =
      typeof input.authJson === "string" ? (JSON.parse(input.authJson) as unknown) : input.authJson;
    if (
      parsed &&
      typeof parsed === "object" &&
      !("type" in (parsed as object)) &&
      !("access" in (parsed as object)) &&
      !("token" in (parsed as object)) &&
      !("key" in (parsed as object))
    ) {
      for (const [p, cred] of Object.entries(parsed as Record<string, unknown>)) {
        setRawCredential(auth, p, normalizeCredential(cred));
        written.add(p);
      }
    } else {
      setRawCredential(auth, provider, normalizeCredential(parsed));
      written.add(provider);
    }
  } else {
    throw new Error("apiKey or authJson required");
  }
  await saveUserBlob(userId, authBlob(auth));
  // Reconnecting a provider is the explicit fix for the re-login prompt — clear
  // the flag for every provider this call wrote.
  for (const p of written) clearCredentialReauth(userId, p);
  return getUserProvidersView(userId);
}

/** Remove a provider's credential from the user's personal store. */
export async function removeUserProvider(
  userId: string,
  provider: string,
): Promise<{ providers: PiProviderStatus[] }> {
  const blob = await loadUserBlob(userId);
  const auth = authStorageFromBlob(blob);
  removeCredential(auth, provider);
  await saveUserBlob(userId, authBlob(auth));
  return getUserProvidersView(userId);
}

/** Persist token-rotated user auth (called by PiBackend.onAuthChanged for
 * user-scoped turns, and by the worker daemon when its local OAuth token rotates
 * — closing the laptop→server gap that otherwise stranded the server on an
 * already-rotated refresh token). Merges so unrelated providers are preserved,
 * and clears the re-login flag for every provider in the refreshed blob. */
export async function saveUserAuth(userId: string, blob: AuthBlob): Promise<void> {
  const existing = await loadUserBlob(userId);
  await saveUserBlob(userId, { ...existing, ...blob });
  for (const provider of Object.keys(blob)) clearCredentialReauth(userId, provider);
}

function blobMatchesRequiredProvider(blob: AuthBlob, requiredProvider: string | null): boolean {
  return !requiredProvider || Boolean(providerCredential(blob, requiredProvider));
}

/** The task creator's own user-scoped credentials, optionally requiring the
 * provider used by a backend. Used for laptop dispatch only: never borrows
 * another workspace member's OAuth credential. */
export async function getTaskOwnerAuthBlob(
  createdBy: string | null | undefined,
  backendId?: string | null,
): Promise<AuthBlob | null> {
  if (!createdBy) return null;
  const requiredProvider = piProviderFromBackendId(backendId);
  const blob = await loadUserBlob(createdBy);
  if (!blobMatchesRequiredProvider(blob, requiredProvider)) return null;
  return Object.keys(blob).length === 0 ? null : blob;
}

/** Build the composite auth blob for a cloud task:
 *   - Subscription providers from the task creator's UserSecret when it has the
 *     requested backend provider.
 *   - Otherwise rotate through workspace members who have that provider.
 *   - Legacy fallback: workspace-level OAuth creds (WorkspaceSecret kind="pi").
 *   - API-key providers always from WorkspaceSecret.
 * Returns null only when no credentials matching the requested provider are
 * found, or absolutely no credentials are found when no backend is specified.
 */
export async function getTaskAuthBlob(
  workspaceId: string,
  createdBy: string | null | undefined,
  backendId?: string | null,
): Promise<AuthBlob | null> {
  const requiredProvider = piProviderFromBackendId(backendId);
  const wsBlob = await loadBlob(workspaceId);
  const apiKeyEntries = Object.entries(apiKeyOnly(wsBlob));

  let subBlob: AuthBlob = {};
  if (createdBy) {
    const creatorBlob = await loadUserBlob(createdBy);
    if (hasOAuthForProvider(creatorBlob, requiredProvider)) subBlob = oauthOnly(creatorBlob);
  }

  if (Object.keys(subBlob).length === 0) {
    const members = await workspaces.listMembers(workspaceId);
    const eligible = await userSecrets.listUsersWithSecret(members.map((m) => m.userId));
    const candidates: { userId: string; blob: AuthBlob }[] = [];
    for (const userId of eligible) {
      const userBlob = await loadUserBlob(userId);
      if (hasOAuthForProvider(userBlob, requiredProvider)) candidates.push({ userId, blob: userBlob });
    }
    if (candidates.length > 0) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      if (picked) subBlob = oauthOnly(picked.blob);
    }
  }

  // Legacy fallback: workspace-level OAuth (e.g. old `pi /login` flow)
  if (Object.keys(subBlob).length === 0) {
    const legacyOAuth = Object.entries(wsBlob).filter(
      ([provider, cred]) =>
        (!requiredProvider || provider === requiredProvider) &&
        cred &&
        typeof cred === "object" &&
        (cred as Record<string, unknown>)["type"] === "oauth",
    );
    subBlob = Object.fromEntries(legacyOAuth);
  }

  const merged = { ...subBlob, ...Object.fromEntries(apiKeyEntries) };
  if (!blobMatchesRequiredProvider(merged, requiredProvider)) return null;
  return Object.keys(merged).length === 0 ? null : merged;
}

/** Credentials safe to vend back to a specific user's repo-chat daemon: that
 * user's own OAuth subscriptions plus workspace-managed API keys. Unlike task
 * failover, this must never borrow another member's personal OAuth credential. */
export async function getRepoChatAuthBlob(workspaceId: string, userId: string): Promise<AuthBlob | null> {
  const [workspaceBlob, userBlob] = await Promise.all([loadBlob(workspaceId), loadUserBlob(userId)]);
  const blob = { ...apiKeyOnly(workspaceBlob), ...oauthOnly(userBlob) };
  return Object.keys(blob).length === 0 ? null : blob;
}

/** Models whose credentials may safely be sent to this user's local daemon. */
export async function getRepoChatModels(workspaceId: string, userId: string): Promise<PiModelInfo[]> {
  const blob = await getRepoChatAuthBlob(workspaceId, userId);
  return listAvailableModels(authStorageFromBlob(blob ?? {}));
}

/** True if this member's stored OAuth credential for `provider` is usable right
 * now — present, not in the failover blacklist, and not flagged for re-login. */
function memberHasHealthyProvider(blob: AuthBlob, userId: string, provider: string): boolean {
  if (!isOAuthCredential(providerCredential(blob, provider))) return false;
  const key = `${userId}:${provider}`;
  return !credBlacklisted(key) && !credNeedsReauth.has(key);
}

// Round-robin index for background-run owner selection, keyed by workspace, so a
// workspace's spot checks spread across everyone with a live subscription rather
// than always hitting the same member. In-memory is fine — see the brain pool.
const backgroundRunRoundRobin = new Map<string, number>();

// Subscription providers a background run may farm out to, in preference order
// (Codex first). Restricting to these keeps an unrelated OAuth credential from
// being picked as the owner and resolving to a backend the member can't run.
const BACKGROUND_RUN_PROVIDERS = ["openai-codex", "claude-code"] as const;

/** The backend id to run for a member's chosen subscription provider. Honors the
 * workspace's configured default/card models when they belong to that provider,
 * else the requested backend when it does, else the provider's first available
 * model. `storedProvider` is the credential key ("openai-codex" / "claude-code");
 * Claude subscriptions run through the "claude-bridge" model provider. */
function backendForMemberProvider(view: ModelsView, storedProvider: string, requested: string): string {
  const modelProvider = storedProvider === "claude-code" ? "claude-bridge" : storedProvider;
  const inProvider = (id: string) => view.models.find((m) => m.id === id)?.provider === modelProvider;
  return (
    preferredCardModelIds(view).find((id) => inProvider(id)) ??
    (inProvider(requested) ? requested : undefined) ??
    view.models.find((m) => m.provider === modelProvider)?.id ??
    requested
  );
}

/**
 * Pick the owner + backend a brain-style background run (e.g. a spot check)
 * should use. Cloud/laptop runs bake in a single owner's credential
 * (getTaskAuthBlob / getTaskOwnerAuthBlob) with no per-turn failover like the
 * brain's in-process pool, so a run that lands on a member whose sub is dead
 * stalls with an empty turn. This pre-selects a member with a *live* subscription:
 *   - Draw from the whole pool of members whose Codex or Claude credential is
 *     healthy (present, not blacklisted, not flagged for re-login), round-robin so
 *     load spreads across the team.
 *   - Run on whichever provider that member holds — preferring Codex when the
 *     picked member has it, otherwise their Claude (or other) subscription.
 * When nobody has a usable subscription, returns the requested backend with no
 * explicit owner so the caller's existing owner/venue fallback still applies.
 */
export async function pickBackgroundRunOwner(
  workspaceId: string,
  requestedBackendId: string,
): Promise<{ createdBy?: string; backendId: string }> {
  const members = await workspaces.listMembers(workspaceId);
  const eligible = await userSecrets.listUsersWithSecret(members.map((m) => m.userId));

  // Every member with at least one healthy Codex or Claude subscription, plus the
  // providers they can serve. This is the pool of users who have either live.
  const pool: { userId: string; providers: string[] }[] = [];
  for (const userId of eligible) {
    const blob = await loadUserBlob(userId);
    const providers = BACKGROUND_RUN_PROVIDERS.filter((provider) => memberHasHealthyProvider(blob, userId, provider));
    if (providers.length > 0) pool.push({ userId, providers });
  }
  if (pool.length === 0) return { backendId: requestedBackendId };

  // Stable order + a per-workspace cursor so successive runs rotate members.
  pool.sort((a, b) => a.userId.localeCompare(b.userId));
  const idx = (backgroundRunRoundRobin.get(workspaceId) ?? 0) % pool.length;
  backgroundRunRoundRobin.set(workspaceId, idx + 1);
  const picked = pool[idx]!;

  // Prefer Codex when the picked member has it; otherwise run whatever they hold
  // (providers is already restricted to Codex/Claude, ordered Codex-first).
  const provider = picked.providers[0]!;
  const view = await getModelsView(workspaceId, picked.userId);
  const backendId = backendForMemberProvider(view, provider, requestedBackendId);
  return { createdBy: picked.userId, backendId };
}
