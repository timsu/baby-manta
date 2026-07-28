// Pure helpers for binding a task to its own git worktree/branch, kept separate
// from daemon.ts (which runs on import) so they can be unit-tested. The daemon
// owns all filesystem/git I/O; these functions only decide names and parse them.

import { join } from "node:path";

/**
 * Recover candidate task ids from a worktree dir name shaped `${name}-${taskId}`.
 * Used only as a back-compat fallback for dirs created before ownership stamping;
 * the ownership index is authoritative for everything provisioned afterwards.
 * Ids are `(c|rev)-<hex>` (newTaskId in @manta/db) but older/test ids may be bare
 * hex, so we return the most-specific candidate first.
 */
export function taskIdCandidatesFromWorktreeName(name: string): string[] {
  const ids = new Set<string>();
  // Anchor to a trailing prefixed-hex id first. This avoids the greedy-`-c-`
  // trap where a name slug ending in `-c` made a looser pattern capture the
  // wrong span instead of the real `c-6e7fc8`.
  const id = name.match(/-((?:c|rev)-[0-9a-f]{6,})$/i)?.[1];
  if (id) ids.add(id);
  const short = name.match(/-([0-9a-f]{6,})$/i)?.[1];
  if (short) ids.add(short);
  const prefixed = name.match(/-((?:c|rev)-[A-Za-z0-9][A-Za-z0-9_-]*)$/)?.[1];
  if (prefixed) ids.add(prefixed);
  return [...ids];
}

/**
 * Filesystem-safe slug for a worktree directory. Card titles are free text and
 * routinely contain spaces, colons, and slashes ("Spot check: Sentry New
 * Issues"). Left raw, `${name}-${taskId}` yields a worktree path with those
 * characters, which breaks any tool that embeds the absolute path unquoted in a
 * shell command — most painfully node-gyp: its generated Makefile bakes the
 * build dir's path into recipes, so on a space-containing path `make` splits the
 * path and tries to run a segment as a command (`/bin/sh: 1: check:: not found`
 * for `.../Spot check: …/build`), aborting any from-source native build (e.g.
 * better-sqlite3, pulled in transitively by Prisma). Mirrors safeBranchSegment's
 * charset so a task's dir and branch stay aligned. Never empty.
 */
export function worktreeDirSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

export interface ProvisionTarget {
  /** Absolute worktree path to provision/reuse. */
  worktree: string;
  /** Branch the worktree should be on. */
  branch: string;
  /** True when an existing dir is this task's own and should be reused as-is. */
  reuse: boolean;
}

/**
 * Decide the worktree path + branch for a task, never adopting a directory owned
 * by a different task. Pure — the caller supplies whether the canonical dir
 * exists, its recorded owner (if any), and a suffix generator.
 *
 *  - dir absent              -> provision the canonical `${name}-${taskId}` path.
 *  - dir present, ours/unowned -> reuse it (unowned = a pre-stamping dir, which by
 *    construction sat on our own name+id path).
 *  - dir present, foreign    -> a path/id collision: divert to a fresh, unique
 *    path AND branch so the two cards never share a checkout.
 */
export function resolveProvisionTarget(args: {
  root: string;
  name: string;
  taskId: string;
  baseBranch: string;
  dirExists: boolean;
  owner: string | undefined;
  makeSuffix: () => string;
}): ProvisionTarget {
  const { root, name, taskId, baseBranch, dirExists, owner, makeSuffix } = args;
  const slug = worktreeDirSlug(name);
  const worktree = join(root, `${slug}-${taskId}`);
  if (!dirExists) return { worktree, branch: baseBranch, reuse: false };
  if (owner === undefined || owner === taskId) return { worktree, branch: baseBranch, reuse: true };
  const suffix = makeSuffix();
  return {
    worktree: join(root, `${slug}-${taskId}-${suffix}`),
    branch: `${baseBranch}-${suffix}`,
    reuse: false,
  };
}
