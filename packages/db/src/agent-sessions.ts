import { prisma } from "./client.ts";
import type { SessionKind } from "../generated/client/index.js";

/** Get the persisted Pi session blob key for a given (workspace, channel). */
export async function getSessionKey(
  workspaceId: string,
  channel: string,
): Promise<string | null> {
  const row = await prisma.agentSession.findUnique({
    where: { workspaceId_channel: { workspaceId, channel } },
    select: { sessionBlobKey: true },
  });
  return row?.sessionBlobKey ?? null;
}

/** Persist (or update) the Pi session blob key for a (workspace, channel) pair. */
export async function upsertSessionKey(
  workspaceId: string,
  channel: string,
  sessionBlobKey: string,
  kind: SessionKind = "brain",
  backend = "pi",
): Promise<void> {
  await prisma.agentSession.upsert({
    where: { workspaceId_channel: { workspaceId, channel } },
    create: { workspaceId, channel, kind, backend, sessionBlobKey },
    update: { sessionBlobKey },
  });
}
