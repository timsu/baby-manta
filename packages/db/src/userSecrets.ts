// Encrypted per-user credentials (subscription-based providers like Codex).
// Mirrors workspaceSecrets.ts but scoped to a user — a ChatGPT subscription
// belongs to the person, not the workspace.

import { prisma } from "./client.ts";

export const PI_SECRET_KIND = "pi" as const;
export const GITHUB_OAUTH_SECRET_KIND = "github_oauth" as const;

export interface StoredSecret {
  ciphertext: Uint8Array;
  meta: unknown;
}

export async function get(userId: string, kind: string = PI_SECRET_KIND): Promise<StoredSecret | null> {
  const row = await prisma.userSecret.findUnique({
    where: { userId_kind: { userId, kind } },
    select: { ciphertext: true, meta: true },
  });
  return row ? { ciphertext: row.ciphertext, meta: row.meta } : null;
}

export async function upsert(
  userId: string,
  ciphertext: Uint8Array,
  meta?: unknown,
  kind: string = PI_SECRET_KIND,
): Promise<void> {
  const buf = Buffer.from(ciphertext);
  const now = new Date();
  await prisma.userSecret.upsert({
    where: { userId_kind: { userId, kind } },
    create: { userId, kind, ciphertext: buf, updatedAt: now, ...(meta !== undefined ? { meta: meta as object } : {}) },
    update: { ciphertext: buf, updatedAt: now, ...(meta !== undefined ? { meta: meta as object } : {}) },
  });
}

export async function remove(userId: string, kind: string = PI_SECRET_KIND): Promise<void> {
  await prisma.userSecret.deleteMany({ where: { userId, kind } });
}

/** Return the user IDs of all workspace members who have a stored credential. */
export async function listUsersWithSecret(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await prisma.userSecret.findMany({
    where: { userId: { in: userIds }, kind: PI_SECRET_KIND },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
