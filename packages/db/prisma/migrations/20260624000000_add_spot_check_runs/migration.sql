-- Persist spot-check run history as append-only operational data instead of
-- embedding it in workspace settings JSON.

CREATE TYPE "SpotCheckVerdict" AS ENUM ('pass', 'warn', 'fail', 'unknown');

CREATE TABLE "spot_check_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "spotCheckId" TEXT NOT NULL,
    "spotCheckName" TEXT NOT NULL,
    "verdict" "SpotCheckVerdict" NOT NULL DEFAULT 'unknown',
    "summary" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spot_check_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spot_check_runs_workspaceId_completedAt_idx" ON "spot_check_runs"("workspaceId", "completedAt");
CREATE INDEX "spot_check_runs_workspaceId_spotCheckId_idx" ON "spot_check_runs"("workspaceId", "spotCheckId");

ALTER TABLE "spot_check_runs" ADD CONSTRAINT "spot_check_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
