import { prisma, repos, type Task } from "@manta/db";

export interface RepoLike {
  orgRepo: string;
}

/**
 * Resolve a model/user supplied repo name to one of the workspace's configured
 * GitHub slugs when there is an unambiguous match.
 *
 * Besides exact and case-insensitive matches, accept either the bare repo name
 * (`manta`) or an owner/repo slug with the wrong owner (`wrong-org/manta`) when
 * the repo name uniquely identifies a configured workspace repo. This keeps
 * brain-created cards from persisting plausible-looking but unclonable slugs.
 */
export function resolveCanonicalRepo(requestedRepo: string, configuredRepos: RepoLike[]): string {
  const requested = requestedRepo.trim();
  if (!requested) return requested;

  const exact = configuredRepos.find((r) => r.orgRepo === requested);
  if (exact) return exact.orgRepo;

  const lower = requested.toLowerCase();
  const caseInsensitive = configuredRepos.find((r) => r.orgRepo.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive.orgRepo;

  const requestedName = lower.split("/").pop();
  const repoNameMatches = requestedName
    ? configuredRepos.filter((r) => r.orgRepo.split("/").pop()?.toLowerCase() === requestedName)
    : [];
  if (repoNameMatches.length === 1) return repoNameMatches[0]!.orgRepo;

  return requested;
}

export async function canonicalRepoForWorkspace(workspaceId: string, repo: string): Promise<string> {
  return resolveCanonicalRepo(repo, await repos.list({ workspaceId }));
}

/**
 * Repair an already-created task before dispatching it to a worker. This covers
 * cards created before repo canonicalization was tightened, so follow-up turns
 * and model changes don't keep trying to clone a bad slug.
 */
export async function normalizeTaskRepoForDispatch<T extends Pick<Task, "id" | "workspaceId" | "repo">>(task: T): Promise<T> {
  const canonicalRepo = await canonicalRepoForWorkspace(task.workspaceId, task.repo);
  if (canonicalRepo === task.repo) return task;

  await prisma.task.updateMany({
    where: { id: task.id, workspaceId: task.workspaceId },
    data: { repo: canonicalRepo },
  });
  return { ...task, repo: canonicalRepo };
}
