// Worker credentials — long-lived tokens that bind a worker daemon to a user.
// Minted by the one-time browser pairing flow; the daemon stores the plaintext
// and presents it on every connect. We persist only the SHA-256 hash, so a DB
// leak doesn't expose usable tokens.
//
// NOTE: a worker credential is owned by a *user*, not a workspace, so this
// module is intentionally not workspace-scoped (cf. the index.ts invariant).

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./client.ts";

/** Distinguishable prefix so a leaked token is easy to recognize/grep. */
const TOKEN_PREFIX = "mwk_";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a credential for a user. Returns the plaintext token exactly once. */
export async function mint(userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = await prisma.workerCredential.create({
    data: { userId, name, tokenHash: hashToken(token) },
  });
  return { id: row.id, token };
}

/** Resolve a worker token to its owning user, or null if unknown. Best-effort
 * touches lastUsedAt for visibility. */
export async function verify(token: string | undefined): Promise<{ userId: string; credentialId: string } | null> {
  if (!token) return null;
  const row = await prisma.workerCredential.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return null;
  void prisma.workerCredential
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { userId: row.userId, credentialId: row.id };
}

/** Whether this user has ever presented a worker credential to the server. */
export async function hasEverConnected(userId: string): Promise<boolean> {
  const count = await prisma.workerCredential.count({
    where: { userId, lastUsedAt: { not: null } },
  });
  return count > 0;
}
