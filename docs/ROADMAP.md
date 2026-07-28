# Manta — Phased Roadmap

Re-homes the prototype SPEC §18 onto the Manta stack (Node/Hono server + Daytona workers + Pi
agent + React SPA + Prisma/Postgres). Each phase is shippable and demoable, with tests as a
merge gate. **Phases 1–9 = minimum viable orchestrator**: a user logs in with Google, lands in
a workspace, chats with a brain, the brain spawns a worker, the worker clones a repo in a
Daytona sandbox and opens a PR — hosted, multi-company.

Legend: ⬜ not started · 🟡 in progress · ✅ done

---

## Phase 0 — Foundations ✅ (done)
- ✅ Explore the prototype + full SPEC.md; study an internal sandbox service (Daytona pattern).
- ✅ Design docs: ARCHITECTURE, DATA_MODEL, DEPLOYMENT, ROADMAP, TESTING.
- ✅ Scaffold pnpm monorepo (`apps/server|web|sandbox`, `packages/shared|db|agent`), Vitest, CI.
- ✅ Kanban contract ported 1:1 from `shared/kanban.ts` + `deriveStatus` + event protocol, with property tests.
- ✅ Hono server (createApp DI, structured logger, /_ping + /api/health) + esbuild bundle.

> **Progress note (session 1):** Phases 0, 2, and the cores of 3 & 4 are built and green
> (44 tests, real-Postgres integration). What's done beyond Phase 0:
> - **Phase 2** ✅ — Prisma migrations applied; workspace-scoped query layer (workspaces, tasks,
>   messages) with tenant-isolation integration tests; kanban transition validated by the shared
>   state machine with an atomic audit row.
> - **Phase 3 (core)** ✅ — `runBrainTurn()` end-to-end loop (inbox drain → persist → stream →
>   tool execution → persist) driven by a `ScriptedBackend`; lifecycle helpers (prompt
>   composition, inbox, sleep/wake, compaction) tested. **Remaining:** real Pi backend wiring
>   (needs creds), session persistence, live WS broadcast.
> - **Phase 4 (partial)** ✅ — brain task tools (create_task, list_tasks, get_task,
>   transition_status) wired to the db layer + DB-backed tests. **Remaining:** the rest of the
>   §6.4 catalog; worker-touching tools await Phase 8.
> - **Phase 1** ⬜ — not started (Google OAuth needs client creds).

## Phase 1 — Google auth + workspace (spec §13)
- Google OAuth → `User`; session cookie + signed WS token.
- `Workspace`, `Membership` (roles), workspace switcher; `WorkspaceIdentity`, `WorkspaceSecret` (KMS).
- `packages/db` query layer that **requires `workspaceId`** on every read.
- Tests: auth callback, membership gating, secret encrypt/decrypt round-trip.
- **Demo:** log in with Google, land in a workspace, see an empty board.

## Phase 2 — Persistence schema + kanban core (spec §5, §14)
- `prisma migrate dev` for all `DATA_MODEL.md` models.
- `packages/shared/kanban` — 1:1 port of `shared/kanban.ts` (`deriveStatus`, `ALLOWED_EDGES`, `isUserDragAllowed`).
- Context/query modules: `tasks`, `chat`, `workspaces`, `integrations`.
- Tests: **property tests** for the kanban state machine vs. the TS rules; task CRUD + transition audit.
- **Demo:** create/read tasks + transitions via tests; kanban rules green.

## Phase 3 — Brain turn loop (spec §6)
- `packages/agent`: a Pi-backed `Agent` (system-prompt override, custom tools, JSONL session, context usage, abort) — modeled on the prototype `pi-session.ts`.
- In-server brain: stateless-per-turn; history from Postgres; inbox drain (`InboxItem`); sleep/wake via pg-boss; turn lifecycle (§6.2).
- System-prompt composition (§6.1): workspace `brainPrompt` + team memory + member personal memory + theme/Slack ctx, recomposed each turn (hot reload).
- Tests: turn assembly, inbox drain ordering, sleep cancel-on-message, compaction at 150 msgs — all with a mock Pi/model.
- **Demo:** chat with the brain in the SPA; it streams, remembers, sleeps/wakes.

## Phase 4 — Brain tool registry (spec §6.4)
- Tool dispatch framework; task-CRUD tools first: `create_task`, `list_tasks`, `get_task`, `add_note`, `transition_status`, `check_item(s)`, `close_task`, `archive_card`, `merge_duplicate_cards`, `link_card_to_pr`, `ask_user_question`, `sleep`.
- Worker-touching tools (`check_worker`, `message_worker`, `resurrect_worker`) stubbed until Phase 8.
- Tests: each tool's effect + authorization (workspace scoping), `close_task` checklist guard.
- **Demo:** brain creates and transitions cards from chat; board updates live.

## Phase 5 — WS/SSE hub + real-time (spec §11.16)
- WS multiplexed by `channel` target; Postgres `LISTEN/NOTIFY` bus for cross-instance fan-out.
- Streaming event protocol (`assistant_chunk`, `tool_use`, `thinking`, `assistant_done`, `kanban_*`, `task_update`, `context_usage_update`); `switch_target`/history semantics.
- Tests: multiplex routing, cross-instance relay (two server instances, one DB), reconnect/history.
- **Demo:** multiple tabs/instances see synchronized chat + board.

## Phase 6 — Kanban board UI (spec §5, §11.4, §15)
- React board: columns, drag-drop (validated by `isUserDragAllowed`), card actions (abandon/complete/backlog/dispatch/rename/link-pr/un-draft/claim-interactive/edit), quick-add; nanostores for board state; optimistic add with reconcile window.
- Tests: Vitest component tests + a Playwright board-interaction e2e.
- **Demo:** full board interaction; brain + human both drive it.

## Phase 7 — Daytona worker dispatch (spec §9)
- `apps/sandbox`: Daytona snapshot (Dockerfile + `job-entry`) running the Pi agent-runner; streams normalized events; control-plane tools proxy back to server.
- Server `daytona` wrapper (the sandbox service-modeled): create (snapshot+labels+env), push creds (file API), stream logs (SSE), cancel, reattach-by-label; per-worker GitHub App token.
- Tests: daytona wrapper against a **fake Daytona**; creds push atomicity; GitHub token minting against fake Octokit; validation guards on shell-substituted inputs.
- **Demo:** dispatch a sandbox, run the agent in it, stream events to the server.

## Phase 8 — Worker session loop (spec §7)
- Worker orchestration: spawn / follow-up (serialized active-conversation slot) / stop / resurrect / archive; event stream → `Message` + bus; context-usage tracking + >80% inbox warning.
- Worker tools: `rename`, `transition_to_*`, `ask_user_question`, `report_to_brain`, `notifyBrainOfWorkerError`, `spawn_child_card`.
- Wire brain's worker-touching tools (Phase 4 stubs) to real workers.
- Tests: lifecycle transitions, resurrect-reuses-sandbox, brain↔worker tool round-trips (fake Daytona).
- **Demo:** brain spawns a worker → it clones a repo, edits, opens a PR → card graduates.

## Phase 9 — Task / worker detail UI (spec §15)
- Full-screen task modal: streaming worker chat, checklist, PR card, send-to-worker.
- Tests: detail-view e2e (open task, watch stream, send a message).
- **Demo (MVP COMPLETE):** end-to-end hosted loop, multi-company.

---

## Post-MVP enrichment (spec order)

## Phase 10 — Poller (spec §10.1)
pg-boss cron (idle 5min / active 60s); four reconcilers (§5.6); stall detection (§10.1.1) → brain inbox; PR-refresh broadcasts. Tests for each reconciler + stall fire/refire/suppress.

## Phase 11 — GitHub integration (spec §12.1)
Manta GitHub App; REST+GraphQL with installation tokens (replaces `gh`); PR read cache cadence; bot reviews (COMMENT via App token, APPROVE via PAT). Tests against fake Octokit.

## Phase 12 — Linear (spec §12.2)
Manta **Linear app (OAuth)** install flow + webhook ingress (HMAC verify, drop bot comments, filter kinds); identity-routed to workspace brain; handlers (`comment_mention`, `issue_assigned`, `issue_state_changed`); PR-handoff + failure-handoff. Tests: signature verify, routing, handlers.

## Phase 13 — Slack (spec §12.3)
Manta **Slack app** install; Events API (or hosted Socket Mode relay); mention handling (ack → context → brain → `reply_to_slack`); `#support` auto-triage; originator DMs. Tests: event verify, ack lifecycle, dedup.

## Phase 14 — pg-profiles + db-reset (spec §10.5)
`PgProfile` registry; provider branch-reset API (Neon first); preview-then-confirm; per-profile mutex; pause/rebuild/resume; failure modes verbatim. Tests with a fake provider.

## Phase 15 — Permanent sessions (spec §8)
Scout (read-only, `brief_command` to brain), then Support (Linear+Slack workflows, `triage-sweep`, `report_to_brain`), then Style.

## Phase 16 — Claude backend + backend registry (spec §7.5, §12.4)
Expose Claude Code as a second worker backend (snapshot already ships it); `WORKER_BACKENDS` registry; per-workspace default; auth-expiry surfaced to brain.

## Phase 17 — Spotchecks (spec §10.2)
Manifest + per-workspace schedules + working hours; run streaming; findings state machine; ack UX; daily report.

## Phase 18 — Peers + DM + drain/redeploy (spec §12.5, §10.3)
Presence (heartbeat table + NOTIFY); inter-workspace DM with consent + `DmLog`; drain & redeploy primitive (replaces `exit 75`); `update_available` banner.

## Phase 19 — Editor / terminals / scratch sessions (spec §9.3, §11.9, §11.11)
xterm.js terminal channel + PTY (in-sandbox); CodeMirror editor hook + file/git endpoints; scratch + review sessions with TTL GC; LSP relay.

## Phase 20 — Voice / themes / PWA / polish (spec §15)
Voice transcribe; theme system (characters/voices); PWA shell + offline overlay; command palette; recent switcher; unread badges.

---

## Cross-cutting (continuous, not a phase)
- **Tests are a merge gate** from Phase 1 on (`TESTING.md`). No phase merges red.
- **Observability** (spec §17.1): structured logs/traces for every turn, WS conn, webhook, transition, external call; CloudWatch log mirror of agent events; per-worker cost metric.
- **Pricing/metering** (spec §19): decide the unit (brain turns / worker turns / sandbox-hours / tokens) before Phase 16; thread telemetry early.

## Resolved by the product owner (2026-05-28)
1. **Daytona repo pre-seed** → **per-repo snapshots** (each workspace repo gets its own snapshot with a pre-seeded cache).
2. **Worker inference creds** → **per-workspace LLM keys** (workspace brings Anthropic/OpenAI/Pi creds; pushed into the sandbox via the file API; the in-server brain uses the same workspace keys).
3. **Prod DB** → **Neon** (Postgres; branch ergonomics suit pg-profiles/db-reset, matches the platform's dev DB).
4. **Billing/metering** → **out of scope for now** (no pricing model; revisit later).

## Still open
- **Brain personality per workspace**: free-form `brainPrompt` vs. templated-with-variables vs. small DSL.
- **Local-laptop worker** (separate project): confirm the dispatch/stream protocol contract so it can slot in.
