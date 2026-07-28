// Terminal authorization. The PTY itself no longer lives on the server — it runs
// on the worker daemon that holds the task's worktree (see
// `@manta/shared/terminal` + the daemon). This module only does the server-side
// auth + task lookup for a terminal connection; `ws.ts` relays frames to the
// worker (or hands the browser a direct loopback endpoint).

import { tasks, workspaces } from "@manta/db";
import type { Sessions } from "./auth/session.ts";

/** Auth + task lookup for the terminal upgrade. Returns { cwd, taskId } or null.
 * `cwd` is the worktree path as recorded in the DB (on the worker's filesystem);
 * the worker treats it as advisory and uses its own local copy. */
export async function authorizeTerminal(
  token: string | undefined,
  workspaceId: string | undefined,
  taskId: string | undefined,
  sessions: Sessions,
): Promise<{ cwd: string; taskId: string } | null> {
  if (!token || !workspaceId || !taskId) return null;
  const claims = await sessions.verify(token);
  if (!claims?.sub) return null;
  if (!(await workspaces.isMember(claims.sub, workspaceId))) return null;
  const task = await tasks.get({ workspaceId }, taskId);
  if (!task) return null;
  return { cwd: task.worktreePath ?? process.env["HOME"] ?? "/tmp", taskId };
}
