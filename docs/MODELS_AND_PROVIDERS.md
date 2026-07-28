# Models & Providers (per-workspace LLM credentials)

Implements the resolved decision "**per-workspace LLM keys**" (DEPLOYMENT.md §6).
Each workspace configures which AI models power its brain and workers, and stores
the provider credentials (a shared Codex subscription, or API keys) that make
those models available — all from **Settings → Models** in the UI.

## How it works

### Storage
- Credentials live in one encrypted row per workspace: `WorkspaceSecret` with
  `kind = "pi"`. The plaintext is a **Pi `auth.json` blob** — `Record<provider,
  credential>`, exactly the shape Pi's `AuthStorage` reads.
- Encryption is **AES-256-GCM** (`apps/server/src/secrets/crypto.ts`). The key is
  derived (scrypt) from `SECRETS_KEY`, falling back to `SESSION_SECRET` in dev.
  The stored Bytes are `iv(12) || authTag(16) || ciphertext`.
- Model **settings** (default model, extra new-card models) live in the
  `Workspace.settings` JSON column (`workspaces.WorkspaceSettings`).

### Serving turns
- `PiBackend` (packages/agent) takes an injected `resolveAuth(workspaceId)` →
  `AuthStorage | null`. The server wires this to `models/service.ts`
  `workspaceAuthStorage`, which decrypts the blob into an in-memory `AuthStorage`.
  When a workspace has no stored credentials, it returns `null` and the backend
  falls back to the **local Pi auth store** (`pi /login`) — the dev/single-tenant
  path, unchanged.
- After a turn, if Pi rotated an OAuth token in place, `onAuthChanged` re-encrypts
  and persists the updated blob (`saveWorkspaceAuth`).
- The **brain** (in-server) and the **in-process cloud bot** both use this. Local
  worker daemons run on the user's own machine with their own Pi auth, so the
  resolver doesn't affect them.
- Brain + new-card **model selection** reads `settings.defaultModel`
  (ws.ts, workspaces/routes.ts chat + card create), falling back to the global
  startup default (`pickBrainBackendId`).

### API (all membership-gated, under `/api/workspaces/:id`)
- `GET  /models` → `{ models, providers, defaultModel, cardModels }`
- `PUT  /models` `{ defaultModel?, cardModels? }`
- `PUT  /providers/:provider` `{ apiKey? } | { authJson? }`
- `DELETE /providers/:provider`

## Setting up a shared Codex subscription

Manta uses an OpenAI Codex (ChatGPT) subscription via Pi's OAuth, the same as a
local `pi /login`. To share one subscription across the cloud brain + workers:

1. On any machine, run `pi /login` and choose **OpenAI Codex**. This writes the
   OAuth credential to `~/.pi/auth.json`.
2. In Manta: **Settings → Models → Provider logins → ChatGPT Codex → Configure**.
3. Paste the contents of `~/.pi/auth.json` (or just the `openai-codex` entry).
   Manta stores it encrypted and the Codex models appear in the model pickers.
4. Set it as the **Default model** (and add any extra models to the new-card list).

API-key providers (Anthropic, OpenAI, OpenRouter, …) are the same flow but take a
key instead of pasted JSON.

## Known limitations / follow-ups
- **OAuth refresh in multi-instance deploys**: token rotation is persisted
  best-effort after each turn (last-writer-wins). If OpenAI rotates refresh tokens
  on every use, concurrent instances could briefly contend. Single-instance and
  the common case are fine. A DB-backed `AuthStorageBackend` with locking would
  make this airtight.
- **Codex onboarding is paste-based.** A future improvement: a `manta` CLI / daemon
  command that uploads the local `auth.json` entry directly, or a hosted OAuth
  callback so the user never copies JSON.
- Scout/health-check/Slack brain turns still use the global default model; only the
  interactive brain chat + card creation honor `defaultModel` so far.
- **Server env vars also count as configured providers.** Pi's model registry
  resolves auth from the in-memory blob *and* process env / `~/.pi/models.json`.
  So a provider key in the server environment surfaces its models in every
  workspace's available list (a deliberate server-wide fallback). Per-workspace
  pasted credentials are layered on top.
