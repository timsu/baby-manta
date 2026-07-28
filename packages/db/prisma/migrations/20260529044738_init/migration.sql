-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('github', 'linear', 'slack', 'google');

-- CreateEnum
CREATE TYPE "SecretKind" AS ENUM ('github_app_install', 'linear_oauth', 'slack_bot', 'slack_app', 'slack_user', 'anthropic', 'openai', 'pi', 'pg_provider');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('agent', 'self', 'skill', 'review', 'pr_review');

-- CreateEnum
CREATE TYPE "CardType" AS ENUM ('bot', 'interactive', 'backlog', 'plan');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('backlog', 'bot_working', 'needs_help', 'ready_to_test', 'interactive', 'pr_review', 'done');

-- CreateEnum
CREATE TYPE "DoneReason" AS ENUM ('merged', 'abandoned', 'completed', 'closed_unmerged');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('pending', 'spawning', 'running', 'pr_created', 'done', 'failed', 'stalled', 'archived');

-- CreateEnum
CREATE TYPE "Effort" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('bug', 'feature', 'task', 'epic', 'chore');

-- CreateEnum
CREATE TYPE "ChecksStatus" AS ENUM ('pending', 'passing', 'failing', 'unknown');

-- CreateEnum
CREATE TYPE "Mergeable" AS ENUM ('MERGEABLE', 'CONFLICTING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TransitionActor" AS ENUM ('worker', 'brain', 'poller', 'human');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'status', 'system');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('brain', 'scout', 'support', 'style', 'custom');

-- CreateEnum
CREATE TYPE "InboxSource" AS ENUM ('poller', 'worker', 'peer', 'perm_session');

-- CreateEnum
CREATE TYPE "ScratchKind" AS ENUM ('scratch', 'review');

-- CreateEnum
CREATE TYPE "PgProvider" AS ENUM ('neon', 'supabase', 'crunchy', 'other');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('new', 'acknowledged', 'actioned', 'dismissed', 'stale');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "brainPrompt" TEXT NOT NULL DEFAULT '',
    "teamMemory" TEXT NOT NULL DEFAULT '',
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "personalMemory" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_secrets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "SecretKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "TaskKind" NOT NULL,
    "cardType" "CardType" NOT NULL,
    "cardStatus" "CardStatus" NOT NULL DEFAULT 'bot_working',
    "doneReason" "DoneReason",
    "repo" TEXT NOT NULL,
    "branch" TEXT,
    "worktreePath" TEXT,
    "workerStatus" "WorkerStatus" NOT NULL DEFAULT 'pending',
    "workerActive" BOOLEAN NOT NULL DEFAULT false,
    "workerBackend" TEXT NOT NULL,
    "model" TEXT,
    "effort" "Effort",
    "modelReasoning" TEXT,
    "sandboxId" TEXT,
    "sessionBlobKey" TEXT,
    "priority" INTEGER,
    "type" "TaskType",
    "startedAt" TIMESTAMP(3),
    "characterName" TEXT,
    "characterEmoji" TEXT,
    "characterSound" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "prTitle" TEXT,
    "prState" TEXT,
    "prUpdatedAt" TIMESTAMP(3),
    "prCache" JSONB,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "checksStatus" "ChecksStatus" NOT NULL DEFAULT 'unknown',
    "reviewComments" JSONB NOT NULL DEFAULT '[]',
    "reviewDecision" TEXT,
    "mergeable" "Mergeable" NOT NULL DEFAULT 'UNKNOWN',
    "contextUsage" JSONB,
    "contextWarned" BOOLEAN NOT NULL DEFAULT false,
    "pgProfile" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "staleClient" BOOLEAN NOT NULL DEFAULT false,
    "slackChannel" TEXT,
    "slackThreadTs" TEXT,
    "slackUserId" TEXT,
    "slackPrLinkPosted" BOOLEAN NOT NULL DEFAULT false,
    "slackDmSent" BOOLEAN NOT NULL DEFAULT false,
    "slackTriageIssuePosted" BOOLEAN NOT NULL DEFAULT false,
    "triageIssueUrl" TEXT,
    "linearAssignment" JSONB,
    "linearTriage" JSONB,
    "linearIssueIdentifier" TEXT,
    "transitions" JSONB NOT NULL DEFAULT '[]',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_transitions" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromStatus" "CardStatus" NOT NULL,
    "toStatus" "CardStatus" NOT NULL,
    "by" "TransitionActor" NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "images" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "backend" TEXT NOT NULL,
    "sleepUntil" TIMESTAMP(3),
    "sleepWorkerId" TEXT,
    "sessionBlobKey" TEXT,
    "flags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" "InboxSource" NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perm_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dir" TEXT,
    "systemPrompt" TEXT,
    "initMessage" TEXT,
    "backend" TEXT NOT NULL,

    CONSTRAINT "perm_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scratch_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ScratchKind" NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT,
    "prNumber" INTEGER,
    "sandboxId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scratch_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repos" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orgRepo" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "kindHint" "TaskKind",
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "eventId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "routedTo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pg_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "PgProvider" NOT NULL,
    "branchRef" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "pg_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spotcheck_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "report" TEXT NOT NULL DEFAULT '',
    "logs" TEXT NOT NULL DEFAULT '',
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spotcheck_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spotcheck_findings" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'new',
    "body" JSONB NOT NULL,

    CONSTRAINT "spotcheck_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spotcheck_settings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "workingHours" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "spotcheck_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_log" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "fromWorkspaceId" TEXT NOT NULL,
    "toWorkspaceId" TEXT,
    "toExternal" TEXT,
    "body" TEXT NOT NULL,
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSub_key" ON "users"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_workspaceId_key" ON "memberships"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "workspace_identities_workspaceId_idx" ON "workspace_identities"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_identities_provider_externalId_key" ON "workspace_identities"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_secrets_workspaceId_kind_key" ON "workspace_secrets"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_cardStatus_idx" ON "tasks"("workspaceId", "cardStatus");

-- CreateIndex
CREATE INDEX "task_transitions_taskId_idx" ON "task_transitions"("taskId");

-- CreateIndex
CREATE INDEX "messages_workspaceId_channel_seq_idx" ON "messages"("workspaceId", "channel", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_workspaceId_channel_key" ON "agent_sessions"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "inbox_items_workspaceId_channel_consumedAt_idx" ON "inbox_items"("workspaceId", "channel", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "perm_sessions_workspaceId_slug_key" ON "perm_sessions"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "scratch_sessions_workspaceId_idx" ON "scratch_sessions"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "repos_workspaceId_orgRepo_key" ON "repos"("workspaceId", "orgRepo");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_provider_eventId_key" ON "webhook_deliveries"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "pg_profiles_workspaceId_name_key" ON "pg_profiles"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "spotcheck_runs_workspaceId_idx" ON "spotcheck_runs"("workspaceId");

-- CreateIndex
CREATE INDEX "spotcheck_findings_runId_idx" ON "spotcheck_findings"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "spotcheck_settings_workspaceId_checkName_key" ON "spotcheck_settings"("workspaceId", "checkName");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_identities" ADD CONSTRAINT "workspace_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perm_sessions" ADD CONSTRAINT "perm_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repos" ADD CONSTRAINT "repos_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spotcheck_findings" ADD CONSTRAINT "spotcheck_findings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "spotcheck_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
