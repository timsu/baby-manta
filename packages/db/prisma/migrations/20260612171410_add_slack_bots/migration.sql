-- CreateEnum
CREATE TYPE "SlackBotType" AS ENUM ('slack', 'linear');

-- CreateEnum
CREATE TYPE "SpawnCardPolicy" AS ENUM ('auto', 'never');

-- DropForeignKey
ALTER TABLE "slack_channel_configs" DROP CONSTRAINT "slack_channel_configs_workspaceId_fkey";

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "slackBotId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "slackUserId" TEXT;

-- DropTable
DROP TABLE "slack_channel_configs";

-- CreateTable
CREATE TABLE "slack_bots" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slackAppId" TEXT NOT NULL,
    "teamId" TEXT,
    "botUserId" TEXT,
    "instructions" TEXT NOT NULL,
    "botType" "SlackBotType" NOT NULL DEFAULT 'slack',
    "autoRespondChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spawnCardPolicy" "SpawnCardPolicy" NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "botTokenCipher" BYTEA NOT NULL,
    "signingSecretCipher" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_bots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_bots_slackAppId_key" ON "slack_bots"("slackAppId");

-- CreateIndex
CREATE INDEX "slack_bots_workspaceId_idx" ON "slack_bots"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "users_slackUserId_key" ON "users"("slackUserId");

-- CreateIndex
CREATE INDEX "tasks_slackBotId_idx" ON "tasks"("slackBotId");

-- AddForeignKey
ALTER TABLE "slack_bots" ADD CONSTRAINT "slack_bots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_slackBotId_fkey" FOREIGN KEY ("slackBotId") REFERENCES "slack_bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

