-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "brainPrompt" TEXT NOT NULL DEFAULT '',
    "teamMemory" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "githubLogin" TEXT,
    "githubUserId" TEXT,
    "slackUserId" TEXT,
    "linearUserId" TEXT,
    "linearName" TEXT,
    "localWorkerOnboardingDismissed" BOOLEAN NOT NULL DEFAULT false,
    "nonEngineer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "worker_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "worker_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sandbox_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    CONSTRAINT "sandbox_credentials_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "personalMemory" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdBy" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workspace_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workspace_secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "workspace_secrets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_secrets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cardType" TEXT NOT NULL,
    "cardStatus" TEXT NOT NULL DEFAULT 'bot_working',
    "doneReason" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "backgroundMode" TEXT,
    "repo" TEXT NOT NULL,
    "branch" TEXT,
    "worktreePath" TEXT,
    "workerStatus" TEXT NOT NULL DEFAULT 'pending',
    "workerActive" BOOLEAN NOT NULL DEFAULT false,
    "workerBackend" TEXT NOT NULL,
    "model" TEXT,
    "effort" TEXT,
    "modelReasoning" TEXT,
    "sandboxId" TEXT,
    "sessionBlobKey" TEXT,
    "workerVenue" TEXT NOT NULL DEFAULT 'none',
    "venueStatus" TEXT NOT NULL DEFAULT 'none',
    "venueStoppedAt" DATETIME,
    "priority" INTEGER,
    "type" TEXT,
    "startedAt" DATETIME,
    "characterName" TEXT,
    "characterEmoji" TEXT,
    "characterSound" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "terminalTabs" JSONB NOT NULL DEFAULT '[]',
    "planDocument" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "prTitle" TEXT,
    "prState" TEXT,
    "prUpdatedAt" DATETIME,
    "prCache" JSONB,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "checksStatus" TEXT NOT NULL DEFAULT 'unknown',
    "reviewComments" JSONB NOT NULL DEFAULT '[]',
    "reviewDecision" TEXT,
    "mergeable" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "autoMergeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "contextUsage" JSONB,
    "contextWarned" BOOLEAN NOT NULL DEFAULT false,
    "pgProfile" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "staleClient" BOOLEAN NOT NULL DEFAULT false,
    "slackChannel" TEXT,
    "slackThreadTs" TEXT,
    "slackUserId" TEXT,
    "slackBotId" TEXT,
    "slackPrLinkPosted" BOOLEAN NOT NULL DEFAULT false,
    "slackDmSent" BOOLEAN NOT NULL DEFAULT false,
    "slackTriageIssuePosted" BOOLEAN NOT NULL DEFAULT false,
    "triageIssueUrl" TEXT,
    "linearAssignment" JSONB,
    "linearTriage" JSONB,
    "linearIssueIdentifier" TEXT,
    "linearIssueUrl" TEXT,
    "linearCommentPosted" BOOLEAN NOT NULL DEFAULT false,
    "transitions" JSONB NOT NULL DEFAULT '[]',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "taskNumber" INTEGER,
    CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tasks_slackBotId_fkey" FOREIGN KEY ("slackBotId") REFERENCES "slack_bots" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "spot_check_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "spotCheckId" TEXT NOT NULL,
    "spotCheckName" TEXT NOT NULL,
    "taskId" TEXT,
    "verdict" TEXT NOT NULL DEFAULT 'unknown',
    "summary" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "spot_check_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "task_transitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "reason" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_transitions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "images" JSONB,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "sleepUntil" DATETIME,
    "sleepWorkerId" TEXT,
    "sessionBlobKey" TEXT,
    "flags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "inbox_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "perm_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dir" TEXT,
    "systemPrompt" TEXT,
    "initMessage" TEXT,
    "backend" TEXT NOT NULL,
    CONSTRAINT "perm_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scratch_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT,
    "prNumber" INTEGER,
    "sandboxId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "repos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "orgRepo" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "kindHint" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "setupCommands" TEXT NOT NULL DEFAULT '',
    "globalInstructions" TEXT NOT NULL DEFAULT '',
    "skillRepos" JSONB NOT NULL DEFAULT '[]',
    CONSTRAINT "repos_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "repo_personal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "repo_personal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_personal_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repos" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "routedTo" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "pg_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "branchRef" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "spotcheck_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "report" TEXT NOT NULL DEFAULT '',
    "logs" TEXT NOT NULL DEFAULT '',
    "acknowledgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "spotcheck_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "body" JSONB NOT NULL,
    CONSTRAINT "spotcheck_findings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "spotcheck_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "spotcheck_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "workingHours" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "dm_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromUserId" TEXT NOT NULL,
    "fromWorkspaceId" TEXT NOT NULL,
    "toWorkspaceId" TEXT,
    "toExternal" TEXT,
    "body" TEXT NOT NULL,
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "slack_bots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slackAppId" TEXT NOT NULL,
    "teamId" TEXT,
    "botUserId" TEXT,
    "instructions" TEXT NOT NULL,
    "botType" TEXT NOT NULL DEFAULT 'slack',
    "autoRespondChannels" JSONB NOT NULL DEFAULT '[]',
    "autoRespondChannelInstructions" JSONB NOT NULL DEFAULT '{}',
    "spawnCardPolicy" TEXT NOT NULL DEFAULT 'auto',
    "defaultRepo" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "botTokenCipher" BLOB NOT NULL,
    "signingSecretCipher" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_bots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slack_message_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slackBotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "repo" TEXT,
    "prompt" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "timeOfDayUtc" TEXT NOT NULL,
    "dayOfWeekUtc" INTEGER,
    "daysOfWeek" JSONB NOT NULL DEFAULT '[]',
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "includeWeekendsAndHolidays" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_message_schedules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "slack_message_schedules_slackBotId_workspaceId_fkey" FOREIGN KEY ("slackBotId", "workspaceId") REFERENCES "slack_bots" ("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "card_images" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "sha256" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "card_images_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSub_key" ON "users"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_slackUserId_key" ON "users"("slackUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_linearUserId_key" ON "users"("linearUserId");

-- CreateIndex
CREATE UNIQUE INDEX "worker_credentials_tokenHash_key" ON "worker_credentials"("tokenHash");

-- CreateIndex
CREATE INDEX "worker_credentials_userId_idx" ON "worker_credentials"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_credentials_tokenHash_key" ON "sandbox_credentials"("tokenHash");

-- CreateIndex
CREATE INDEX "sandbox_credentials_taskId_idx" ON "sandbox_credentials"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_workspaceId_key" ON "memberships"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_code_key" ON "invitations"("code");

-- CreateIndex
CREATE INDEX "invitations_workspaceId_idx" ON "invitations"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_identities_workspaceId_idx" ON "workspace_identities"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_identities_provider_externalId_key" ON "workspace_identities"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_secrets_workspaceId_kind_key" ON "workspace_secrets"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "user_secrets_userId_kind_key" ON "user_secrets"("userId", "kind");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_cardStatus_idx" ON "tasks"("workspaceId", "cardStatus");

-- CreateIndex
CREATE INDEX "tasks_slackBotId_idx" ON "tasks"("slackBotId");

-- CreateIndex
CREATE INDEX "spot_check_runs_workspaceId_startedAt_idx" ON "spot_check_runs"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "spot_check_runs_workspaceId_spotCheckId_idx" ON "spot_check_runs"("workspaceId", "spotCheckId");

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
CREATE UNIQUE INDEX "repo_personal_userId_repoId_key" ON "repo_personal"("userId", "repoId");

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

-- CreateIndex
CREATE UNIQUE INDEX "slack_bots_slackAppId_key" ON "slack_bots"("slackAppId");

-- CreateIndex
CREATE INDEX "slack_bots_workspaceId_idx" ON "slack_bots"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_bots_id_workspaceId_key" ON "slack_bots"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_workspaceId_idx" ON "slack_message_schedules"("workspaceId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_slackBotId_idx" ON "slack_message_schedules"("slackBotId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_enabled_nextRunAt_idx" ON "slack_message_schedules"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "card_images_workspaceId_idx" ON "card_images"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "card_images_workspaceId_sha256_key" ON "card_images"("workspaceId", "sha256");
