// Encrypted per-workspace credentials (provider API keys, Codex OAuth tokens).
// This layer stores opaque ciphertext only — encryption/decryption lives in the
// server (apps/server/src/secrets/crypto.ts), which holds the key. One row per
// (workspaceId, kind); `kind = "pi"` holds the full Pi auth.json blob.

import { prisma } from "./client.ts";
import type { SecretKind } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";

export interface StoredSecret {
  ciphertext: Uint8Array;
  meta: unknown;
}

export async function get(scope: WorkspaceScope, kind: SecretKind): Promise<StoredSecret | null> {
  const row = await prisma.workspaceSecret.findUnique({
    where: { workspaceId_kind: { workspaceId: scope.workspaceId, kind } },
    select: { ciphertext: true, meta: true },
  });
  return row ? { ciphertext: row.ciphertext, meta: row.meta } : null;
}

export async function upsert(
  scope: WorkspaceScope,
  kind: SecretKind,
  ciphertext: Uint8Array,
  meta?: unknown,
): Promise<void> {
  const buf = Buffer.from(ciphertext);
  await prisma.workspaceSecret.upsert({
    where: { workspaceId_kind: { workspaceId: scope.workspaceId, kind } },
    create: {
      workspaceId: scope.workspaceId,
      kind,
      ciphertext: buf,
      ...(meta !== undefined ? { meta: meta as object } : {}),
    },
    update: {
      ciphertext: buf,
      ...(meta !== undefined ? { meta: meta as object } : {}),
    },
  });
}

export async function remove(scope: WorkspaceScope, kind: SecretKind): Promise<void> {
  await prisma.workspaceSecret.deleteMany({ where: { workspaceId: scope.workspaceId, kind } });
}
