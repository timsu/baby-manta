# server conventions

## Multi-tenancy
Workspace-owned data must be scoped by `workspaceId` end to end (see
`packages/db/src/CLAUDE.md`). HTTP routes that return task/worker data must verify
the caller's membership with `workspaces.isMember(userId, workspaceId)` before
revealing anything tenant-specific — `requireAuth` alone only proves the caller is
*some* logged-in user, not a member (`/api/workers` leaked cross-tenant titles this
way). The webhook receivers (`/api/linear/webhook`, GitHub webhook) are HMAC-gated
instead of session-gated, but any *admin/setup* route that mutates a workspace
mapping must be both auth-gated and membership-checked.

## Authorization posture
Default to allowing authenticated workspace members to take most workspace actions.
Reserve owner/admin gates for destructive, privileged, or security-sensitive operations
such as granting elevated access, revoking privileged access, deleting shared resources,
or changing integration/setup credentials. Non-destructive coordination metadata (for
example member labels, routing hints, card organization, and similar workflow state)
should generally be member-gated, not admin-gated.

## Worker ownership & auth
Worker daemons are **per-user**. Each daemon pairs once via the browser flow
(`/api/worker-auth/pair`) to mint a `WorkerCredential` token bound to a user; it
then presents that token on `/worker-ws` (register) and `/api/worker` (Bearer).
`workerCredentials.verify(token)` resolves it to the owning `userId`. There is no
shared `WORKER_SECRET` — every daemon has an owner.

Routing: `dispatchTask(payload, ownerUserId)` only matches an idle daemon whose
`ownerUserId === task.createdBy`; when the owner has no idle daemon (or the task
has no creator) it returns null and the caller falls back to the **in-process
cloud bot** (`runWorkerTurn`). `spawnWorker` encapsulates this owner-or-bot choice.

Least privilege still applies:
- `/api/worker` mutations check `workspaces.isMember(workerUserId, workspaceId)`
  and scope DB writes by `workspaceId`.
- `get_github_token` mints a token for **the task's own repo**, never an arbitrary
  `orgRepo` the caller names.

## Terminal (PTY lives on the worker, not here)
The PTY runs on the **worker daemon** that holds the task's worktree (the shell
must be next to the files the agent edits), implemented in `@manta/shared/terminal`
(`TerminalManager`). The server is only a relay/authorizer:
- `terminal.ts` just does `authorizeTerminal` (session + `isMember` + task lookup).
- `/terminal` (in `ws.ts`) is a pure relay: it generates a `sessionId`, finds the
  worker that physically holds the worktree via `getTaskWorkerSend(taskId)` /
  `getTaskWorkerInfo(taskId)` (registry's **`taskHomeWorker`** map, which survives
  turn completion — unlike `taskToWorker`), and shuttles `terminal_*` frames over
  the existing `/worker-ws` socket. No connected worker → "no worker connected".
  The map is in-memory, but a daemon reports the worktrees it still holds on
  `register` (`heldTasks` → `claimTaskWorktrees`), so routing is rebuilt right
  after a server **deploy/restart** without waiting for the next dispatch.
- Same-machine browsers skip the relay: `GET /api/tasks/:taskId/terminal-endpoint`
  mints an opaque token, pushes it to the worker (`terminal_grant`), and returns a
  direct `ws://127.0.0.1:<port>` target. The token is string-matched by the worker
  — no signing secret leaves the server. The browser tries direct, falls back to
  relay.
- The allowlisted-env protection (a member must not `env` out secrets) now lives
  in `buildShellEnv` inside `@manta/shared/terminal`, applied on the worker.

## WebSocket worker lifecycle (`ws.ts`)
`/worker-ws` `onClose` flips a still-`bot_working` task to `needs_help`. To avoid a
completed task racing into `needs_help`, the `done`/`error` handler calls
`freeTaskWorker(taskId)` **synchronously before any await** so a concurrent
`onClose` sees a freed slot. Fire-and-forget async work in `onClose` must
`.catch()` and log — an unhandled rejection there is silent.
