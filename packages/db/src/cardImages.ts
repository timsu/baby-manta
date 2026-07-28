import { prisma } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";
import { createHash } from "node:crypto";

export async function create(
  scope: WorkspaceScope,
  image: { mimeType: string; data: string },
): Promise<{ id: string }> {
  return prisma.cardImage.create({
    data: { workspaceId: scope.workspaceId, mimeType: image.mimeType, data: image.data },
    select: { id: true },
  });
}

export async function createOrReuse(
  scope: WorkspaceScope,
  image: { mimeType: string; data: string },
): Promise<{ id: string }> {
  const sha256 = createHash("sha256").update(image.data).digest("hex");
  return prisma.cardImage.upsert({
    where: { workspaceId_sha256: { workspaceId: scope.workspaceId, sha256 } },
    create: { workspaceId: scope.workspaceId, mimeType: image.mimeType, data: image.data, sha256 },
    update: {},
    select: { id: true },
  });
}

export async function get(id: string): Promise<{ mimeType: string; data: string } | null> {
  return prisma.cardImage.findUnique({
    where: { id },
    select: { mimeType: true, data: true },
  });
}
