import { prisma } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";
import type { Message, MessageRole } from "../generated/client/index.js";

export interface AppendInput {
  channel: string;
  role: MessageRole;
  content: string;
  meta?: unknown;
  images?: unknown;
}

/**
 * Append a message to a channel's ordered, append-only log. `seq` is monotonic
 * per (workspace, channel): we read the current max and write max+1 inside a
 * transaction. Per-channel writes are single-flight (the brain/worker holds one
 * active turn per channel), so contention here is minimal by construction.
 */
export function append(scope: WorkspaceScope, input: AppendInput): Promise<Message> {
  return prisma.$transaction(async (tx) => {
    const last = await tx.message.findFirst({
      where: { workspaceId: scope.workspaceId, channel: input.channel },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    return tx.message.create({
      data: {
        workspaceId: scope.workspaceId,
        channel: input.channel,
        seq,
        role: input.role,
        content: input.content,
        ...(input.meta !== undefined ? { meta: input.meta as object } : {}),
        ...(input.images !== undefined ? { images: input.images as object } : {}),
      },
    });
  });
}

export interface ListOptions {
  /** Max rows (default 200). Returned oldest→newest. */
  limit?: number;
  /** Only messages with seq < this (for paging back through history). */
  beforeSeq?: number;
}

/** List a channel's messages oldest→newest, scoped to the workspace. */
export async function list(
  scope: WorkspaceScope,
  channel: string,
  opts: ListOptions = {},
): Promise<Message[]> {
  const limit = opts.limit ?? 200;
  // Take the most recent `limit` (optionally before a cursor), then re-sort asc.
  const rows = await prisma.message.findMany({
    where: {
      workspaceId: scope.workspaceId,
      channel,
      ...(opts.beforeSeq !== undefined ? { seq: { lt: opts.beforeSeq } } : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
  });
  return rows.reverse();
}

/** Count messages in a channel (used by the compaction trigger). */
export function count(scope: WorkspaceScope, channel: string): Promise<number> {
  return prisma.message.count({ where: { workspaceId: scope.workspaceId, channel } });
}

/** Remove all persisted messages for a channel. Used when a user starts a fresh chat session. */
export async function clear(scope: WorkspaceScope, channel: string): Promise<void> {
  await prisma.message.deleteMany({ where: { workspaceId: scope.workspaceId, channel } });
}
