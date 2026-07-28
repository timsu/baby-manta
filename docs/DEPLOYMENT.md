# Manta — Deployment (AWS + Daytona)

Manta ships as a hosted, multi-company product. The **server** runs on AWS (mirroring the platform
and an internal sandbox service); **workers** run in **Daytona** sandboxes. This is the target topology and
the path to it — managed services first, custom infra only for the sandbox dispatch (which
Daytona handles).

## 1. Topology

```
   Google OAuth ─┐                 Manta-owned apps (one each), installed per workspace:
                 │                 GitHub App · Linear app · Slack app  ── webhooks ──┐
                 ▼                                                                     ▼
            ┌────────────────────────────────────────────────────────────────────────────┐
   Browser  │   Cloudflare → ALB (HTTPS + WSS)                                            │
   (SPA) ──►│        │                                                                    │
            │   ┌────▼─────────────────────────────────────────────────────────────┐     │
            │   │  ECS Fargate service: manta-server  (Hono/Node 24, N tasks)        │     │
            │   │   auth · webhooks · brain turns (Pi) · dispatch · WS/SSE fan-out    │     │
            │   │   Prisma → Postgres · Postgres LISTEN/NOTIFY pub/sub · pg-boss jobs │     │
            │   └───┬─────────────────────────────┬───────────────────┬──────────────┘     │
            └───────┼─────────────────────────────┼───────────────────┼────────────────────┘
                    │ Prisma                       │ Daytona SDK        │ Secrets Manager + KMS
              ┌─────▼──────┐                ┌───────▼────────┐   ┌──────▼───────────────────┐
              │ Postgres   │                │ Daytona        │   │ app secrets (GitHub App   │
              │ (Aurora    │                │  sandbox /     │   │ key, Linear/Slack client  │
              │  Serverless│                │  worker        │   │ secrets) + KMS data key   │
              │  v2)       │                │  (Pi + Claude) │   │ for workspace_secrets enc │
              └────────────┘                └────────────────┘   └──────────────────────────┘
                    │                              │
                  S3 (chat images, spotcheck     streams SSE back to manta-server,
                  artifacts, Pi session blobs)   creds pushed via Daytona file API
```

## 2. Service-by-service

| Concern | Choice | Notes |
|---|---|---|
| Server compute | **ECS Fargate** service `manta-server` (Hono/Node 24) | Same shape as the sandbox service & the platform backend. Autoscale on CPU + connection count. |
| Load balancer | **Cloudflare → ALB** with WebSocket support | Raised idle timeout for WS; health check `/_ping`. Converges with the platform's prod topology. |
| Database | **Neon (PostgreSQL)** — prod + dev/preview branches | Prisma. Branch ergonomics suit pg-profiles/db-reset; matches the platform's dev DB. Holds product state + `WebhookDelivery` dedup + pg-boss jobs. |
| Pub/sub (fan-out) | **Postgres `LISTEN/NOTIFY`** v1; **Redis (ElastiCache)** as scale path | No Redis to start; cross-instance WS relay over NOTIFY. |
| Background jobs | **pg-boss** (Postgres) | poller, spotchecks, webhook retries, sandbox GC, brain wakes. |
| Workers | **Daytona** sandboxes (one per worker) | Source of truth for sandbox state; server reattaches by label on restart. |
| Worker image | **Per-repo Daytona snapshots** (snapshot, not raw image) built from `apps/sandbox/Dockerfile` | One snapshot per workspace repo with a pre-seeded cache; Pi (`pi-coding-agent`) primary + Claude Code optional; `job-entry.sh`. |
| Worker inference creds | **Per-workspace LLM keys**, pushed into the sandbox via Daytona **file API** (`credential_process`) | Workspace brings Anthropic/OpenAI/Pi creds; refreshed periodically; never env-baked. The in-server brain uses the same per-workspace keys. |
| Worker GitHub auth | per-worker **GitHub App installation token**, repo-narrowed | the sandbox service `@octokit/auth-app` pattern; minted at dispatch. |
| App secrets | **Secrets Manager** (GitHub App private key, Linear/Slack client+signing secrets) | The single Manta app's secrets — not per-workspace. |
| Workspace secrets | Postgres `WorkspaceSecret`, app-encrypted with a **KMS** data key | per-workspace OAuth grants / tokens. |
| Object storage | **S3** | chat image attachments, spotcheck artifacts, Pi session JSONL blobs, sandbox log exports. Lifecycle expiry for ephemera. |
| Container registry | **ECR** | `manta-server`, `manta-sandbox`. |
| DNS / TLS | **Route53 + ACM** (+ Cloudflare) | single host + workspace switch for v1; per-workspace subdomains later. |
| Observability | **CloudWatch** logs/metrics + OpenTelemetry | mirror every agent event into a log group so "walked-away" transcripts are recoverable (the sandbox service invariant). EMF cost metric per worker run. |
| CI/CD | **GitHub Actions** → ECR build → register Daytona snapshot → ECS rolling deploy | server + sandbox snapshot advance together (the sandbox service pattern). |
| IaC | **Terraform** (`infra/`) | VPC, ECS, Aurora, ALB, ECR, IAM, Secrets, S3, Daytona snapshot registration. |

## 3. Why Daytona for workers (not Fargate-per-worker)

A worker is an AI agent with a real shell on a real repo clone — untrusted, so it needs strong
isolation. The team already runs exactly this on Daytona in an internal sandbox service: ephemeral sandboxes,
credential push via the file API, SSE log streaming, per-job GitHub tokens, ownership by label.
Reusing it inherits the solved hard parts (startup-race sentinel creds, periodic credential
refresh, log replay-then-close, cost attribution) rather than re-deriving them on raw ECS tasks.
Daytona is the source of truth for sandbox state, so `manta-server` stays stateless about live
workers — on redeploy it relists sandboxes by `workspace`/`task` label and reattaches streams.

The `apps/sandbox` boundary is provider-agnostic enough that a future **local-laptop runner**
(separate project) or a self-managed Firecracker pool could speak the same dispatch/stream
protocol.

## 4. Inference (per-workspace keys)

- Each **workspace brings its own LLM credentials** (Anthropic / OpenAI / Pi), stored encrypted
  in `WorkspaceSecret`. For workers, push them into the sandbox via the Daytona file API
  (`credential_process`, refreshed periodically, never env-baked). The in-server brain uses the
  same per-workspace keys.
- No billing/metering layer for now (out of scope). The agent still reports `costUsd`/tokens in
  its `done` event for observability, but there's no pricing model yet.

## 5. Environments

- **dev** — local: `manta-server` (Hono/Node) + local/Neon Postgres + a real Daytona dev
  sandbox (or a local fake-sandbox stub for unit/integration tests).
- **staging** — full AWS stack, one or two test workspaces, Neon branch DB; runs the e2e suite
  on deploy with a fake/cheap agent backend.
- **prod** — full AWS stack, multi-company, autoscaled.

Config via env injected by Secrets Manager (no secrets in images). Converge on the platform's dotenvx
per-line encryption for committed `.env.*` if useful, else plain Secrets Manager injection.

## 6. Decisions (2026-05-28) & remaining infra questions
Resolved: **Neon** for prod Postgres · **per-repo Daytona snapshots** · **per-workspace LLM keys**
(implemented — see [MODELS_AND_PROVIDERS.md](./MODELS_AND_PROVIDERS.md); set `SECRETS_KEY` in prod
to encrypt stored credentials) · **no billing/metering** for now.

Still open:
- One Manta GitHub App with per-workspace installs (chosen) — confirm webhook→workspace mapping covers all event types.
- Per-repo snapshot **build cadence & cache-refresh** strategy (rebuild on repo default-branch movement? nightly?).
- Region + data-residency for multi-company (EU workspaces?).
