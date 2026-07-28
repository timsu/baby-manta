import { prisma } from "./client.ts";
import type { InboxSource } from "../generated/client/index.js";

export interface NewInboxItem {
  channel: string;
  body: string;
  source: InboxSource;
}

/** Append an item to the brain's inbox (consumed on the next brain turn). */
export async function push(workspaceId: string, item: NewInboxItem): Promise<{ id: string }> {
  const created = await prisma.inboxItem.create({
    data: { workspaceId, channel: item.channel, body: item.body, source: item.source },
    select: { id: true },
  });
  return created;
}

/** Fetch unconsumed inbox items for a (workspace, channel), oldest first. */
export async function pending(
  workspaceId: string,
  channel: string,
): Promise<Array<{ id: string; body: string; source: InboxSource; createdAt: Date }>> {
  return prisma.inboxItem.findMany({
    where: { workspaceId, channel, consumedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

/** Mark inbox items consumed. Scoped to a workspace so a stray id from another
 * tenant can't be marked consumed here. */
export async function markConsumed(workspaceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.inboxItem.updateMany({
    where: { workspaceId, id: { in: ids } },
    data: { consumedAt: new Date() },
  });
}
