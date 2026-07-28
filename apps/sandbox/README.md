# apps/sandbox

The Daytona **snapshot** that runs one worker. Built by CI, pushed to ECR, and registered as a
Daytona snapshot (snapshot — *not* raw image — so the entrypoint is honored; see
the sandbox docs for why). Modeled on an internal sandbox service.

## What runs here

`job-entry.sh` (the snapshot entrypoint) busy-waits for credentials pushed by manta-server via
the Daytona file API, then launches the **agent runner**:

- **Pi (primary):** `@earendil-works/pi-coding-agent` driving the worker turn.
- **Claude (optional):** the `claude` CLI, if the base image ships it.

The runner streams normalized `AgentEvent`s (see `@manta/shared/events`) back over SSE to the
server, and exposes the worker's control-plane tools (`rename`, `transition_to_*`,
`report_to_brain`, `post_pr_review`, …) as calls that **proxy back to manta-server** with a
workspace+task-scoped token. The sandbox holds no host secrets.

## Contract with the server (the sandbox service-derived)

- **Creds via file, never env:** `credential_process` reads a file the server pushes/refreshes.
  A baked sentinel makes the entrypoint block until real creds arrive.
- **`done` is the universal stream terminator.** Never end a stream without it.
- **Per-worker GitHub App token**, repo-narrowed, pushed at dispatch.
- **Validate shell-substituted inputs** (`skill`, `branch`, `args`) — the entrypoint quotes them.
- **Mirror every chunk to durable logs** so walked-away viewers can recover the transcript.

## Files (to build out in Phase 7)

- `Dockerfile` — base image: Node 24 + pnpm + git + gh + Pi (+ optional Claude CLI); pre-seed
  strategy for repo caches (clone-on-miss for multi-repo workspaces).
- `job-entry.sh` — entrypoint: wait-for-creds → clone/fetch branch → run agent runner → stream.
- `src/runner.ts` — the agent runner (Pi/Claude → `AgentEvent` stream + tool proxy).

Nothing is built yet — this is the Phase 7 target. See `docs/ROADMAP.md` and
`docs/DEPLOYMENT.md` §3.
