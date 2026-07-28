# Manta — Architecture & Decisions

> Manta is a cloud, multi-company rebuild of an earlier single-tenant prototype.
> It takes that prototype's behavioral contract and re-homes it from
> "one process per engineer laptop coordinated through Upstash Redis" to a **hosted, multi-
> company SaaS**: a central server orchestrates AI coding **workers** that run in **ephemeral
> Daytona sandboxes**. Companies install Manta's GitHub / Linear / Slack apps into their
> **workspace** and bring their repos.
>
> This document records the load-bearing decisions and *why*. The data model
> (`DATA_MODEL.md`), roadmap (`ROADMAP.md`), and deployment (`DEPLOYMENT.md`) build on it.

---

## 0. Decisions at a glance

| Concern | Decision | One-line why |
|---|---|---|
| Shape | **Server ↔ worker.** Central server orchestrates; workers run in ephemeral **Daytona** sandboxes. | Proven in-house by an internal sandbox service; sandbox = the security boundary for untrusted agent shells. |
| Language / runtime | **TypeScript on Node 24 + Hono**, **pnpm** workspace monorepo. | Converges with the platform's stack (Hono/Node 24/pnpm); Pi SDK is TS; the worker agent must be TS regardless. |
| Agent primitive | **Pi SDK** (`@mariozechner/pi-coding-agent` + `pi-ai`) primary; **Claude Code** optional backend. | the prototype already drives *both* brain and workers through Pi with custom tools — reuse it. Daytona images may ship Claude → cheap second backend. |
| Brain runtime | **In-server**, driven by Pi with control-plane tools; stateless-per-turn, history in Postgres/S3. | Brain edits no code → needs no sandbox; owning history sidesteps fragile session-resume. |
| Worker runtime | **Daytona sandbox per worker**, running the Pi/Claude agent; streams events back over SSE. | the sandbox service pattern: server is the trust boundary, Daytona is source of truth for sandbox state. |
| Frontend | **React 19 + Vite + TanStack Router + nanostores** SPA over WS/SSE + REST; xterm.js + CodeMirror for heavy widgets. | Converges with the platform (React 19/Vite/TanStack Router); nanostores for state per product owner. |
| Persistence | **PostgreSQL via Prisma** (converges with the platform). No Redis for v1 (Postgres `LISTEN/NOTIFY` for fan-out). | Server holds the product state Daytona doesn't (workspaces, tasks, chat, kanban). |
| Tests | **Vitest** (unit/integration) + **Playwright** (e2e); CI gate. | Vite-native; one runner for server + web. |
| Tenancy | **Workspace = company/team**: users + repos + integration configs. | Matches the install-our-apps SaaS model. |
| Integrations | **One Manta-owned GitHub App, Linear app, Slack app**; workspaces install them. | Single app to maintain; per-workspace installation tokens/credentials. |
| User auth | **Google OAuth.** | Per the product owner. Distinct from integration auth. |
| Worker inference auth | **Per-workspace LLM keys** pushed into the sandbox via Daytona file API. | the sandbox service's `credential_process` pattern; workspace brings its own Anthropic/OpenAI/Pi creds. |
| Deploy | **Server on AWS ECS Fargate + Neon Postgres + S3 + Secrets Manager; workers on per-repo Daytona snapshots.** | Mirrors the sandbox service's deploy; Neon for branch ergonomics; managed, repeatable. |

> **Note on a reversed call.** An earlier draft of this doc chose Elixir/Phoenix for the
> control plane (OTP fits long-lived sessions). The product owner then fixed three constraints
> that invert the tradeoff: **Pi SDK as the primary primitive** (TS-only), **the sandbox service** (Bun/TS)
> as the proven Daytona pattern, and **Daytona owning worker execution** (so "long-lived
> session" state lives in Daytona + Postgres, not in BEAM processes). With the agent layer
> forced to TS and worker state externalized, Elixir's wins evaporate while its costs (second
> language, no Pi/Claude SDK, no the sandbox service reuse) remain. Hence: **TypeScript.** Recorded so the
> reasoning is legible, not lost.

---

## 1. The server ↔ worker shape (and why Daytona)

```
   Google OAuth                                    Manta-owned apps (one each):
   user login                                      GitHub App · Linear app · Slack app
        │                                                   │ installed per workspace
        ▼                                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       manta-server  (Bun + Hono, ECS)                       │
│   trust boundary · auth · webhook ingress · brain turns (Pi) · dispatch      │
│   WS/SSE fan-out · Postgres (Drizzle) · per-workspace creds (Secrets/KMS)     │
└───────┬───────────────────────────────────────────────┬─────────────────────┘
        │ REST + WS/SSE                                   │ Daytona SDK
        ▼                                                 ▼
┌───────────────┐                          ┌──────────────────────────────────┐
│  manta-web     │                          │   Daytona sandbox  (per worker)   │
│  React SPA     │                          │   • snapshot w/ Pi + Claude       │
│  xterm/CM hooks│                          │   • shallow repo clone, PTY, shell│
└───────────────┘                          │   • runs agent turn, streams SSE  │
                                            │   • creds pushed via file API     │
                                            │   • control-plane tools → server  │
                                            └──────────────────────────────────┘
```

**Why Daytona, not Fargate-per-worker (my earlier guess):** the team already operates this
pattern in an internal sandbox service — ephemeral Daytona sandboxes, credential push via the file API,
SSE log streaming, per-job GitHub App tokens, ownership via labels. Reusing it means we inherit
solved problems (startup race via sentinel creds, credential refresh, log replay, cost
attribution) instead of re-deriving them on raw ECS. Daytona is the **source of truth for
sandbox state**, so the server can be largely stateless about workers: on restart it relists
sandboxes by workspace label and reattaches their streams.

**Local-laptop workers** (the "or run it on your laptop" option) are explicitly a **separate
project** — a local runner speaking the same dispatch/stream protocol to the server. Out of
scope for Manta proper; the protocol is designed so it can slot in later.

### What we adopt from the sandbox service

- **Single trust boundary** (`verify()` analogue): every privileged action derives the actor
  from the verified session, never from caller input. Daytona ownership filtered by label
  (`workspace`, `task`).
- **Snapshot, not image** (entrypoint is honored only via snapshots).
- **Credential push, never env-baked secrets**: `credential_process` reads a file the server
  pushes/refreshes via the Daytona file API (also resets the inactivity timer).
- **SSE streaming with a universal `done` terminator**; mirror every chunk to durable logs so
  "walked-away" viewers can recover the transcript (we persist to Postgres/S3 + fan out live).
- **Per-job GitHub App installation token** narrowed to the target repo, minted per worker.
- **Validation guards** on anything substituted into shell (`skill`, `branch`, `args`).

### What Manta adds beyond the sandbox service

the sandbox service *holds nothing* (Daytona is the only state). Manta has genuine product state Daytona
doesn't model — workspaces, users, tasks/kanban, chat history, brain memory, integration
configs. So manta-server is **stateful in Postgres** (durable) while staying **stateless about
live sandboxes** (Daytona owns those). The brain is reconstructed per turn from Postgres.

---

## 2. Agent layer: Pi primary, Claude optional

the prototype already proves the shape we want, in TS:

- `src/backends/pi.ts` — `streamPiWorkerTurn()` drives a **worker** through `pi-coding-agent`:
  system-prompt override, JSONL session file (resume by reopening), context usage, abort.
- `src/backends/pi-session.ts` — drives the **brain & sister sessions** through Pi with
  **custom tool definitions** (the Pi equivalents of MCP tools), per-session system prompt,
  JSONL persistence, event mapping.

So a single `Agent` abstraction over Pi serves brain, workers, and permanent sessions. "One
call = one turn"; sessions persist as JSONL we store in Postgres/S3 and reopen.

- **Workers** run the agent **inside the Daytona sandbox** (shell/file/edit on a real clone).
- **Brain & permanent sessions** run the agent **in manta-server** (their tools are all
  control-plane functions — DB ops, dispatch, integration calls — no shell needed).
- **Claude Code** is kept as an optional worker backend: if the Daytona snapshot ships the
  `claude` CLI (as the sandbox service's does), exposing a Claude backend is nearly free. Backend is
  pinned per task at spawn, exactly as the spec describes (§7.5).

**Worker → server tools.** Worker control-plane tools (`rename`, `transition_to_needs_help`,
`report_to_brain`, `post_pr_review`, …) are exposed to the in-sandbox agent and **proxy back to
manta-server** over an authenticated HTTP call (workspace+task-scoped token). The sandbox never
holds the privilege; the server performs the action and broadcasts the result.

**Event protocol** (sandbox → server → browser), normalized across Pi/Claude:
`text` · `thinking` · `tool_use` · `tool_result` · `context_usage` · `done` · `error`. `done`
is the universal terminator (the sandbox service invariant). Every event is persisted to `messages` then
fanned out to subscribers.

---

## 3. Brain: in-server, stateless-per-turn

The brain orchestrates and edits no code, so it runs in manta-server, not a sandbox. Per turn:

1. **Assemble** the system prompt fresh (hot-reload contract, spec §6.1): workspace
   `brain_prompt` + team memory + the acting user's personal memory + theme/Slack context.
2. **Drain the inbox** (spec §6.3): a Postgres-backed queue (`inbox_items`) holding `[STALL]`,
   `[Worker error]`, peer DMs, perm-session reports — drained atomically at turn start.
3. **Load history** from Postgres (we own it) / reopen the Pi JSONL from storage.
4. **Run the turn** through Pi with the brain tool set; stream events to the `brain` channel;
   persist every chunk.
5. **Terminate**: natural end → idle; `sleep(N)` → schedule a wake job and idle; interrupt →
   abort + persist partial; error → broadcast + idle.

**Sleep/wake** (spec §6.5) is a scheduled job (a `wake_at` row + a sweeper), not an in-memory
timer — survives restarts and horizontal scaling. Any inbound user message cancels the pending
wake. **Resumption** (spec §6.6) is trivial because we own history: load messages, send them —
there is no opaque session id to be rejected.

This stateless-per-turn design (the sandbox service philosophy) makes the server horizontally scalable and
restart-safe. A warm in-memory session cache per active workspace is a later optimization.

---

## 4. Real-time fan-out

- **Browser ↔ server**: one WebSocket per tab, multiplexed by `channel` target (`brain`,
  `<taskId>`, `scout`, …) exactly like spec §11.16. Heavy PTY bytes ride a dedicated channel.
- **Cross-instance** (a browser may be on a different server instance than the one running a
  turn): **Postgres `LISTEN/NOTIFY`** as the v1 pub/sub bus — no new infra, adequate for early
  scale. Each instance subscribes to workspace/channel topics and relays to its local WS
  clients. **Redis (ElastiCache) pub/sub** is the documented scale path if NOTIFY throughput or
  payload limits bite.
- **Worker output**: the instance attached to a Daytona sandbox's SSE stream persists chunks
  and publishes them on the bus; any instance with subscribed browsers relays them.

Presence (online users per workspace) is a lightweight heartbeat table + NOTIFY, not the old
Upstash sorted set.

---

## 5. Tenancy: the Workspace model

- **Workspace** = a company/team. It owns: **users** (members, via Google OAuth + roles),
  **repos**, and **integration configs** (GitHub App installation, Linear connection, Slack
  connection), plus settings (brain prompt, team memory, defaults, worker concurrency cap).
- A **user** (Google identity) can belong to multiple workspaces (multi-company); the active
  workspace is a session concern.
- **One Manta-owned app per provider.** Manta registers a single GitHub App, a single Linear
  OAuth/app, and a single Slack app. A workspace **installs** each into their org; we store the
  resulting **per-workspace installation token / OAuth grant** (encrypted). Webhooks from all
  three carry the installation/team id, which we map → workspace.
- **Webhook routing** is by installation/team identity (`workspace_identities` table) — replaces
  Upstash affinity routing. One hosted ingress per provider; verify signature → resolve
  workspace → dedup → route to that workspace's brain.
- **Isolation**: every row carries `workspace_id`; context modules require it and never cross
  it. Sandboxes are labeled and credentialed per-workspace; egress allow-listed; no cross-
  workspace network. "Peer DM" becomes an explicit, consented, audited inter-workspace message.

---

## 6. Auth & secrets

- **User auth: Google OAuth** → `users` (google_sub, email, name, avatar). Session cookie +
  signed token for WS. Workspace membership gates everything.
- **Integration auth** is separate and per-workspace:
  - **GitHub**: the Manta GitHub App installation; mint short-lived, repo-narrowed installation
    tokens per worker (the sandbox service `@octokit/auth-app` pattern).
  - **Linear**: workspace authorizes the Manta Linear app (OAuth) → per-workspace token; webhook
    secret shared by the app.
  - **Slack**: workspace installs the Manta Slack app → per-workspace bot/app tokens; signing
    secret shared by the app.
- **Secrets at rest**: AWS Secrets Manager for infra creds; a KMS data key feeding app-level
  encryption (libsodium/`Cloak`-style) for the per-workspace `workspace_secrets` rows in
  Postgres. Sandboxes receive only the narrowly-scoped creds they need, pushed via the file API.
- **Sandbox isolation is the real security boundary** (spec §13.2). The bash-safety regexes stay
  as defense-in-depth only.

---

## 7. Components / repo layout

A **pnpm workspace** monorepo (`manta`), Node 24 + TypeScript:

```
manta/
  apps/
    server/      Hono on Node 24. Trust boundary, brain turns, dispatch, webhooks, WS/SSE, REST.
    web/         React 19 + Vite + TanStack Router + nanostores. Chat, kanban, detail, terminals, editor.
    sandbox/     Daytona snapshot: Dockerfile + job-entry + agent-runner (Pi primary, Claude opt).
  packages/
    shared/      Kanban state machine (port of shared/kanban.ts), event protocol, shared types.
    db/          Prisma schema + migrations + workspace-scoped query modules.
    agent/        The Pi/Claude Agent abstraction + tool registry (used by server brain & sandbox).
  infra/         Terraform: VPC, ECS, Postgres, ALB, ECR, IAM, Secrets, S3, Daytona snapshot reg.
```

- `packages/shared/kanban` is a **direct port of `shared/kanban.ts`** (statuses, `deriveStatus`,
  `ALLOWED_EDGES`, `isUserDragAllowed`), kept 1:1 so it can be diffed against the original.
- **Conventions adopted from the platform** (the platform repo's `CLAUDE.md`): a local `createLogger` (never
  `console.log`); dependency injection in classes + factory functions for prod defaults; no
  `any`; `prisma migrate dev --name <n>` (never hand-write migrations); `import type`;
  `date-fns`; a typed `API` client in the web app (never raw `fetch`). Manta is standalone — it
  does **not** import the platform's packages, but mirrors its shapes so the team is instantly fluent.

---

## 8. Testing & quality (first-class — real product)

No phase merges without tests. Strategy in `TESTING.md`; the spine:

- **Unit** (Vitest): kanban state machine (property tests vs. the TS rules), tool dispatch,
  webhook signature verification, credential push, brain turn assembly — all with injected stubs
  (DI + factory pattern, so no module-mock global leak).
- **Integration** (Vitest): server ↔ Postgres (ephemeral DB via Testcontainers/Prisma), webhook
  → workspace routing, Daytona wrapper against a fake Daytona, GitHub App token minting against a
  fake Octokit.
- **e2e** (Playwright): one per MVP demo (login → chat → brain spawns worker → sandbox opens PR),
  against a staging stack with a fake/cheap agent backend.
- **CI gate** (GitHub Actions): typecheck + unit + integration on every PR; e2e on staging deploy.

---

## 9. Naming

The app is **Manta** (a manta ray — glides through streams; nods to the lobster/"claw" lineage
without inheriting the name). Packages are `@manta/server`, `@manta/web`, `@manta/shared`, etc.

---

## 10. What we defer past MVP

MVP (`ROADMAP.md` Phases 1–9): Google auth + workspace, schema, brain turn loop + tools, WS hub,
kanban + board, Daytona worker dispatch (Pi), worker loop + tools, web chat + kanban + detail.
Deferred: GitHub/Linear/Slack webhooks & handlers, pg-profiles/db-reset, Claude backend,
spotchecks, peer DM, editor/terminals/workspaces-scratch, voice/themes/PWA. Same order as spec
§18, re-homed onto server↔Daytona.

---

*Decisions are reversible; record changes here with date + reason.*
