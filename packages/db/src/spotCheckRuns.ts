import { prisma } from "./client.ts";
import type { SpotCheckRun, SpotCheckVerdict } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";

export interface CreateSpotCheckRunInput {
  spotCheckId: string;
  spotCheckName: string;
  taskId?: string;
  verdict: SpotCheckVerdict;
  summary: string;
  report: string;
  startedAt: Date;
  completedAt?: Date;
}

export function listRecent(scope: WorkspaceScope, limit = 50): Promise<SpotCheckRun[]> {
  return prisma.spotCheckRun.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: { startedAt: "desc" },
    take: Math.max(1, Math.min(limit, 100)),
  });
}

export function listRecentForCheck(scope: WorkspaceScope, spotCheckId: string, limit = 10): Promise<SpotCheckRun[]> {
  return prisma.spotCheckRun.findMany({
    where: { workspaceId: scope.workspaceId, spotCheckId },
    orderBy: { startedAt: "desc" },
    take: Math.max(1, Math.min(limit, 25)),
  });
}

export function create(scope: WorkspaceScope, input: CreateSpotCheckRunInput): Promise<SpotCheckRun> {
  return prisma.spotCheckRun.create({
    data: {
      workspaceId: scope.workspaceId,
      spotCheckId: input.spotCheckId,
      spotCheckName: input.spotCheckName,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      verdict: input.verdict,
      summary: input.summary,
      report: input.report,
      startedAt: input.startedAt,
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    },
  });
}

export async function complete(scope: WorkspaceScope, id: string, input: Pick<CreateSpotCheckRunInput, "verdict" | "summary" | "report">): Promise<SpotCheckRun> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.spotCheckRun.updateMany({
      where: { id, workspaceId: scope.workspaceId },
      data: { ...input, completedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error("spot_check_run_not_found");
    return tx.spotCheckRun.findFirstOrThrow({ where: { id, workspaceId: scope.workspaceId } });
  });
}

export function failStale(scope: WorkspaceScope, startedBefore: Date): Promise<{ count: number }> {
  return prisma.spotCheckRun.updateMany({
    where: { workspaceId: scope.workspaceId, completedAt: null, startedAt: { lt: startedBefore } },
    data: {
      verdict: "unknown",
      summary: "Run interrupted",
      report: "The spot check did not complete. Open the run task for details.",
      completedAt: new Date(),
    },
  });
}
