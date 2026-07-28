-- CreateEnum
CREATE TYPE "SlackMessageScheduleCadence" AS ENUM ('daily', 'weekly');

-- CreateTable
CREATE TABLE "slack_message_schedules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackBotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "cadence" "SlackMessageScheduleCadence" NOT NULL,
    "timeOfDayUtc" TEXT NOT NULL,
    "dayOfWeekUtc" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_message_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_bots_id_workspaceId_key" ON "slack_bots"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_workspaceId_idx" ON "slack_message_schedules"("workspaceId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_slackBotId_idx" ON "slack_message_schedules"("slackBotId");

-- CreateIndex
CREATE INDEX "slack_message_schedules_enabled_nextRunAt_idx" ON "slack_message_schedules"("enabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "slack_message_schedules" ADD CONSTRAINT "slack_message_schedules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_message_schedules" ADD CONSTRAINT "slack_message_schedules_slackBotId_workspaceId_fkey" FOREIGN KEY ("slackBotId", "workspaceId") REFERENCES "slack_bots"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
