/** Parse a GitHub pull request URL into the repo slug and PR number. */
export function parseGitHubPrUrl(url: string): { orgRepo: string; prNumber: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") return null;

  const prNumber = Number(parts[3]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;

  return { orgRepo: `${parts[0]}/${parts[1]}`, prNumber };
}

