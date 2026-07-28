// Pure helpers for recognizing whether a git remote URL points at the expected
// GitHub org/repo. Kept separate from daemon.ts so the edge cases are unit-tested
// without starting the daemon process.

/** Extract "owner/repo" from common GitHub remote URL shapes. */
export function repoSlugFromGitRemote(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  const stripSuffix = (value: string): string => value.replace(/\.git$/i, "").toLowerCase();

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return stripSuffix(`${parts[0]}/${parts[1]}`);
  } catch {
    // Not a URL; fall through to scp-like git@github.com:owner/repo.git.
  }

  const scp = raw.match(/^(?:[^@\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!scp) return null;
  return stripSuffix(`${scp[1]}/${scp[2]}`);
}

export function gitRemoteMatchesRepo(remoteUrl: string, expectedRepo: string): boolean {
  const actual = repoSlugFromGitRemote(remoteUrl);
  return actual === expectedRepo.trim().replace(/\.git$/i, "").toLowerCase();
}

/** True when a git error means the local object store is rotten (not a transient
 * network/auth blip). A blobless (--filter=blob:none) bare cache can be left with
 * refs pointing at objects the store no longer has after an interrupted gc/prune;
 * from then on every `git fetch --prune` dies with "object <sha> not found". These
 * signatures are corruption, not connectivity — a re-clone fixes them, a retry
 * never will. */
export function isCorruptRepoError(message: string): boolean {
  return /object [0-9a-f]{7,40} not found|did not send all necessary objects|bad (object|tree|commit)|missing (blob|tree|commit)|invalid sha1 pointer|loose object .* is corrupt|object file .* is empty|unable to read (tree|sha1|object)/i.test(
    message,
  );
}
