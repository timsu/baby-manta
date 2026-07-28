import { prisma } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";
import type { Repo, RepoPersonal, Prisma } from "../generated/client/index.js";

export function list(scope: WorkspaceScope): Promise<Repo[]> {
  return prisma.repo.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: { orgRepo: "asc" },
  });
}

/** Look up a single repo by its `org/repo` within the workspace. */
export function byOrgRepo(scope: WorkspaceScope, orgRepo: string): Promise<Repo | null> {
  return prisma.repo.findUnique({
    where: { workspaceId_orgRepo: { workspaceId: scope.workspaceId, orgRepo } },
  });
}

export interface AddRepoInput {
  orgRepo: string;
  defaultBranch?: string;
}

export interface UpdateRepoInput {
  setupCommands?: string;
  globalInstructions?: string;
  skillRepos?: Prisma.InputJsonValue;
}

/** Add (or re-enable) a repo in the workspace. Idempotent on (workspace, orgRepo). */
export function add(scope: WorkspaceScope, input: AddRepoInput): Promise<Repo> {
  return prisma.repo.upsert({
    where: { workspaceId_orgRepo: { workspaceId: scope.workspaceId, orgRepo: input.orgRepo } },
    create: {
      workspaceId: scope.workspaceId,
      orgRepo: input.orgRepo,
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
    },
    update: { enabled: true, ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}) },
  });
}

export function update(scope: WorkspaceScope, id: string, input: UpdateRepoInput): Promise<Repo> {
  return prisma.repo.update({
    where: { id, workspaceId: scope.workspaceId },
    data: input,
  });
}

/** Remove a repo from the workspace (scoped so it can't touch another tenant). */
export async function remove(scope: WorkspaceScope, id: string): Promise<void> {
  await prisma.repo.deleteMany({ where: { id, workspaceId: scope.workspaceId } });
}

export async function getPersonal(userId: string, repoId: string): Promise<RepoPersonal | null> {
  return prisma.repoPersonal.findUnique({ where: { userId_repoId: { userId, repoId } } });
}

export async function setPersonal(userId: string, repoId: string, instructions: string): Promise<RepoPersonal> {
  return prisma.repoPersonal.upsert({
    where: { userId_repoId: { userId, repoId } },
    create: { userId, repoId, instructions },
    update: { instructions },
  });
}
