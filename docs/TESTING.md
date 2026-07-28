# Manta — Testing Strategy

Manta is a real product. **Tests are a merge gate**: no phase merges with a red suite, and every
phase in `ROADMAP.md` lists the tests that prove it. This doc is the strategy; specifics live
next to the code.

## Runners
- **Vitest** — unit + integration, for both `apps/server` and `apps/web` (Vite-native, fast,
  TS-first). Test files co-located as `*.test.ts(x)`.
- **Playwright** — e2e against a running stack.
- **fast-check** — property-based tests (the kanban state machine especially).
- CI: **GitHub Actions** — typecheck + lint + unit + integration on every PR; e2e on staging deploy.

## Layers

### 1. Unit (pure logic, injected stubs)
The bulk of the suite. Enabled by **dependency injection + factory functions** (converged from
the platform): production code reaches for a singleton; tests pass stubs through a `createX(deps)`
factory. No module-level mocking that leaks across files.
- **Kanban state machine** (`packages/shared/kanban`): property tests with fast-check — for any
  reachable `(from, to, actor)`, the port agrees with `shared/kanban.ts`'s rules;
  `deriveStatus` is total; `isUserDragAllowed ⊇ ALLOWED_EDGES`.
- **Brain turn assembly**: prompt composition is deterministic given inputs; inbox drains in
  order and marks consumed; sleep is cancelled by an inbound message; compaction triggers at the
  threshold and preserves the newest N.
- **Tool dispatch**: each brain/worker tool validates args, enforces `workspaceId` scoping,
  returns the documented shape; `close_task` blocks on unchecked checklist items.
- **Webhook verification**: GitHub/Linear/Slack signature checks accept valid, reject tampered;
  dedup keys computed correctly.
- **Credential push**: atomic (tmp + rename) and never logs secret material.

### 2. Integration (real database, faked externals)
- **DB / query layer**: against an **ephemeral Postgres** (Testcontainers, or a Neon branch in
  CI) with real Prisma + migrations. Asserts the `workspaceId`-required boundary actually
  isolates tenants (a query without scope can't see another workspace's rows).
- **Webhook → workspace routing**: post a signed payload, assert it resolves to the right
  workspace via `WorkspaceIdentity`, dedups on replay.
- **Daytona wrapper**: against a **fake Daytona** implementing the SDK surface we use (create,
  pushFile, streamLogs, cancel, list-by-label) — asserts label ownership filtering, creds-push
  ordering, SSE `done` terminator, reattach-by-label.
- **GitHub App tokens**: against a fake Octokit — repo-narrowed installation token minting + cache.
- **Real-time fan-out**: two server instances + one DB; a turn on instance A streams to a
  subscriber on instance B via `LISTEN/NOTIFY`.

### 3. e2e (Playwright, staging-like stack)
A small set, one per `ROADMAP` MVP demo, run against a stack wired to a **fake/cheap agent
backend** (a stub Pi model that emits scripted events) so e2e is deterministic and free:
- Login with Google (mocked IdP) → land in a workspace → empty board.
- Chat with the brain → it streams a reply.
- Brain spawns a worker → (fake) sandbox emits events → card graduates → PR linked.
- Open task detail → watch the stream → send a message to the worker.

## Test doubles we own
- **FakeDaytona** — in-memory implementation of the Daytona surface; the default in unit/
  integration; the real SDK only in a nightly smoke against a dev sandbox.
- **FakeAgentBackend** — a Pi-compatible backend that replays a scripted event sequence; lets us
  test the whole turn/stream/persist path without spending tokens.
- **FakeOctokit / FakeLinear / FakeSlack** — minimal fakes for the integration calls we make.

## What we explicitly test for (failure modes, spec §17.2)
Session-resume-rejected → fresh start preserving history; worker-dies-without-PR → `needs_help`;
stall fire/refire/suppress; webhook HMAC fail → silent reject; pub/sub down → single-instance
degrade; agent backend error → brain inbox; sandbox launch failure → `failed`. Each has at least
one test.

## Non-negotiables
- A bug fix ships with a test that fails before and passes after.
- New enum value / endpoint / event type → update (and test) every switch/handler that lists the
  old values (the platform rule).
- No `any`; tests use real types so refactors surface breakage.
- e2e never hits paid LLM APIs or a real Daytona in PR CI (only nightly smoke).
