// Fetch the "are there new review responses?" signal for a PR: the latest commit
// timestamp plus any review/issue comments left by a human reviewer or the
// cubic-dev-ai review bot. Scout uses this to decide whether to ask an idle
// worker to look at reviewer feedback. We deliberately ignore other bots (CI,
// dependabot, our own app's replies) — only humans and cubic-dev-ai count.

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

interface GhComment {
  user?: { login?: string; type?: string } | null;
  created_at?: string;
  body?: string;
}

export interface QualifyingComment {
  login: string;
  createdAt: string;
  body: string;
  kind: "review" | "issue";
}

export interface PrCommentSignal {
  /** Committer date of the PR's head commit, or null if it couldn't be read. */
  latestCommitAt: string | null;
  /** Comments from a human reviewer or cubic-dev-ai (other bots excluded). */
  qualifying: QualifyingComment[];
}

/** The cubic-dev-ai review bot's GitHub login (with and without the App `[bot]`
 * suffix). Matched exactly so we don't accidentally count unrelated bots whose
 * login merely contains "cubic". */
const CUBIC_LOGINS = new Set(["cubic-dev-ai", "cubic-dev-ai[bot]"]);

/** A comment counts if it's from a human (GitHub user `type: "User"`) or from
 * the cubic-dev-ai review bot. All other bots (CI, dependabot, our own app's
 * replies) are ignored. */
export function isQualifying(c: GhComment): boolean {
  const login = c.user?.login?.toLowerCase() ?? "";
  const type = c.user?.type ?? "";
  return type === "User" || CUBIC_LOGINS.has(login);
}

/** Fetch a comments endpoint, following pagination — a very active PR can carry
 * more than one page even within the `since` window, and a missed page would
 * silently drop qualifying comments (a false-negative skip). `url` already
 * carries its query string, so we append `&page=N`. */
async function fetchAllComments(url: string, headers: Record<string, string>): Promise<GhComment[]> {
  const all: GhComment[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${url}&page=${page}`, { headers });
    if (!res.ok) break;
    const batch = (await res.json()) as GhComment[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export async function fetchPrCommentSignal(
  orgRepo: string,
  prNumber: number,
  token: string,
): Promise<PrCommentSignal | null> {
  const [owner, repo] = orgRepo.split("/");
  if (!owner || !repo) return null;
  const headers = GH_HEADERS(token);
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const prRes = await fetch(`${base}/pulls/${prNumber}`, { headers });
  if (!prRes.ok) return null;
  const pr = (await prRes.json()) as { head?: { sha?: string } };

  let latestCommitAt: string | null = null;
  if (pr.head?.sha) {
    const cRes = await fetch(`${base}/commits/${pr.head.sha}`, { headers });
    if (cRes.ok) {
      const c = (await cRes.json()) as { commit?: { committer?: { date?: string }; author?: { date?: string } } };
      latestCommitAt = c.commit?.committer?.date ?? c.commit?.author?.date ?? null;
    }
  }

  // `since` filters server-side by updated_at; we re-filter by created_at in the
  // caller for precision. When the commit time is unknown, fetch recent comments
  // and let the caller's dedup floor decide.
  const sinceParam = latestCommitAt ? `&since=${encodeURIComponent(latestCommitAt)}` : "";
  const [review, issue] = await Promise.all([
    fetchAllComments(`${base}/pulls/${prNumber}/comments?per_page=100${sinceParam}`, headers),
    fetchAllComments(`${base}/issues/${prNumber}/comments?per_page=100${sinceParam}`, headers),
  ]);

  const toQualifying = (arr: GhComment[], kind: "review" | "issue"): QualifyingComment[] =>
    arr
      .filter(isQualifying)
      .filter((c) => c.created_at)
      .map((c) => ({ login: c.user?.login ?? "unknown", createdAt: c.created_at!, body: (c.body ?? "").slice(0, 500), kind }));

  return {
    latestCommitAt,
    qualifying: [...toQualifying(review, "review"), ...toQualifying(issue, "issue")],
  };
}
