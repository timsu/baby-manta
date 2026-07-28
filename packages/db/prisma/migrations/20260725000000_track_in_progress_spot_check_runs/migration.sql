ALTER TABLE "spot_check_runs" ALTER COLUMN "completedAt" DROP NOT NULL;
ALTER TABLE "spot_check_runs" ALTER COLUMN "completedAt" DROP DEFAULT;

DROP INDEX "spot_check_runs_workspaceId_completedAt_idx";
CREATE INDEX "spot_check_runs_workspaceId_startedAt_idx" ON "spot_check_runs"("workspaceId", "startedAt");
