# worker-daemon

A per-user worker. It does NOT use a shared secret. On first start with no
stored credential it runs a one-time browser pairing:

## Terminal hosting

The interactive terminal for a task runs HERE (the PTY must be next to the
worktree the agent edits), via `TerminalManager` from `@manta/shared/terminal`.
Two transports reach the same PTY:
- **Relay** — `terminal_*` frames over the existing `/worker-ws` socket
  (`terminal_open`/`input`/`resize`/`close` in; `terminal_output`/`ready`/`exit`/
  `error` out, keyed by `sessionId`). Works everywhere, incl. cloud.
- **Direct** — a loopback `ws` server on `127.0.0.1:<random>`, advertised as
  `terminalPort` in the `register` message, for a browser on the **same machine**
  (no server hop). The browser presents a server-minted token; we only accept it
  if the server vouched for it over `/worker-ws` (`terminal_grant`), so arbitrary
  local processes can't attach. Set `MANTA_DIRECT_TERMINAL=0` to disable (remote/
  Daytona workers, where the browser is never on the same host — relay only).

On first start with no stored credential it runs a one-time browser pairing:

1. `bootstrap()` looks for a token in `~/.manta/worker-credentials.json` keyed by
   `MANTA_SERVER_URL`. If found, it connects; if not, it pairs.
2. `pair()` starts a loopback HTTP listener on `127.0.0.1:<random>`, opens
   `${SERVER_HTTP}/pair-worker?callback=…&state=…&name=…` in the browser (the
   server redirects to the SPA pairing view), and waits for the SPA to redirect
   back to `/cb?token=…&state=…`. The `state` nonce is verified before accepting.
3. The token is persisted (mode 0600) and reused forever.

The token is sent as `{ type: "register", token }` over `/worker-ws` and as
`Authorization: Bearer <token>` for `/api/worker` HTTP calls. If the server
rejects registration (revoked/invalid token), `onclose` clears the stored
credential and re-pairs rather than exiting.

## `login` command — connect a Codex subscription

`node --experimental-transform-types src/daemon.ts login [codex]` connects an
LLM provider credential instead of serving tasks, then exits. Today only Codex
is wired (the optional `codex` arg is ignored).

Flow: `ensureToken()` (reuse/pair the per-user token) → `loginCodex()` runs the
ChatGPT Codex OAuth flow **on this machine** (pi-ai binds `localhost:1455` and
opens the browser — a hosted server can't receive OpenAI's localhost redirect,
which is why capture happens daemon-side) → POST the captured `{type:"oauth",…}`
blob to `POST /api/worker/providers/openai-codex` (Bearer worker token). The
server encrypts it per workspace (`setProvider` → `WorkspaceSecret` kind `pi`);
the brain and workers then resolve it via the per-workspace AuthStorage, so they
run on the user's Codex subscription. The access token auto-refreshes from the
stored refresh token, and rotations persist back via `onAuthChanged`.

Target workspace: `MANTA_WORKSPACE_ID`, else the user's only workspace, else an
interactive pick (server lists them at `GET /api/worker/workspaces`).

Gotchas:
- Any HTML written to the loopback response needs `Content-Type: text/html;
  charset=utf-8` or UTF-8 (emoji) renders as mojibake.
- The callback must stay loopback-only; the SPA refuses to send the token to a
  non-loopback host (open-redirect / token-leak guard).

## Viewing connected providers & re-syncing credentials

There is **no worker-side list command** — the daemon only does `login`.
Credentials live **per-workspace** (encrypted `WorkspaceSecret` kind `pi`), so
"which providers am I logged in as" is a workspace property, viewed server-side:

- Web UI: Workspace Settings → **Models** tab → "Provider logins" (status:
  *Not configured* / *API key set* / *Logged in*, plus model count).
- API: `GET /api/workspaces/:id/models` → `{ models, providers, defaultModel,
  cardModels }`; `providers` (`PiProviderStatus[]`) is built by `listProviders()`
  in `packages/agent/src/pi-backend.ts`.

Syncing the latest credentials:
- **Automatic:** OAuth tokens refresh mid-turn; `PiBackend.runTurn` diffs the
  auth blob and persists rotations via `onAuthChanged` → `saveWorkspaceAuth`
  (`apps/server/src/models/service.ts`, wired in `server.ts`). No action needed.
- **Manual re-login:** re-run `daemon.ts login codex` to capture and upload a
  fresh blob, overwriting the stored credential. There is no separate "sync"
  command — `login` is how you force a fresh credential. API-key providers
  (Anthropic/OpenAI/etc.) are set via the web UI, not the daemon.
