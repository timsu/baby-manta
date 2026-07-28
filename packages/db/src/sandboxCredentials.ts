// Sandbox credentials — short-lived, single-task tokens for cloud (Daytona)
// worker venues. The server mints one when it provisions a sandbox, injects the
// plaintext into the sandbox env, and the in-sandbox daemon presents it on
// /worker-ws (register) and /api/worker (Bearer) — exactly like a per-user
// WorkerCredential, except this token is scoped to a single (task, workspace)
// and expires. We persist only the SHA-256 hash, so a DB leak exposes nothing.
//
// NOTE: unlike workspace-owned rows, a sandbox credential carries its own
// workspaceId and is verified by token, so callers don't pass a scope in.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./client.ts";

/** Distinguishable prefix so a leaked sandbox token is easy to recognize/grep. */
const TOKEN_PREFIX = "msb_";
/** Default lifetime. Refreshed implicitly by re-minting on resume; long enough
 * to outlast a single coding turn but short enough to limit a leaked token. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a single-task token. Returns the plaintext exactly once. */
export async function mint(
  taskId: string,
  workspaceId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ id: string; token: string }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = await prisma.sandboxCredential.create({
    data: {
      taskId,
      workspaceId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return { id: row.id, token };
}

/** Resolve a sandbox token to its (taskId, workspaceId), or null if unknown,
 * expired, or revoked. Best-effort touches lastUsedAt for visibility. */
export async function verify(
  token: string | undefined,
): Promise<{ taskId: string; workspaceId: string; credentialId: string } | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = await prisma.sandboxCredential.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  void prisma.sandboxCredential
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { taskId: row.taskId, workspaceId: row.workspaceId, credentialId: row.id };
}

/** Revoke every (live) credential for a task — called on venue spindown / task
 * completion so a stopped sandbox's token can't be replayed. */
export async function revokeForTask(taskId: string): Promise<void> {
  await prisma.sandboxCredential.updateMany({
    where: { taskId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
