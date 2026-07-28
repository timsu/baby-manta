// Per-workspace GitHub token resolution. Every server-side GitHub call (PR
// listing, file trees, poller, scout, cloud-worker push) goes through here
// instead of a shared PAT: we look up the workspace's App installation and mint
// a repo-scoped token, cached just under GitHub's 1-hour lifetime.

import { github as githubDb } from "@manta/db";
import { mintTokenForInstallation, isConfigured } from "./app.ts";

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const TTL_MS = 50 * 60 * 1000; // refresh before GitHub's 60-min expiry

/**
 * A repo-scoped installation token for the given workspace + repo, or null when
 * GitHub isn't configured / the workspace hasn't connected. Cached per
 * (installation, repo). Callers should treat a null as "GitHub not available"
 * and degrade gracefully (empty list, skip), not throw.
 */
export async function tokenForWorkspaceRepo(
  workspaceId: string,
  orgRepo: string,
): Promise<string | null> {
  if (!isConfigured()) return null;
  const installationId = await githubDb.findInstallationForWorkspace(workspaceId);
  if (!installationId) return null;

  const key = `${installationId}:${orgRepo}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const [, repo] = orgRepo.split("/");
  try {
    const token = await mintTokenForInstallation(installationId, repo ? [repo] : undefined);
    cache.set(key, { token, expiresAt: Date.now() + TTL_MS });
    return token;
  } catch {
    return null;
  }
}
