# Worker Venues (Daytona + laptop, full mobility)

Status: in progress on branch `worktree-daytona-venues`.

## Goal

Replace the in-process "cloud bot" (a Pi agent shelling out **on the ECS server
container** — a multi-tenant secret-leak and dies on every rolling deploy) with
**Daytona sandboxes** as the isolated cloud execution venue, while keeping the
**BYO-laptop daemon** as a second venue. A task's work can **move between
venues** (laptop⇄Daytona): resume-elsewhere when a venue goes offline, or
pull-down-locally on demand.

## Core model: separate the work from the venue

- **Durable artifact** = the `manta/<task>` branch (+ PR) on GitHub. Survives any
  venue dying or any ECS redeploy. This is the source of truth for "the work".
- **Venue** = an ephemeral compute lease with a checkout of that branch + a
  resumable Pi session (`Task.sessionBlobKey`, already persisted). Disposable.

The discipline that makes mobility trivial: **a venue always commits + pushes its
branch before it goes idle or spins down.** Then "move work from venue A → B" is
just: provision B → `git clone -b <branch>` → restore session from
`sessionBlobKey` → resume. The branch carries the code; the session blob carries
the agent's memory. Worst case on a hard crash = loss of uncommitted scratch,
mitigated by periodic WIP commits.

## One daemon, two venues (the unification)

The Daytona sandbox **runs the existing Manta worker-daemon** (`apps/worker-daemon`)
inside it. Cloud and laptop become the *same* worker code; they differ only in:

| | laptop venue | daytona venue |
|---|---|---|
| where the daemon runs | user's machine | Daytona sandbox (server-spawned) |
| lifecycle | user-managed, persistent | server-managed (create/idle-stop/resume) |
| git/gh creds | developer's ambient creds → **human-authored PR** | vended GitHub App installation token → **bot PR** |
| Pi auth | user's `~/.pi` | workspace `auth.json` pushed into the sandbox |
| callback auth | per-user `WorkerCredential` | per-task scoped sandbox token |
| isolation | trust the machine | sealed, per-tenant by label |

This means the conversational model (follow-up messages, live event streaming over
`/worker-ws`, `message_worker`) already works for both — no new transport.

### Reused from the sandbox service (the in-house shortcut)

- **Sandbox image**: build `manta-sandbox` modeled on / FROM `base-sandbox`
  (ubuntu 24.04 + mise node/pnpm/bun + gh + git + ripgrep), swapping Bedrock/claude
  for Pi/Codex and bundling the Manta worker-daemon. Register a Daytona snapshot
  from the ECR image (`daytona snapshot create <name> --image <ecr> --entrypoint …`).
- **Label ownership + reattach**: `{ workspace, task }` labels; control plane stays
  stateless, reattaches by `listByLabel` after an ECS roll (already in `daytona.ts`).
- **Credential heartbeat**: every ~15 min push a fresh GitHub App token + refreshed
  Pi auth into the sandbox via Daytona `fs` (atomic tmp→chmod 600→mv). Sentinel
  cred files baked into the image so nothing ENOENTs before the first push.
- **Lifecycle backstops**: `autoStopInterval` / `autoArchiveInterval` /
  `autoDeleteInterval` on create as a safety net under our own idle-spindown.

## Schema additions (`Task`)

Existing reused fields: `branch`, `worktreePath`, `sandboxId`, `sessionBlobKey`,
`workerStatus`, `workerActive`, `workerBackend`, `createdBy`.

New:
- `workerVenue WorkerVenue @default(none)` — `none | laptop | daytona`.
- `venueStatus VenueStatus @default(none)` — `none | provisioning | active | idle | stopped | failed`.
- `venueStoppedAt DateTime?` — for idle-spindown bookkeeping / resume UX.

Both additive + defaulted → safe migration for the rolling deploy.

## Lifecycle state machine (per task)

```
none ──(user message / create)──▶ provisioning ──▶ active ──(turn ends)──▶ idle
  ▲                                                                          │
  │                                              (idle timeout: commit+push+stop)
  └──────────────── stopped ◀───────────────────────────────────────────────┘
        (user resumes / new message: re-provision, clone branch, restore session)
```

- **Idle → stopped** is the cost control (Daytona bills while alive). Commit+push
  first so nothing is lost.
- **Reconciler** on boot + interval: `listByLabel` all Manta sandboxes, adopt
  orphans (post-deploy), stop sandboxes whose task is `done`/merged. This replaces
  the old in-process assumption that a server instance "owns" running work.

## Venue mobility (the full-mobility ask)

- **Laptop offline → Daytona**: laptop daemon drops (`/worker-ws` onClose) mid-task
  → instead of only `needs_help`, offer/auto "resume on Daytona": provision sandbox,
  clone the pushed branch, restore session. (Uncommitted laptop work is lost — that's
  the commit-before-idle discipline's edge.)
- **Daytona → pull down locally**: user clicks "pull to my laptop"; their laptop
  daemon fetches the branch + checks out, server hands it the `sessionBlobKey`,
  Daytona sandbox is stopped.
- Each task tracks its current `workerVenue` + `venueStatus`; transitions are just
  stop-here / provision-there around the shared branch+session.

## Phases

- **P1 — Foundation:** ✅ schema enums+fields+migration; `Sandboxes` factory
  (Daytona in prod, Fake in tests); `MANTA_SANDBOX_SNAPSHOT` config.
- **P2 — Cloud venue:** ✅ this PR. `SandboxCredential` single-task `msb_` token;
  token accepted at `/worker-ws` + `/api/worker` (Principal union, sticky binding);
  single-task daemon mode; `worker/cloud.ts` (provision/reattach, vend Pi auth +
  GitHub token, launch, `stopCloudSandbox`); `spawnWorker` rewired (laptop →
  Daytona) with the **in-process `runWorkerTurn` deleted** (`local.ts` →
  `dispatch.ts`); `manta-sandbox` image on the the sandbox service base + snapshot script.
- **P3 — Lifecycle (next):** idle-spindown (commit+push+stop+revoke), reconciler
  (`listByLabel` on boot/interval; adopt orphans, stop done tasks), graceful-stop
  flag so spindown ≠ `needs_help`, credential heartbeat (~15-min refresh), and
  resume-from-stopped (the `runCloudTask` reattach path assumes a *live* box today).
- **P4 — Mobility:** laptop⇄Daytona transitions + the offline-fallback wiring.
- **P5 — UI:** venue badge + lifecycle status + "resume" / "pull to laptop" controls.
- **P6 — Infra:** ECR repo + CI to build/push the image and register the snapshot;
  unblock Daytona "Access denied"; validate the the sandbox service base's Node version.

## Decision (resolved)

Cloud callback transport: **sandbox runs the daemon and connects back over WSS
`/worker-ws` with a single-task token** — max reuse (laptop and cloud are the same
code), native conversational + live-stream support. Chosen over the sandbox service's sealed
read-`/tmp/job.*`-over-SDK model (great for fire-and-forget, awkward for interactive
follow-ups). We still reuse the sandbox service's *image*, label-reattach, and (P3) heartbeat.
