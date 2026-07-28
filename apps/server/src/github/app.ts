// GitHub App token minting. When GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are
// set, mints repo-scoped installation tokens so workers can push + open PRs
// without needing the user's personal GitHub credentials.
//
// Token lifetime: 1 hour (GitHub's max). Callers should treat them as one-use.

import { createSign } from "node:crypto";

const APP_ID = process.env["GITHUB_APP_ID"];
const PRIVATE_KEY = process.env["GITHUB_APP_PRIVATE_KEY"]?.replace(/\\n/g, "\n");

export function isConfigured(): boolean {
  return Boolean(APP_ID && PRIVATE_KEY);
}

/** Build a signed GitHub App JWT (valid for 60 s). */
function buildJwt(): string {
  if (!APP_ID || !PRIVATE_KEY) throw new Error("GitHub App credentials not configured");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 60, iss: APP_ID })).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(PRIVATE_KEY, "base64url");
  return `${header}.${payload}.${sig}`;
}

async function gh<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const jwt = buildJwt();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Get the installation ID for a repo (owner/repo). Throws if app isn't installed. */
async function getInstallationId(orgRepo: string): Promise<number> {
  const [owner, repo] = orgRepo.split("/");
  const data = await gh<{ id: number }>(`/repos/${owner}/${repo}/installation`);
  return data.id;
}

/**
 * Mint an installation access token, optionally scoped to specific repos.
 * Pass `repos` (bare names, not org/repo) to restrict; omit for all repos the
 * installation can reach (needed to enumerate repositories).
 */
export async function mintTokenForInstallation(
  installationId: number | string,
  repos?: string[],
): Promise<string> {
  const data = await gh<{ token: string }>(
    `/app/installations/${installationId}/access_tokens`,
    "POST",
    {
      ...(repos && repos.length ? { repositories: repos } : {}),
      // checks:read lets the poller read GitHub Actions check-runs (not just the
      // legacy commit-status API). contents/pull_requests cover worker push + PRs.
      permissions: { contents: "write", pull_requests: "write", checks: "read" },
    },
  );
  return data.token;
}

/** Mint a repo-scoped installation access token by resolving the repo's install. */
export async function mintInstallationToken(orgRepo: string): Promise<string> {
  const installationId = await getInstallationId(orgRepo);
  const [, repo] = orgRepo.split("/");
  return mintTokenForInstallation(installationId, repo ? [repo] : undefined);
}

/** The account (org/user) a given installation belongs to — for display. */
export async function getInstallation(
  installationId: number | string,
): Promise<{ account: { login: string; type: string; avatar_url: string } }> {
  return gh(`/app/installations/${installationId}`);
}

/**
 * List the repositories an installation can access, as `{ orgRepo, defaultBranch }`.
 * Uses an installation token (the App JWT can't read `/installation/repositories`).
 * Paginates until exhausted.
 */
export async function listInstallationRepos(
  installationId: number | string,
): Promise<Array<{ orgRepo: string; defaultBranch: string; private: boolean }>> {
  const token = await mintTokenForInstallation(installationId);
  const out: Array<{ orgRepo: string; defaultBranch: string; private: boolean }> = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub list repos → ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      repositories: Array<{ full_name: string; default_branch: string; private: boolean }>;
    };
    for (const r of data.repositories) {
      out.push({ orgRepo: r.full_name, defaultBranch: r.default_branch, private: r.private });
    }
    if (data.repositories.length < 100) break;
  }
  return out;
}

/** Create a PR via the GitHub API (using a user PAT or installation token). */
export async function createPr(opts: {
  orgRepo: string;
  token: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<{ number: number; html_url: string; title: string; state: string }> {
  const [owner, repo] = opts.orgRepo.split("/");
  return fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`GitHub create PR → ${r.status}: ${await r.text()}`);
    return r.json() as Promise<{ number: number; html_url: string; title: string; state: string }>;
  });
}

/** Request GitHub review from user logins for a PR. */
export async function requestPrReviewers(opts: {
  orgRepo: string;
  token: string;
  prNumber: number;
  reviewers: string[];
}): Promise<void> {
  const [owner, repo] = opts.orgRepo.split("/");
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${opts.prNumber}/requested_reviewers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reviewers: opts.reviewers }),
  });
  if (!r.ok) throw new Error(`GitHub request PR review → ${r.status}: ${await r.text()}`);
}

/** Add an issue comment to a pull request. */
export async function commentOnPr(opts: {
  orgRepo: string;
  token: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  const [owner, repo] = opts.orgRepo.split("/");
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${opts.prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: opts.body }),
  });
  if (!r.ok) throw new Error(`GitHub PR comment → ${r.status}: ${await r.text()}`);
}
