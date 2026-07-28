# Manta 🪼

Engineering orchestrator. A **brain** agent on the server chats with you, spawns autonomous coding **workers** that clone repos, write code, open PRs, and update Linear — all tracked on a kanban board.

## Architecture

```
Browser  ←──WS──→  Server (Hono :3020)  ←──WS──→  Worker daemon(s)
                        │
                   SQLite · Brain (Pi)
```

The server and worker(s) run as separate processes. Workers can be on any machine with access to the repos.

---

## Quick start

### 1. Prerequisites

- Node 24+, pnpm 10+
- [Pi CLI](https://pi.ai/cli) installed and authenticated (workers use it to run agent turns)

No database to install — Manta uses **SQLite**, stored as a file.

### 2. Install

```bash
pnpm install
```

### 3. Database

```bash
# Creates the SQLite file and applies every migration
pnpm db:setup
```

`pnpm db:reset` wipes it and starts over.

### 4. Environment — server

Everything below is optional. With no `apps/server/.env` at all, the server boots,
creates `packages/db/prisma/dev.db`, and offers passwordless email sign-in — enough
to click through the whole product locally.

Create `apps/server/.env` to change any of it:

```env
DATABASE_URL=file:./dev.db          # relative to packages/db/prisma/
SESSION_SECRET=any-random-string

# Google OAuth — optional. Omit it and the login page offers email sign-in only.
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3020/api/auth/google/callback

# GitHub App (single shared App for the deployment; workspaces install it per-org)
GITHUB_APP_ID=...                 # App id — mints repo-scoped installation tokens
GITHUB_APP_PRIVATE_KEY=...        # App private key (PEM; \n-escaped is fine)
GITHUB_APP_SLUG=your-app-slug     # from github.com/apps/<slug> — builds the install URL
GITHUB_APP_CLIENT_ID=...          # OAuth client id — per-user "Link GitHub" flow
GITHUB_APP_CLIENT_SECRET=...      # OAuth client secret
GITHUB_WEBHOOK_SECRET=...         # verifies inbound App webhooks
# In the GitHub App settings, point:
#   Setup URL            → <web>/api/integrations/github/callback
#   User auth callback   → <web>/api/integrations/github/me/callback
#   Webhook URL          → <web>/api/integrations/github/webhook
#   Permissions: contents:write, pull_requests:write, metadata:read
#   Events: installation, installation_repositories, pull_request

# Optional integrations
LINEAR_API_KEY=lin_api_...        # Linear board read/write
LINEAR_WEBHOOK_SECRET=...         # Linear → Manta webhooks
SLACK_BOT_TOKEN=xoxb-...          # Slack notifications
SLACK_SIGNING_SECRET=...          # Slack event verification
MANTA_HEALTH_CHECK_SLACK_CHANNEL=C... # Channel for daily health reports
```

> GitHub is now per-workspace: connect the App from **Settings → Integrations → GitHub**,
> then add repos from the installation picker. The old shared `GITHUB_TOKEN` PAT is no
> longer used for PR state, file trees, or scout — those mint installation tokens scoped
> to each workspace. Local workers still push as the developer's own `gh` credentials.

### 5. Start the server

```bash
pnpm server
# Listening on http://localhost:3020
```

### 6. Start a worker daemon

On the same machine (or any machine that can reach the server):

```bash
./start-worker
```

For a local development server, use:

```bash
./start-local-worker
```

**First run pairs the daemon to your account.** It opens your browser to approve
("Pair worker as you@example.com"); the resulting per-user token is saved to
`~/.manta/worker-credentials.json` and reused on every later start — no shared
secret. Tasks **you** create route to your own daemon; everyone else's fall back
to the in-process cloud bot when your daemon isn't connected.

**Worker env vars:**

| Var | Default | Notes |
|-----|---------|-------|
| `MANTA_SERVER_URL` | `wss://manta.example.com` | WebSocket URL of the server (`./start-local-worker` defaults to `ws://localhost:3020`) |
| `WORKER_ID` | `hostname-pid` | Stable name shown in logs |

The worker manages its own cached repo clones under `~/.manta/repos/` and creates task worktrees under `~/.manta/worktrees/`.

On interactive starts, `./start-worker` asks whether to install itself as a login service (macOS launchd or Linux systemd user service) so it resumes automatically after restart/login.

You can also manage the service explicitly:

```bash
./start-worker --install-service
./start-worker --uninstall-service
```

Service launches use `./start-worker --non-interactive` so they never block on the install prompt.

On Linux, the user service starts when you log in. To allow boot-before-login, run `loginctl enable-linger $USER`.

### 7. Start the web UI

```bash
pnpm web
# http://localhost:5173
```

---

## Using Manta

1. Open `http://localhost:5173`, sign in with Google.
2. Create a workspace, add repos (Repos button in the header).
3. Chat with the brain in the left sidebar — "implement X in acme/myrepo".
4. The brain creates a task card and dispatches it to a worker. Watch the Terminal tab for live output.
5. When the worker opens a PR, the card moves to **Ready to Test**.

**Keyboard shortcuts on the board:** arrow keys to navigate, Enter to open, C to create a card.

---

## Development

```bash
pnpm test          # 62 tests (unit + integration)
pnpm typecheck     # tsc across all packages
```

### Monorepo layout

```
apps/
  server/         Hono on Node 24 — brain, worker dispatch, WS hub, webhooks, REST
  web/            React 19 + Vite SPA
  worker-daemon/  External worker process — Pi agent, git worktrees, PR creation
packages/
  shared/         Kanban state machine, event protocol, types
  db/             Prisma schema + workspace-scoped query layer
  agent/          Pi/Claude backend abstraction + tool registry
```

### Key env vars (server)

All optional — the server runs with none of them set:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | SQLite file URL (default `file:./dev.db`, relative to `packages/db/prisma/`) |
| `GOOGLE_CLIENT_ID/SECRET` | Google OAuth |
| `GITHUB_APP_ID/PRIVATE_KEY` | Mint per-workspace repo-scoped installation tokens |
| `GITHUB_APP_SLUG` | Builds the App install URL |
| `GITHUB_APP_CLIENT_ID/SECRET` | Per-user "Link GitHub" OAuth (powers "my PRs") |
| `GITHUB_WEBHOOK_SECRET` | GitHub App webhook HMAC verification |
| `LINEAR_API_KEY` | Linear board tools |
| `LINEAR_WEBHOOK_SECRET` | Linear webhook HMAC verification |
| `SLACK_BOT_TOKEN` | Slack notifications + support triage |
| `SLACK_SIGNING_SECRET` | Slack event verification |
| `MANTA_HEALTH_CHECK_SLACK_CHANNEL` | Channel ID for daily health reports (`SLACK_SPOTCHECK_CHANNEL` is still accepted for backwards compatibility) |
