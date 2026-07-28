-- CreateTable
CREATE TABLE "slack_channel_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_channel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_channel_configs_channelId_idx" ON "slack_channel_configs"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_channel_configs_workspaceId_channelId_key" ON "slack_channel_configs"("workspaceId", "channelId");

-- AddForeignKey
ALTER TABLE "slack_channel_configs" ADD CONSTRAINT "slack_channel_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
