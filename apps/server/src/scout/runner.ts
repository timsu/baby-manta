// Scout: a cheap, bounded LLM pass that runs every ~30 minutes, looks at the
// workspace's open cards, moves genuinely-stalled cards to needs_help, sends one
// brief to the brain's inbox, and STOPS.
//
// Design constraints (these exist because an earlier version ran away — 358 turns
// and ~$45 per run by resuming an ever-growing session on the flagship model):
//   - Stateless: every run is a FRESH session. No resumeFrom, so context can't
//     accumulate and re-bill as cacheRead across runs.
//   - Bounded: a hard tool-call cap aborts a runaway, and calling brief_brain is
//     the terminal action — the run ends the moment the brief is sent.
//   - Cheap: runs on a small model (see pickScoutBackendId), not the brain model.
// The only mutation Scout may make is flag_needs_help (stalled bot_working →
// needs_help); everything else is read-only.

import { defineTool } from "@manta/agent";
import type { AgentBackend } from "@manta/agent";
import { prisma, inbox, tasks, type WorkspaceScope } from "@manta/db";
import { runBrainTurn } from "../brain/runner.ts";
import { getLinearToken, listLinearTeams, listLinearIssues, getLinearIssue } from "../linear/client.ts";
import { tokenForWorkspaceRepo } from "../github/tokens.ts";
import { fetchPrCommentSignal } from "../github/prComments.ts";
import { spawnWorker } from "../worker/dispatch.ts";
import { noteOnCard } from "../notices.ts";
import { availableWorkerCount } from "../worker/registry.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Scout");

/** A bot_working card untouched for this long with no live worker is "stalled". */
const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Hard ceiling on tool calls per run — a fail-safe against a runaway loop. The
 * happy path is ~3–6 calls (read tasks, maybe flag a stall, brief). */
const MAX_TOOL_CALLS = 12;

const SCOUT_PROMPT = `You are Manta Scout, a fast, low-cost triage pass that runs every 30 minutes.
You are NOT a chat agent. Do the minimum work, then STOP by calling brief_brain.

Tools:
  - get_active_tasks: list this workspace's open cards (with how long since each was updated)
  - flag_needs_help: move a STALLED bot_working card to needs_help (alerts a human)
  - check_pr_responses: ask connected workers to look at new reviewer / cubic-dev-ai comments on their open PRs
  - list_linear_teams / list_linear_issues / get_linear_issue: read Linear (only if useful)
  - list_github_prs: list open PRs for a repo (org/repo)
  - brief_brain: send ONE short brief to the brain, then the run ends

Process (keep it tight — aim for under 6 tool calls total):
1. Call get_active_tasks.
2. A card is STALLED if cardStatus is "bot_working", it has no active worker, and it
   hasn't been updated in over 30 minutes. For each stalled card, call flag_needs_help.
3. Call check_pr_responses ONCE. It deterministically finds open, non-approved PRs whose
   owner has a connected worker and that have new reviewer or cubic-dev-ai comments after the latest
   commit, and asks each worker to read them and decide what to do. It's a safe no-op if
   there's nothing new — do NOT read or judge PR comments yourself.
4. Optionally glance at Linear / PRs only if something looks off.
5. Call brief_brain ONCE with a ≤150-word summary (what you flagged, any workers you
   nudged, anything the brain should know). Even an "all clear" is fine. Do NOT keep
   investigating after this.
Calling brief_brain is your LAST action. Never call it more than once.`;

export interface ScoutDeps {
  workspaceId: string;
  backend: AgentBackend;
  /** Backend id for Scout's small model (see pickScoutBackendId). */
  backendId: string;
}

/** We stash the timestamp of the newest comment we've already asked a worker
 * about in the otherwise-unused `reviewComments` Json column, so a PR with
 * unaddressed comments isn't re-dispatched every 30 minutes. */
function lastFollowupAt(reviewComments: unknown): string | null {
  if (reviewComments && typeof reviewComments === "object" && !Array.isArray(reviewComments)) {
    const v = (reviewComments as Record<string, unknown>)["followupAt"];
    if (typeof v === "string") return v;
  }
  return null;
}

/** Latest of two ISO timestamps (lexicographic compare is correct for UTC ISO). */
function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function prCommentMessage(prNumber: number, count: number, from: string[]): string {
  return [
    `Reviewers left ${count} new comment${count === 1 ? "" : "s"} on PR #${prNumber} after your latest commit (from ${from.join(", ")}).`,
    "Read the new PR review comments and conversation (use `gh`), then decide for each one whether to:",
    "  • make a code change to address it,",
    "  • reply to the reviewer (e.g. to explain or push back), or",
    "  • leave it as-is if no action is needed.",
    "You don't have to act on every comment. Commit and push any changes you do make.",
  ].join("\n");
}

function buildScoutTools(scope: WorkspaceScope, onBriefed: () => void) {
  const getActiveTasks = defineTool({
    name: "get_active_tasks",
    description: "List all non-archived, non-done open cards in this workspace, with staleness info.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const rows = await prisma.task.findMany({
        where: { workspaceId: scope.workspaceId, archivedAt: null, cardStatus: { notIn: ["done", "backlog"] } },
        select: {
          id: true, title: true, cardStatus: true, workerStatus: true, workerActive: true,
          prNumber: true, prState: true, checksStatus: true, reviewDecision: true,
          repo: true, updatedAt: true, createdBy: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
      });
      const now = Date.now();
      return {
        tasks: rows.map(({ createdBy, ...t }) => {
          const idleMs = now - t.updatedAt.getTime();
          return {
            ...t,
            minutesSinceUpdate: Math.round(idleMs / 60000),
            stalled: t.cardStatus === "bot_working" && !t.workerActive && idleMs > STALL_THRESHOLD_MS,
            workerAvailable: availableWorkerCount(createdBy) > 0,
          };
        }),
      };
    },
  });

  const flagNeedsHelp = defineTool<{ taskId: string; reason?: string }>({
    name: "flag_needs_help",
    description:
      "Move a STALLED bot_working card to needs_help so a human is alerted. Only use it for cards that are genuinely stuck (bot_working, no active worker, idle > 30 min).",
    parameters: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        reason: { type: "string", description: "Short reason shown in the card history." },
      },
    },
    handler: async (args) => {
      try {
        const reason = args.reason ?? "stalled with no active worker";
        await tasks.transition(scope, args.taskId, "needs_help", "poller", { reason });
        await prisma.task.updateMany({
          where: { id: args.taskId, workspaceId: scope.workspaceId },
          data: { workerStatus: "stalled" },
        });
        // Leave a durable note in the transcript so the stall reason is visible
        // on the card, not just in the audit trail.
        await noteOnCard(scope, args.taskId, `🚨 Scout flagged this card for help: ${reason}`);
        logger.info("scout flagged needs_help", { workspaceId: scope.workspaceId, taskId: args.taskId });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const listTeamsTool = defineTool({
    name: "list_linear_teams",
    description: "List available Linear teams (requires LINEAR_API_KEY).",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!getLinearToken()) return { error: "LINEAR_API_KEY not set" };
      return { teams: await listLinearTeams() };
    },
  });

  const listIssues = defineTool<{ teamId: string; limit?: number }>({
    name: "list_linear_issues",
    description: "List active Linear issues for a team (unstarted + in-progress).",
    parameters: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        limit: { type: "number", description: "Max issues to return (default 25). Ask for what you need — the server pages Linear internally; values above 500 are clamped to 500, not rejected." },
      },
    },
    handler: async (args) => {
      if (!getLinearToken()) return { error: "LINEAR_API_KEY not set" };
      return { issues: await listLinearIssues(args.teamId, { limit: args.limit }) };
    },
  });

  const getIssueTool = defineTool<{ issueId: string }>({
    name: "get_linear_issue",
    description: "Fetch a single Linear issue by UUID or identifier (e.g. ENG-42).",
    parameters: {
      type: "object",
      required: ["issueId"],
      properties: { issueId: { type: "string" } },
    },
    handler: async (args) => {
      if (!getLinearToken()) return { error: "LINEAR_API_KEY not set" };
      const issue = await getLinearIssue(args.issueId);
      if (!issue) return { found: false };
      return { found: true, ...issue };
    },
  });

  const listPrs = defineTool<{ repo: string }>({
    name: "list_github_prs",
    description: "List open pull requests for a GitHub repo (org/repo).",
    parameters: {
      type: "object",
      required: ["repo"],
      properties: { repo: { type: "string", description: "org/repo format" } },
    },
    handler: async (args) => {
      const [owner, repo] = args.repo.split("/");
      if (!owner || !repo) return { error: "invalid repo format" };
      const token = await tokenForWorkspaceRepo(scope.workspaceId, args.repo);
      if (!token) return { error: "GitHub not connected for this workspace" };
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return { error: `GitHub API ${res.status}` };
      const prs = (await res.json()) as { number: number; title: string; html_url: string; draft: boolean; updated_at: string }[];
      return { prs: prs.map((p) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft, updatedAt: p.updated_at })) };
    },
  });

  const checkPrResponses = defineTool({
    name: "check_pr_responses",
    description:
      "Ask connected workers to look at new review feedback on their open PRs. Deterministically finds tasks whose PR is open and NOT approved, whose owner has a connected worker, and which has new comments from a human reviewer or cubic-dev-ai posted AFTER the latest commit — and asks each such worker to read the comments and decide whether to address, reply, or ignore them. Safe to call once per run; a no-op when there's nothing new (you do NOT judge the comments yourself).",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      // Candidates: tasks with an open PR whose worker isn't currently running.
      // Approval and comment-freshness are checked below, before any GitHub call,
      // so approved/up-to-date PRs never cost a request.
      const candidates = await prisma.task.findMany({
        where: {
          workspaceId: scope.workspaceId,
          archivedAt: null,
          prNumber: { not: null },
          prState: { not: "closed" },
          workerActive: false,
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });

      // Cache connected daemon counts per owner. BYO daemons are multi-task, so
      // dispatching one PR follow-up does not consume the owner's availability.
      const workersByOwner = new Map<string, number>();
      const workerCountFor = (owner: string): number => {
        if (!workersByOwner.has(owner)) workersByOwner.set(owner, availableWorkerCount(owner));
        return workersByOwner.get(owner)!;
      };

      const results: Array<Record<string, unknown>> = [];
      for (const task of candidates) {
        if (!task.prNumber) continue;
        // Approved PRs need no follow-up. (Checked here, not in the query, because
        // `not: "APPROVED"` has ambiguous NULL semantics — a PR with no review yet
        // has reviewDecision = null and IS a follow-up candidate.)
        if (task.reviewDecision === "APPROVED") continue;
        if (!task.createdBy) {
          results.push({ taskId: task.id, dispatched: false, reason: "no task owner" });
          continue;
        }
        if (workerCountFor(task.createdBy) < 1) {
          results.push({ taskId: task.id, dispatched: false, reason: "no connected worker for owner" });
          continue;
        }
        const token = await tokenForWorkspaceRepo(task.workspaceId, task.repo);
        if (!token) {
          results.push({ taskId: task.id, dispatched: false, reason: "github not connected" });
          continue;
        }
        const signal = await fetchPrCommentSignal(task.repo, task.prNumber, token);
        if (!signal) {
          results.push({ taskId: task.id, dispatched: false, reason: "could not read PR" });
          continue;
        }
        // Only comments newer than BOTH the latest commit and whatever we last
        // asked about — so addressed/already-nudged comments don't re-trigger.
        const floor = latestIso(signal.latestCommitAt, lastFollowupAt(task.reviewComments));
        const fresh = signal.qualifying.filter((c) => !floor || c.createdAt > floor);
        if (fresh.length === 0) {
          results.push({ taskId: task.id, dispatched: false, reason: "no new comments since last commit" });
          continue;
        }
        const from = [...new Set(fresh.map((c) => c.login))];
        const newest = fresh.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), fresh[0]!.createdAt);
        spawnWorker(task, prCommentMessage(task.prNumber, fresh.length, from));
        await prisma.task.update({ where: { id: task.id }, data: { reviewComments: { followupAt: newest } } });
        logger.info("scout asked worker to check PR comments", {
          workspaceId: scope.workspaceId, taskId: task.id, prNumber: task.prNumber, newComments: fresh.length, from,
        });
        results.push({ taskId: task.id, dispatched: true, prNumber: task.prNumber, newComments: fresh.length, from });
      }
      return { checked: candidates.length, dispatched: results.filter((r) => r.dispatched).length, results };
    },
  });

  const briefBrain = defineTool<{ brief: string }>({
    name: "brief_brain",
    description: "Send an actionable brief to the brain's inbox. This is your LAST action — call it exactly once; the run ends immediately after.",
    parameters: {
      type: "object",
      required: ["brief"],
      properties: { brief: { type: "string" } },
    },
    handler: async (args) => {
      await inbox.push(scope.workspaceId, { channel: "brain", body: `[Scout brief]\n${args.brief}`, source: "poller" });
      // Terminal action: the brief is persisted, so end the turn now instead of
      // letting the model spend more (expensive) turns idling on a huge context.
      onBriefed();
      return { ok: true, done: true };
    },
  });

  return [getActiveTasks, flagNeedsHelp, checkPrResponses, listTeamsTool, listIssues, getIssueTool, listPrs, briefBrain];
}

/**
 * Run one Scout turn for a workspace. Always a FRESH session (no resume) and
 * hard-bounded: it stops the moment brief_brain is called, or after MAX_TOOL_CALLS
 * as a fail-safe.
 */
export async function runScoutTurn(deps: ScoutDeps): Promise<void> {
  const scope: WorkspaceScope = { workspaceId: deps.workspaceId };

  // One controller drives both stop conditions: the brief_brain terminal action
  // and the runaway tool-call cap. Aborting ends the Pi session gracefully.
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  let toolCalls = 0;
  const tools = buildScoutTools(scope, stop);

  await runBrainTurn({
    scope,
    channel: "scout",
    userMessage: "Run your analysis now.",
    backend: deps.backend,
    backendId: deps.backendId,
    tools,
    promptParts: { basePrompt: SCOUT_PROMPT },
    // NO resumeFrom: Scout is a stateless 30-minute snapshot. Carrying history
    // forever is what made each run re-bill an ever-growing context as cacheRead.
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "tool_use") {
        toolCalls += 1;
        if (toolCalls >= MAX_TOOL_CALLS) {
          logger.warn("scout hit tool-call cap — aborting", { workspaceId: deps.workspaceId, toolCalls });
          stop();
        }
      }
    },
  });
}
