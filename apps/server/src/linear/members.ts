// Auto-associate Manta users with Linear workspace members by email.
//
// Mirrors the Slack email auto-link (slack/index.ts resolveMember): when a
// workspace connects Linear, we list its members and link any whose email
// matches a Manta user. Best-effort — a unique-collision on linearUserId (two
// Manta users sharing one Linear account, or a re-link) must not throw.

import { users } from "@manta/db";
import { listLinearMembers, linearTokenForWorkspace } from "./client.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Linear");

/** Link Manta users to Linear members by email for a connected workspace.
 * Returns the number of users newly linked. */
export async function syncLinearMembers(workspaceId: string): Promise<number> {
  const token = await linearTokenForWorkspace(workspaceId);
  if (!token) return 0;

  let members: { id: string; name: string; email: string }[];
  try {
    members = await listLinearMembers(token);
  } catch (err) {
    logger.warn("listLinearMembers failed during member sync", { workspaceId, err });
    return 0;
  }

  let linked = 0;
  for (const m of members) {
    if (!m.email) continue;
    const user = await users.byEmail(m.email).catch(() => null);
    if (!user || user.linearUserId === m.id) continue;
    try {
      await users.setLinear(user.id, { linearUserId: m.id, linearName: m.name });
      linked++;
    } catch (err) {
      // A unique collision (this Linear account is already linked to another
      // Manta user) is expected — skip it. Anything else (DB outage, etc.) is a
      // real failure we want visible, so log it rather than swallow silently.
      if ((err as { code?: string }).code === "P2002") continue;
      logger.warn("failed to link Manta user to Linear member", { workspaceId, userId: user.id, err });
    }
  }
  if (linked) logger.info("linked Manta users to Linear members", { workspaceId, linked });
  return linked;
}
