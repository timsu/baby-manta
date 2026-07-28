import { prisma } from "@manta/db";
import { commentOnPr, requestPrReviewers } from "./app.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("github:review-routing");

type TaskForReviewRouting = {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  title: string;
};

const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };

type ReviewCandidate = { role: string; createdAt: Date; user: { githubLogin: string | null } };

const MAX_HISTORY_FILES = 20;
const COMMITS_PER_FILE = 10;

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchPrFiles(orgRepo: string, token: string, prNumber: number): Promise<string[]> {
  const [owner, repo] = orgRepo.split("/");
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${MAX_HISTORY_FILES}`, {
    headers: githubHeaders(token),
  });
  if (!r.ok) throw new Error(`GitHub list PR files → ${r.status}: ${await r.text()}`);
  const files = await r.json() as Array<{ filename?: string }>;
  return files.map((file) => file.filename).filter((filename): filename is string => Boolean(filename));
}

async function fetchRecentAuthorsForPath(orgRepo: string, token: string, base: string, path: string): Promise<string[]> {
  const [owner, repo] = orgRepo.split("/");
  const params = new URLSearchParams({ sha: base, path, per_page: String(COMMITS_PER_FILE) });
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`, {
    headers: githubHeaders(token),
  });
  if (!r.ok) throw new Error(`GitHub list commits for ${path} → ${r.status}: ${await r.text()}`);
  const commits = await r.json() as Array<{ author?: { login?: string | null } | null }>;
  return commits.map((commit) => commit.author?.login).filter((login): login is string => Boolean(login));
}

async function reviewerFromGitHistory(opts: {
  orgRepo: string;
  token: string;
  prNumber: number;
  base: string;
  candidates: ReviewCandidate[];
}): Promise<string | null> {
  const candidateByLogin = new Map<string, ReviewCandidate>();
  for (const candidate of opts.candidates) {
    const login = candidate.user.githubLogin?.toLowerCase();
    if (login) candidateByLogin.set(login, candidate);
  }
  if (candidateByLogin.size === 0) return null;

  const files = await fetchPrFiles(opts.orgRepo, opts.token, opts.prNumber);
  const scores = new Map<string, number>();
  for (const path of files) {
    const authors = await fetchRecentAuthorsForPath(opts.orgRepo, opts.token, opts.base, path);
    for (const author of authors) {
      const login = author.toLowerCase();
      if (!candidateByLogin.has(login)) continue;
      scores.set(login, (scores.get(login) ?? 0) + 1);
    }
  }

  const best = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort(([aLogin, aScore], [bLogin, bScore]) => {
      if (bScore !== aScore) return bScore - aScore;
      const a = candidateByLogin.get(aLogin)!;
      const b = candidateByLogin.get(bLogin)!;
      const roleDelta = (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9);
      if (roleDelta !== 0) return roleDelta;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })[0];
  return best ? candidateByLogin.get(best[0])?.user.githubLogin ?? null : null;
}

export async function routeNonEngineerPrReview(opts: {
  task: TaskForReviewRouting;
  orgRepo: string;
  token: string;
  prNumber: number;
  prUrl: string;
  base: string;
}): Promise<{ reviewerLogin: string | null }> {
  const creatorId = opts.task.createdBy;
  if (!creatorId) return { reviewerLogin: null };

  const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { nonEngineer: true, name: true } });
  if (!creator?.nonEngineer) return { reviewerLogin: null };

  const candidates = await prisma.membership.findMany({
    where: {
      workspaceId: opts.task.workspaceId,
      userId: { not: creatorId },
      user: { nonEngineer: false, githubLogin: { not: null } },
    },
    include: { user: { select: { githubLogin: true } } },
    orderBy: { createdAt: "asc" },
  });
  candidates.sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9));
  const historyReviewerLogin = await reviewerFromGitHistory({
    orgRepo: opts.orgRepo,
    token: opts.token,
    prNumber: opts.prNumber,
    base: opts.base,
    candidates,
  }).catch((err) => {
    logger.warn("failed to select PR reviewer from git history", { taskId: opts.task.id, prUrl: opts.prUrl, err: err instanceof Error ? err.message : String(err) });
    return null;
  });
  const reviewerLogin = historyReviewerLogin ?? candidates[0]?.user.githubLogin;
  if (!reviewerLogin) {
    logger.info("no engineer reviewer available for non-engineer PR", { taskId: opts.task.id });
    return { reviewerLogin: null };
  }

  const requester = creator.name || "a non-engineer teammate";
  const comment = `@${reviewerLogin} this PR was created for ${requester}, who is marked as a non-engineer in Manta. Please review when you have a chance.`;

  try {
    await requestPrReviewers({ orgRepo: opts.orgRepo, token: opts.token, prNumber: opts.prNumber, reviewers: [reviewerLogin] });
  } catch (err) {
    logger.warn("failed to request engineer PR review", { taskId: opts.task.id, prUrl: opts.prUrl, reviewerLogin, err: err instanceof Error ? err.message : String(err) });
  }
  try {
    await commentOnPr({ orgRepo: opts.orgRepo, token: opts.token, prNumber: opts.prNumber, body: comment });
  } catch (err) {
    logger.warn("failed to comment engineer PR review request", { taskId: opts.task.id, prUrl: opts.prUrl, reviewerLogin, err: err instanceof Error ? err.message : String(err) });
  }
  return { reviewerLogin };
}
