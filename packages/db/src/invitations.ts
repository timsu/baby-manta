import { randomBytes } from "node:crypto";
import { prisma } from "./client.ts";
import * as workspaces from "./workspaces.ts";
import type { Invitation, Role } from "../generated/client/index.js";

// URL-safe code without ambiguous characters (no 0/O/1/l/I).
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function genCode(len = 20): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export interface CreateInvitationInput {
  workspaceId: string;
  createdBy: string;
  role?: Role;
  /** Days until the code stops working. Omit/null for no expiry. */
  expiresInDays?: number | null;
}

export function create(input: CreateInvitationInput): Promise<Invitation> {
  const expiresAt =
    input.expiresInDays != null
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
  return prisma.invitation.create({
    data: {
      workspaceId: input.workspaceId,
      code: genCode(),
      role: input.role ?? "member",
      createdBy: input.createdBy,
      expiresAt,
    },
  });
}

/** Active (not revoked, not expired) invitations for a workspace, newest first. */
export function listActive(workspaceId: string): Promise<Invitation[]> {
  return prisma.invitation.findMany({
    where: {
      workspaceId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

export function byCode(code: string): Promise<Invitation | null> {
  return prisma.invitation.findUnique({ where: { code } });
}

/** Revoke an invitation, scoped to its workspace (idempotent). */
export async function revoke(workspaceId: string, id: string): Promise<void> {
  await prisma.invitation.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function isUsable(inv: Invitation): boolean {
  if (inv.revokedAt) return false;
  if (inv.expiresAt && inv.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

export interface InvitationPreview {
  code: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  valid: boolean;
}

/** Look up an invite + its workspace name for a join-preview screen. */
export async function preview(code: string): Promise<InvitationPreview | null> {
  const inv = await prisma.invitation.findUnique({
    where: { code },
    include: { workspace: { select: { name: true } } },
  });
  if (!inv) return null;
  return {
    code: inv.code,
    workspaceId: inv.workspaceId,
    workspaceName: inv.workspace.name,
    role: inv.role,
    valid: isUsable(inv),
  };
}

export type AcceptResult =
  | { ok: true; workspaceId: string; alreadyMember: boolean }
  | { ok: false; reason: "not_found" | "expired" | "revoked" };

/** Validate a code and add the user to the workspace at the invite's role. */
export async function accept(code: string, userId: string): Promise<AcceptResult> {
  const inv = await byCode(code);
  if (!inv) return { ok: false, reason: "not_found" };
  if (inv.revokedAt) return { ok: false, reason: "revoked" };
  if (inv.expiresAt && inv.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  const already = await workspaces.isMember(userId, inv.workspaceId);
  // Don't downgrade an existing member's role; only add if they're new.
  if (!already) await workspaces.addMember(inv.workspaceId, userId, inv.role);
  return { ok: true, workspaceId: inv.workspaceId, alreadyMember: already };
}
