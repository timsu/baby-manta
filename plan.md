# Manta — Plan / Remaining Work

Running list of what's left, organized into delivery milestones. Each milestone
is a vertical slice that ships a complete user story. Phase numbers refer to
`docs/ROADMAP.md`.

---

## M1 — Complete the core loop ✦ DONE

> Goal: a worker can open a PR and it shows up on the card. Everything else builds on this.

- [x] **Brain session resume.** `packages/db/src/agent-sessions.ts` + wired into
  `ws.ts` chat handler: brain now resumes its Pi session across turns.
- [x] **GitHub App scaffolding.** `apps/server/src/github/app.ts`: JWT minting +
  `mintInstallationToken()`. Activate by setting `GITHUB_APP_ID` +
  `GITHUB_APP_PRIVATE_KEY`. Needs App id + private key from owner to go live.
- [x] **Worker → PR loop.** `apps/server/src/worker/tools.ts`: `report_pr` tool
  (+ `get_github_token` when App is configured). Worker prompt updated to commit →
  push → `gh pr create` → `report_pr`. `report_pr` sets `prNumber`/`prUrl`/
  `prState`, transitions `bot_working → ready_to_test`.
- [x] **PR card UI.** PR badge on board cards and task detail header: CI dot
  (green/red/yellow), PR #number, links to GitHub. New fields in `TaskCard` type
  (`prNumber`, `prState`, `checksStatus`, `branch`).
- [x] **Poller.** `apps/server/src/poller.ts`: stall detection (30 min → brain
  inbox) + PR state refresh from GitHub (needs `GITHUB_TOKEN` env var). Starts
  on server boot via `startPoller()`. Inbox wired: `packages/db/src/inbox.ts` +
  brain WS handler now fetches + drains pending items.

---

## M2 — Worker UX ✦ DONE

> Goal: daily use is pleasant; engineers can watch, interrupt, and direct workers.

- [x] **Terminal pane** — `apps/server/src/terminal.ts` (node-pty PTY sessions, per-task,
  output buffer for reconnect replay). `/terminal` WS route in `ws.ts`. xterm.js
  `TerminalPane` component in UI with ResizeObserver-driven fit. Tab appears in
  TaskDetail when task has a branch.
- [x] **Checklist UI** — TaskDetail now has Chat | Checklist | Terminal tabs. Checklist
  tab shows items with checkboxes; toggle calls `PATCH /:id/tasks/:taskId/checklist`.
  Also shows original description in collapsible `<details>`. New endpoints:
  `GET /:id/tasks/:taskId` (full detail), `PATCH .../checklist`, `PATCH .../status`.
- [x] **Drag-drop board** — HTML5 drag-drop on board cards and column drop targets.
  Validated with `isUserDragAllowed` on the client before calling `PATCH .../status`.
  Visual: dragging card dims to 40%, valid drop targets highlight blue, invalid dim.
- [x] **Bash safety backstop** — worker system prompt now includes hard-limit safety
  rules (no `rm -rf`, no force-push, no destructive DB commands, work-only-in-worktree).
- [ ] **Image attachments** — deferred: needs multimodal support in Pi backend.
- [ ] **Context window %** — deferred: needs token-count API from Pi session.

---

## M3 — Automation (always-on)

> Goal: Manta notices things and acts without being prompted.

- [x] **Slack outbound DMs**: `apps/server/src/slack/notify.ts` — poller detects
  tasks at `done`/`needs_help`/`ready_to_test` with `slackDmSent=false` and posts
  to their originating Slack thread. Uses `SLACK_BOT_TOKEN`.
- [x] **Linear webhook ingress**: `apps/server/src/linear/routes.ts` — HMAC-verified
  (`LINEAR_WEBHOOK_SECRET`) webhook receiver at `POST /api/linear/webhook`. Routes
  events by `organizationId` → Manta workspace via `WorkspaceIdentity`. Issue +
  Comment events → brain inbox. Setup endpoint: `POST /api/linear/setup`.
- [x] **Slack #support auto-triage**: `list_linear_teams` + `create_linear_issue`
  brain tools added (backed by `LinearDriver` interface, wired in `server.ts` when
  `LINEAR_API_KEY` is set). Brain already runs on support channels via
  `handleChannelMessage`; operators set triage `instructions` per-channel (e.g.
  "Create a Linear issue and reply with the link"). Brain calls
  `list_linear_teams → create_linear_issue → reply_to_slack`.
- [ ] **pg-boss upgrade**: swap `setInterval` poller for pg-boss before running
  >1 server instance (multi-instance safety).
- [x] **PR-handoff to Linear**: `apps/server/src/linear/client.ts` — GraphQL client
  using `LINEAR_API_KEY`. Poller `linearPrHandoff()` detects done tasks with
  `linearIssueIdentifier` and `linearCommentPosted=false`, posts a comment with
  the PR URL, sets `linearCommentPosted=true`. Schema: added `linearCommentPosted`
  Boolean field + migration.

---

## M4 — Specialized agents

> Goal: Scout, Support, Style, Reports — permanent sessions for strategic leverage.

- [x] **Brain ↔ worker tools**: `check_worker`, `message_worker`, `resurrect_worker`,
  `update_task`, `archive_task`, `reply_to_slack`. Injected via `WorkerDriver` +
  `SlackDriver` interfaces. Brain prompt updated. `spawn_child_card` deferred.
- [x] **Scout** — `apps/server/src/scout/runner.ts`: persistent Pi session on the
  "scout" channel, resumed via `AgentSession` table. Tools: `get_active_tasks`,
  `list_linear_teams`, `list_linear_issues`, `list_github_prs`, `brief_brain`.
  `brief_brain` pushes to brain inbox (source="poller"). Poller upgraded: when a
  backend is available, runs `runScoutTurn()` per workspace instead of the static
  text digest. Fallback to text digest when no backend configured. Sentry read
  access deferred (no Sentry SDK added yet).
- [ ] **Support agent** — triage sweeps, on-call workflows. (Brain already handles
  support channels via `handleChannelMessage`; needs dedicated Scout-like prompt.)
- [ ] **Style Improver** — react-cosmos screenshots, UI variant generation, PR on
  selection.
- [ ] **Report Runner** — persistent sessions, versioned HTML reports, dep tracking.
- [x] **Manta health-check runner** — `apps/server/src/scout/healthCheck.ts`: daily brain session
  ("health-check" channel, kind="custom"). Tools: `get_all_tasks`, `list_github_prs`,
  `list_linear_teams`, `list_linear_issues`, `post_report`. `post_report` posts to
  `MANTA_HEALTH_CHECK_SLACK_CHANNEL`. Poller `dailyHealthCheck()` runs every 24h when backend
  + Slack are configured. Session persisted so the model carries context across days.

---

## M5 — Infra & scale

> Goal: production-ready multi-instance deployment.

- [ ] **Multi-instance fan-out**: swap in-process `bus` for Postgres `LISTEN/NOTIFY`
  (ARCHITECTURE §4) before running >1 server instance.
- [ ] **Daytona unblock**: provided key returns "Access denied" on sandbox create —
  needs sandbox-create permission/quota (or new key). Cloud worker path runs
  alongside local via existing `Sandboxes` behaviour.
- [x] **Claude backend** (`packages/agent/src/claude-backend.ts`): Anthropic SDK,
  tool-call loop, `AgentEvent` stream. Brain uses Claude when `BRAIN_BACKEND=claude-sonnet`
  (or `-haiku`/`-opus`) env var is set and `ANTHROPIC_API_KEY` is present. History
  injected from Postgres messages table when backend starts with "claude". Claude
  workers (with file tools) deferred — Pi backend serves workers for now.
  `RunTurnInput.history?: HistoryMessage[]` added to the agent interface.
- [ ] **AWS deploy** (Phase 11+/`docs/DEPLOYMENT.md`): ECS + Neon + S3 + Secrets
  Manager; CI build → ECR → ECS; Daytona snapshots for cloud workers.
- [ ] **Local-laptop worker as separate project** (standalone runner speaking same
  dispatch/stream protocol; in-server local driver is dev/embedded version).
- [ ] **pg-profiles + db-reset** (Phase 14): provider branch-reset (Neon),
  preview-then-confirm, pause/rebuild/resume.
- [ ] **Permanent sessions** (Phase 15): Scout, Support, Style.
- [ ] **Spotchecks** (Phase 17), **peers/DM + drain-redeploy** (Phase 18),
  **voice/themes/PWA** (Phase 20).

---

## Miscellaneous improvements (this session)

- [x] **Worker-daemon PR loop** — `apps/server/src/worker/http.ts`: worker HTTP API
  (`POST /api/worker/tasks/:taskId/report-pr`, `update-checklist`, `github-token`)
  authenticated with `WORKER_SECRET`. Daemon updated to call these endpoints via
  `buildWorkerTools()`. Worker prompt updated with bash safety + PR instructions.
  Previously the daemon had `tools: []` and no PR loop.

- [x] **WS auto-reconnect** — `apps/web/src/ws.ts`: exponential backoff (1s→30s)
  on `onclose`/`onerror`. Board, brain chat, and task chat all recover automatically.
- [x] **Task archive** — `DELETE /api/workspaces/:id/tasks/:taskId` (soft-deletes
  via `archivedAt`). Archive button in task detail header. `archive_task` brain tool.
- [x] **`update_task` brain tool** — lets brain update task title/description/checklist.
- [x] **Scout digest** — poller sends a 30-min status brief of all active tasks to the
  brain inbox, so the brain can proactively plan.

## Miscellaneous improvements (continued)

- [x] **Resurrect endpoint + UI** — `POST /api/workspaces/:id/tasks/:taskId/resurrect`:
  transitions `needs_help → bot_working` and spawns a new worker. "Retry Worker"
  button appears in task detail header when card is in `needs_help` state (with
  optional instruction prompt). `api.resurrectTask` method in web client.

- [x] **Status badge in task detail** — colored badge showing current card status
  (`bot_working` = blue, `needs_help` = red, `ready_to_test` = green, etc.) inline
  with the task title in the detail header.

- [x] **Brain prompt update** — `DEFAULT_BRAIN_PROMPT` now lists all available tools
  (task mgmt, Slack, Linear) and includes triage instructions for support requests.

## Known gaps / cleanups

- [ ] WS subscriptions accumulate per `subscribe` until socket close (no
  unsubscribe message) — fine for now; add unsubscribe if it grows.
- [ ] `worker_chat` provisions/reuses worktree but each turn is a fresh Pi session
  resume — confirm long worktrees don't drift (pnpm install etc.).
- [ ] Tests: add coverage for WS hub + local worker provisioning.

---

## Done (live-verified)

- Phase 0–6 foundations: Google OAuth + workspaces, Prisma/Postgres, brain turn
  loop, **Pi backend (gpt-5.5) live**, brain task tools, WS streaming, React UI
  (board + chat sidebar + New-card/Repos/New-workspace modals + task detail).
- **Local workers** (no Daytona): agent runs on local git worktree, streams to
  task channel, opens/edits files. **Worker session resume** across turns.
- **Worker daemons** (`apps/worker-daemon/`): external worker processes connect to
  `/worker-ws`, register with `WORKER_SECRET`, receive `run_task` dispatch, run Pi
  agent on local worktrees, stream events back. Registry in
  `apps/server/src/worker/registry.ts`. Cards go to `needs_help` when daemons
  registered but all busy; falls back to local driver when no daemons connected.
  Start with: `./start-worker` (or `./start-local-worker` for localhost).
