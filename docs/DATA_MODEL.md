# Manta — Data Model (Prisma / PostgreSQL)

Maps the prototype's data spec onto a single Postgres store via **Prisma**, in the **Workspace**
multi-company model. Everything durable and workspace-owned carries `workspaceId`. Daytona owns
live sandbox state; this schema owns product state (workspaces, users, tasks/kanban, chat,
memory, integration configs).

Conventions (converged with the platform):
- Prisma model names PascalCase; Postgres tables snake_case via `@@map`; columns camelCase.
- `cuid()` PKs unless a human-facing short id is needed (`Task.id` = `c-XXXX`).
- `createdAt` / `updatedAt` on every model.
- Enums are Prisma enums; JSON columns are `Json`.
- Secrets are **app-encrypted** before storage (KMS data key); never plaintext.
- Migrations only ever via `npx prisma migrate dev --name <n>`.

This is a sketch to generate `schema.prisma` from, not the final file. Money/quota/telemetry
columns are deferred until the metering model (spec §19) is decided.

---

## 1. Workspace, users, identity, secrets

```prisma
model Workspace {
  id              String   @id @default(cuid())
  slug            String   @unique          // URL-safe, e.g. "acme"
  name            String
  settings        Json     @default("{}")   // brain model default, worker backend default, concurrency cap, theme
  brainPrompt     String   @db.Text         // per-workspace brain system prompt (hot-reloaded each turn)
  teamMemory      String   @db.Text @default("") // spec memory.md; editable by the brain via a tool
  status          WorkspaceStatus @default(active)
  // relations: members, repos, identities, secrets, tasks, ...
}
enum WorkspaceStatus { active suspended }

model User {
  id             String   @id @default(cuid())
  googleSub      String   @unique           // Google OAuth subject
  email          String   @unique
  name           String?
  avatarUrl      String?
  // personalMemory is per (user, workspace) — see Membership
}

model Membership {
  id             String   @id @default(cuid())
  userId         String
  workspaceId    String
  role           Role     @default(member)
  personalMemory String   @db.Text @default("") // spec memory.local.md; auto-injected into brain prompt
  @@unique([userId, workspaceId])
}
enum Role { owner admin member }
```

### Workspace integration identity & secrets

One Manta-owned app per provider; workspaces install them. We store the per-workspace
installation/grant, and map inbound webhook identity → workspace.

```prisma
model WorkspaceIdentity {            // webhook routing (replaces Upstash affinity)
  id          String   @id @default(cuid())
  workspaceId String
  provider    Provider                       // github | linear | slack
  externalId  String                         // GH installation id / Linear org id / Slack team id
  @@unique([provider, externalId])
}
enum Provider { github linear slack google }

model WorkspaceSecret {
  id          String   @id @default(cuid())
  workspaceId String
  kind        SecretKind
  ciphertext  Bytes                          // KMS-data-key encrypted JSON
  meta        Json     @default("{}")        // non-secret: installation id, scopes, expiry
  @@unique([workspaceId, kind])
}
enum SecretKind {
  github_app_install linear_oauth slack_bot slack_app slack_user
  anthropic openai pi pg_provider
}
```

> GitHub/Linear/Slack **app-level** secrets (the single Manta app's private key, client secret,
> signing/webhook secrets) live in AWS Secrets Manager, not here — these tables hold only the
> **per-workspace** grants.

---

## 2. Task (central entity — spec §4.1)

The combined ticket + kanban card + worker-session row. Short human id for URLs.

```prisma
model Task {
  id                 String   @id            // "c-8640"; reviews "rev-<cuid>"; u- stays client-only
  workspaceId        String
  name               String                  // kebab slug -> branch / worktree path
  title              String
  description        String   @db.Text        // initial worker prompt; may start Skill('name','args')
  kind               TaskKind                // agent | self | skill | review | pr_review
  cardType           CardType                // bot | interactive | backlog | plan  (immutable)
  cardStatus         CardStatus              // stored kanban status (§5.1)
  doneReason         DoneReason?
  repo               String                  // org/repo
  branch             String?
  worktreePath       String?
  workerStatus       WorkerStatus @default(pending)
  workerActive       Boolean  @default(false)
  workerBackend      String                  // "pi-gpt-5.4" | "claude-sonnet" ... pinned at spawn
  model              String?                 // backend-specific
  effort             Effort?                 // low | medium | high
  modelReasoning     String?
  sandboxId          String?                 // Daytona sandbox id (worker); session pointer
  sessionBlobKey     String?                 // S3/Postgres key for the Pi JSONL session
  priority           Int?
  type               TaskType?               // bug | feature | task | epic | chore
  startedAt          DateTime?
  characterName      String?
  characterEmoji     String?
  characterSound     String?
  checklist          Json     @default("[]") // [{text, done}]; blocks close_task if unchecked
  prNumber           Int?
  prUrl              String?
  prTitle            String?
  prState            String?
  prUpdatedAt        DateTime?
  prCache            Json?                    // {isDraft,isMerged,isClosed,state,checkedAt} (§5.3)
  checks             Json     @default("[]") // [CICheck]
  checksStatus       ChecksStatus @default(unknown)
  reviewComments     Json     @default("[]")
  reviewDecision     String?                  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  mergeable          Mergeable @default(UNKNOWN)
  contextUsage       Json?                    // {tokens, contextWindow, percent}
  contextWarned      Boolean  @default(false)
  pgProfile          String?                  // pinned at creation, immutable (§10.5)
  paused             Boolean  @default(false)
  staleClient        Boolean  @default(false)
  slackChannel       String?
  slackThreadTs      String?
  slackUserId        String?
  slackPrLinkPosted  Boolean  @default(false)
  slackDmSent        Boolean  @default(false)
  slackTriageIssuePosted Boolean @default(false)
  triageIssueUrl     String?
  linearAssignment   Json?                    // {issueId, issueIdentifier, assignerId, prHandoffPosted?, failureHandoffPosted?}
  linearTriage       Json?
  linearIssueIdentifier String?
  archivedAt         DateTime?
  transitions        Json     @default("[]") // mirror of TaskTransition for cheap reads
  @@index([workspaceId, cardStatus])
}

enum TaskKind   { agent self skill review pr_review }
enum CardType   { bot interactive backlog plan }
enum CardStatus { backlog bot_working needs_help ready_to_test interactive pr_review done }
enum DoneReason { merged abandoned completed closed_unmerged }
enum WorkerStatus { pending spawning running pr_created done failed stalled archived }
enum Effort     { low medium high }
enum TaskType   { bug feature task epic chore }
enum ChecksStatus { pending passing failing unknown }
enum Mergeable  { MERGEABLE CONFLICTING UNKNOWN }
```

> **Worker session pointer.** Unlike the brain (history owned by us, replayed to the stateless
> model), a worker's Pi session lives where the agent runs — in the Daytona sandbox. `sandboxId`
> + `sessionBlobKey` let a resurrect reuse the worktree/history. Worker chat is still mirrored to
> `Message` for UI + audit.

```prisma
model TaskTransition {              // append-only audit (also mirrored to Task.transitions)
  id          String   @id @default(cuid())
  taskId      String
  workspaceId String
  fromStatus  CardStatus
  toStatus    CardStatus
  by          TransitionActor       // worker | brain | poller | human
  reason      String?
  at          DateTime @default(now())
  @@index([taskId])
}
enum TransitionActor { worker brain poller human }
```

`deriveStatus` (§5.2), `ALLOWED_EDGES` (§5.4), `isUserDragAllowed` (§5.5) live in
`packages/shared/kanban` — a 1:1 port of `shared/kanban.ts`, covered by property tests.

---

## 3. Conversations & agent state

```prisma
model Message {                      // append-only, ordered per channel
  id          String   @id @default(cuid())
  workspaceId String
  channel     String                 // "brain" | "scout" | "support" | "style" | "perm-<id>" | "<taskId>"
  seq         BigInt                  // monotonic per (workspaceId, channel)
  role        MessageRole            // user | assistant | status | system
  content     String   @db.Text
  meta        Json?                   // tool_use / thinking / tool_result structure for replay
  images      Json?                   // [{key, type}] -> S3 (not inline data URLs at rest)
  ts          DateTime @default(now())
  @@index([workspaceId, channel, seq])
}
enum MessageRole { user assistant status system }

model AgentSession {                 // brain + perm-session runtime state surviving restart
  id            String   @id @default(cuid())
  workspaceId   String
  channel       String                // unique with workspace
  kind          SessionKind           // brain | scout | support | style | custom
  backend       String
  sleepUntil    DateTime?             // armed wake (scheduled job consults this)
  sleepWorkerId String?               // auto-include this worker's status on wake
  sessionBlobKey String?              // S3 key for the Pi JSONL (if warm-cached strategy used)
  flags         Json     @default("{}")
  @@unique([workspaceId, channel])
}
enum SessionKind { brain scout support style custom }

model InboxItem {                    // durable mirror of a session's async inbox (§6.3)
  id          String   @id @default(cuid())
  workspaceId String
  channel     String                  // usually "brain"
  body        String   @db.Text        // "[STALL] ...", "[Worker error: ...]", "[update-request]...", "[Inbox]..."
  source      InboxSource             // poller | worker | peer | perm_session
  consumedAt  DateTime?               // drained at next turn start
  @@index([workspaceId, channel, consumedAt])
}
enum InboxSource { poller worker peer perm_session }
```

Compaction (spec §14.3): at ~150 `Message` rows per channel, collapse oldest 50 into one
`assistant` "Session summary" row; keep newest 100+.

---

## 4. Non-task sessions

```prisma
model PermSession {                  // catalog of permanent sessions (built-ins seeded + custom)
  id           String  @id @default(cuid())
  workspaceId  String
  slug         String                 // scout | support | style | custom-...
  label        String
  dir          String?
  systemPrompt String? @db.Text
  initMessage  String? @db.Text
  backend      String
  @@unique([workspaceId, slug])
}

model ScratchSession {               // spec's "Workspace"/"Review" scratch worktrees, renamed to avoid
  id          String   @id           //   collision with the tenant Workspace. ws-<cuid> / rev-<cuid>
  workspaceId String
  kind        ScratchKind            // scratch | review
  repo        String
  branch      String?
  prNumber    Int?
  sandboxId   String?
  expiresAt   DateTime?              // 7d / on PR close
}
enum ScratchKind { scratch review }
```

---

## 5. Integrations & background

```prisma
model Repo {
  id           String  @id @default(cuid())
  workspaceId  String
  orgRepo      String                 // org/repo
  defaultBranch String @default("main")
  kindHint     TaskKind?
  enabled      Boolean @default(true)
  @@unique([workspaceId, orgRepo])
}

model WebhookDelivery {              // dedup + audit (replaces *:seen:* SETNX)
  id          String   @id @default(cuid())
  provider    Provider
  eventId     String
  workspaceId String?                 // resolved workspace (null if unroutable)
  kind        String
  payload     Json
  routedTo    String?
  receivedAt  DateTime @default(now())
  @@unique([provider, eventId])
}

model PgProfile {                    // replaces .dstenv.json (§10.5): a managed Postgres branch
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  provider    PgProvider             // neon | supabase | crunchy | other
  branchRef   String
  meta        Json     @default("{}") // connection metadata (token in WorkspaceSecret)
  @@unique([workspaceId, name])
}
enum PgProvider { neon supabase crunchy other }

model SpotcheckRun {
  id            String   @id @default(cuid())
  workspaceId   String
  checkName     String
  status        String
  report        String   @db.Text @default("")
  logs          String   @db.Text @default("")
  acknowledgedAt DateTime?
}
model SpotcheckFinding {
  id        String   @id @default(cuid())
  runId     String
  status    FindingStatus @default(new)
  body      Json
}
enum FindingStatus { new acknowledged actioned dismissed stale }
model SpotcheckSetting {
  id           String  @id @default(cuid())
  workspaceId  String
  checkName    String
  intervalMs   Int
  workingHours Json?
  enabled      Boolean @default(true)
  @@unique([workspaceId, checkName])
}

model DmLog {                        // inter-workspace DM audit (§12.5); delivery rides pub/sub
  id            String   @id @default(cuid())
  fromUserId    String
  fromWorkspaceId String
  toWorkspaceId String?
  toExternal    String?              // e.g. github login
  body          String   @db.Text
  isReply       Boolean  @default(false)
  sentAt        DateTime @default(now())
}
```

Background jobs (poller ticks, spotcheck schedules, webhook retries, sandbox GC, brain wakes):
a Postgres-backed job runner — **pg-boss** (lightweight, Node, Postgres-native) — chosen to
avoid new infra. (the platform uses hatchet.run; Manta is standalone and lighter, so pg-boss unless
we later want hatchet parity.)

---

## 6. Indexing & isolation

- Every hot query leads with `workspaceId`; the **query layer (`packages/db`) requires a
  `workspaceId`** and never crosses it — enforced at the module boundary, not in route code.
- Hottest indexes: `Message (workspaceId, channel, seq)` (chat paging) and
  `Task (workspaceId, cardStatus)` (board snapshot).
- `WorkspaceIdentity (provider, externalId)` unique — webhook routing critical path.
- Consider Postgres RLS as defense-in-depth once the query-layer boundary is proven.

---

*Source of truth for field meaning remains the running prototype code. Generate
`packages/db/schema.prisma` from this, then `prisma migrate dev`.*
