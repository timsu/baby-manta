// Background poller — runs on a setInterval inside the server process.
// Responsibilities (M1 scope):
//   1. Worker assignment backstop: active cards created without a worker claim
//      are claimed and dispatched automatically.
//   2. Stall detection: tasks stuck bot_working with workerActive=false for
//      > STALL_THRESHOLD_MS → push a brain inbox item so the brain is notified.
//   3. PR state refresh: tasks with prNumber set → fetch latest state from
//      GitHub and update prState / checksStatus (needs GITHUB_TOKEN or App).
//
// Multi-instance note: this poller runs in every server process. For single-
// instance deploys that's fine; for multi-instance you want pg-boss so only
// one replica runs each job. Swap in pg-boss (plan.md M3) before scaling.

import { prisma } from "@manta/db";
import { inbox } from "@manta/db";
import type { Prisma } from "@manta/db";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import { createLogger } from "./logger.ts";
import { sendSlackNotifications } from "./slack/notify.ts";
import { sendDueScheduledSlackMessages } from "./slack/scheduled.ts";
import { sendDueSpotChecks } from "./workspaces/spotChecksRoutes.ts";
import { runScoutTurn } from "./scout/runner.ts";
import { runHealthCheck } from "./scout/healthCheck.ts";
import { resolveScoutBackendId } from "./models/service.ts";
import { tokenForWorkspaceRepo } from "./github/tokens.ts";
import { bus, chanTopic, kanbanTopic } from "./bus.ts";
import { startWorkerForTask } from "./worker/dispatch.ts";

const logger = createLogger("Manta:Poller");

const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 2 * 60 * 1000;    // every 2 minutes
const HIDDEN_BACKGROUND_TASK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// ─────────────────── Stall detection ────────────────────────────────────────

async function startUnassignedWorkers(): Promise<void> {
  const unassigned = await prisma.task.findMany({
    where: {
      cardStatus: { in: ["bot_working", "interactive"] },
      workerActive: false,
      workerStatus: "pending",
      archivedAt: null,
      hidden: false,
    },
    take: 25,
  });

  for (const task of unassigned) {
    const prompt = task.description.trim() ||
      "Please start work on this card. If you need clarification, move the card to Needs Help and ask.";
    const started = await startWorkerForTask(task, prompt);
    if (started) logger.info("auto-assigned worker to unstarted task", { taskId: task.id });
  }
}

async function detectStalls(): Promise<void> {
  const threshold = new Date(Date.now() - STALL_THRESHOLD_MS);
  const stalled = await prisma.task.findMany({
    where: {
      cardStatus: "bot_working",
      workerActive: false,
      workerStatus: "running",
      updatedAt: { lt: threshold },
      archivedAt: null,
      hidden: false,
    },
    select: { id: true, title: true, workspaceId: true },
  });

  for (const task of stalled) {
    logger.warn("stalled task detected", { taskId: task.id });
    await inbox.push(task.workspaceId, {
      channel: "brain",
      body: `[Poller] Task ${task.id} ("${task.title}") appears stalled: bot_working with no active worker for over 30 minutes. Consider checking on it.`,
      source: "poller",
    });
    // Mark the worker as failed so we don't re-alert on the same task.
    await prisma.task.update({
      where: { id: task.id },
      data: { workerStatus: "stalled" },
    });
  }
}

async function reapHiddenBackgroundTasks(): Promise<void> {
  const cutoff = new Date(Date.now() - HIDDEN_BACKGROUND_TASK_TTL_MS);
  const result = await prisma.task.updateMany({
    where: {
      hidden: true,
      backgroundMode: { not: null },
      archivedAt: null,
      updatedAt: { lt: cutoff },
    },
    data: {
      archivedAt: new Date(),
      cardStatus: "canceled",
      workerActive: false,
      workerStatus: "done",
      venueStatus: "idle",
    },
  });
  if (result.count > 0) logger.info("reaped stale hidden background tasks", { count: result.count });
}

// ─────────────────── GitHub PR state refresh ────────────────────────────────

interface GhPr {
  node_id?: string;
  state: string;
  merged_at: string | null;
  title: string;
  mergeable: boolean | null;
  mergeable_state: string | null;
  auto_merge?: unknown | null;
  head?: { sha?: string };
}

interface GhRepo {
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

interface GhReview {
  user?: { id?: number; login?: string } | null;
  state?: string;
  submitted_at?: string;
}

type ChecksStatus = "passing" | "failing" | "pending" | "unknown";
type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

interface GhCombinedStatus {
  state?: string; // success | failure | error | pending
  statuses?: Array<{ context?: string; state?: string }>;
}
interface GhCheckRuns {
  check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
}

interface CiCheck {
  name: string;
  status: "passing" | "failing" | "pending" | "unknown";
  conclusion?: string | null;
}

/**
 * Merge the two ways GitHub reports CI on a commit: the legacy combined-status
 * API (CircleCI, etc. via commit statuses) and the Checks API (GitHub Actions,
 * which do NOT appear in commit statuses). Worst signal wins:
 *   any failing → failing; else any pending → pending; else any passing → passing.
 */
function mergeChecks(combinedState: string | undefined, runs: GhCheckRuns["check_runs"]): ChecksStatus {
  let pending = false;
  let passing = false;

  if (combinedState === "failure" || combinedState === "error") return "failing";
  if (combinedState === "pending") pending = true;
  if (combinedState === "success") passing = true;

  for (const run of runs ?? []) {
    if (run.status !== "completed") { pending = true; continue; }
    const c = run.conclusion;
    if (c === "failure" || c === "timed_out" || c === "action_required") return "failing";
    if (c === "success") passing = true;
    // neutral / skipped / cancelled / stale → ignored (not failing, not passing)
  }

  if (pending) return "pending";
  if (passing) return "passing";
  return "unknown";
}

function normalizeChecks(combined: GhCombinedStatus, runs: GhCheckRuns["check_runs"]): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const status of combined.statuses ?? []) {
    const state = status.state;
    checks.push({
      name: status.context || "status check",
      status: state === "success" ? "passing" : state === "failure" || state === "error" ? "failing" : state === "pending" ? "pending" : "unknown",
      conclusion: state ?? null,
    });
  }
  for (const run of runs ?? []) {
    const conclusion = run.conclusion ?? null;
    checks.push({
      name: run.name || "check run",
      status: run.status !== "completed"
        ? "pending"
        : conclusion === "success"
          ? "passing"
          : conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required"
            ? "failing"
            : "unknown",
      conclusion,
    });
  }
  return checks;
}

// Reviews come back oldest-first; a PR can accumulate >100 (each push can
// re-request review). We must page through all of them, otherwise the latest
// review per user — which decides APPROVED vs CHANGES_REQUESTED — is computed
// from a stale window and the decision can be wrong.
async function fetchAllReviews(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
): Promise<GhReview[]> {
  const all: GhReview[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) break;
    const batch = (await res.json()) as GhReview[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function reviewDecision(reviews: GhReview[]): string | null {
  const latestByUser = new Map<string, GhReview>();
  for (const review of reviews) {
    const key = String(review.user?.id ?? review.user?.login ?? "");
    if (!key || !review.state || review.state === "COMMENTED") continue;
    const prev = latestByUser.get(key);
    if (!prev || new Date(review.submitted_at ?? 0) > new Date(prev.submitted_at ?? 0)) latestByUser.set(key, review);
  }
  const latest = [...latestByUser.values()].map((r) => r.state);
  if (latest.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (latest.includes("APPROVED")) return "APPROVED";
  return null;
}

function mergeableState(pr: GhPr): Mergeable {
  if (pr.mergeable_state === "dirty") return "CONFLICTING";
  if (pr.mergeable === true) return "MERGEABLE";
  if (pr.mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}

type MergeMethod = "merge" | "squash" | "rebase";

export function mergeMethodFor(repo: GhRepo | null | undefined): MergeMethod | null {
  if (!repo) return "merge";
  if (repo.allow_merge_commit) return "merge";
  if (repo.allow_squash_merge) return "squash";
  if (repo.allow_rebase_merge) return "rebase";
  return null;
}

export function cardTitleForPrRefresh(task: { title: string; prTitle: string | null }, refreshedPrTitle: string): string {
  const title = refreshedPrTitle.trim();
  if (!title) return task.title;
  return title;
}

export function shouldPostLinearHandoffComment(_task: { linearTriage: Prisma.JsonValue | null }): boolean {
  return false;
}

export function autoMergeBlockers(state: {
  prState: string;
  merged: boolean;
  checksStatus: ChecksStatus;
  reviewDecision: string | null;
  mergeable: Mergeable;
}): string[] {
  const blockers: string[] = [];
  if (state.merged) blockers.push("already_merged");
  if (state.prState === "closed") blockers.push("pr_closed");
  if (state.checksStatus !== "passing") blockers.push(`checks_${state.checksStatus}`);
  if (state.reviewDecision !== "APPROVED") blockers.push(state.reviewDecision ? `review_${state.reviewDecision.toLowerCase()}` : "review_missing");
  // GitHub's REST `mergeable` field is best-effort and can remain null even
  // when the PR page says the branch has no conflicts. Treat an explicit
  // conflict as a blocker, but let the merge endpoint be authoritative for the
  // UNKNOWN case so Manta's auto-merge readiness matches the green PR badge.
  if (state.mergeable === "CONFLICTING") blockers.push("mergeable_conflicting");
  return blockers;
}

async function fetchPrState(orgRepo: string, prNumber: number, token: string): Promise<{
  prTitle: string;
  prState: string;
  merged: boolean;
  checksStatus: ChecksStatus;
  checks: CiCheck[];
  reviewDecision: string | null;
  mergeable: Mergeable;
  headSha: string | null;
  mergeMethod: MergeMethod | null;
  nodeId: string | null;
  githubAutoMergeEnabled: boolean;
} | null> {
  const [owner, repo] = orgRepo.split("/");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  if (!prRes.ok) return null;
  const pr = (await prRes.json()) as GhPr;

  // Use the actual head SHA for status/check-run lookups. GitHub's UI keys the
  // green/red state to the head commit, and some Checks API calls do not resolve
  // the synthetic refs/pull/<n>/head ref consistently (especially across forks).
  const ref = pr.head?.sha ?? `refs/pull/${prNumber}/head`;
  // The pull request REST payload embeds a partial `base.repo` object that can
  // omit merge-method settings. Fetch the repository directly so Manta can use
  // the merge method that is actually enabled for repos such as squash-only
  // acme/platform; otherwise we compute `null` and silently skip merging.
  const [repoRes, statusRes, checkRunsRes, reviews] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`, { headers }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`, { headers }),
    fetchAllReviews(owner!, repo!, prNumber, headers),
  ]);
  const repoSettings = repoRes.ok ? ((await repoRes.json()) as GhRepo) : null;
  const combined = statusRes.ok ? ((await statusRes.json()) as GhCombinedStatus) : {};
  const checkRuns = checkRunsRes.ok ? ((await checkRunsRes.json()) as GhCheckRuns) : {};

  return {
    prTitle: pr.title,
    prState: pr.state,
    merged: Boolean(pr.merged_at),
    checksStatus: mergeChecks(combined.state, checkRuns.check_runs),
    checks: normalizeChecks(combined, checkRuns.check_runs),
    reviewDecision: reviewDecision(reviews),
    mergeable: mergeableState(pr),
    headSha: pr.head?.sha ?? null,
    mergeMethod: mergeMethodFor(repoSettings),
    nodeId: pr.node_id ?? null,
    githubAutoMergeEnabled: pr.auto_merge != null,
  };
}

async function mergePullRequest(
  orgRepo: string,
  prNumber: number,
  token: string,
  options: { headSha: string | null; mergeMethod: MergeMethod | null },
): Promise<boolean> {
  if (!options.mergeMethod) return false;
  const [owner, repo] = orgRepo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      merge_method: options.mergeMethod,
      ...(options.headSha ? { sha: options.headSha } : {}),
    }),
  });
  if (res.ok) return true;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch { /* ignore */ }
  logger.warn("auto-merge request failed", { orgRepo, prNumber, message });
  return false;
}

export async function refreshPrStates(opts: { workspaceId?: string; taskId?: string } = {}): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      ...(opts.taskId ? { id: opts.taskId } : {}),
      prNumber: { not: null },
      OR: [{ prState: { not: "closed" } }, { prState: null }],
      archivedAt: null,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    select: { id: true, workspaceId: true, repo: true, title: true, prNumber: true, prTitle: true, cardStatus: true, prState: true, checks: true, checksStatus: true, reviewDecision: true, mergeable: true, autoMergeEnabled: true },
  });

  for (const task of tasks) {
    if (!task.prNumber) continue;
    try {
      // Mint a repo-scoped token from the task's workspace App installation.
      const token = await tokenForWorkspaceRepo(task.workspaceId, task.repo);
      if (!token) continue; // workspace hasn't connected GitHub
      let state = await fetchPrState(task.repo, task.prNumber, token);
      if (!state) continue;

      const autoMergeBlockersForState = autoMergeBlockers(state);
      const canAutoMergeNow = task.autoMergeEnabled && autoMergeBlockersForState.length === 0;
      if (canAutoMergeNow) {
        const merged = await mergePullRequest(task.repo, task.prNumber, token, {
          headSha: state.headSha,
          mergeMethod: state.mergeMethod,
        });
        if (merged) {
          logger.info("auto-merged PR", { taskId: task.id, repo: task.repo, prNumber: task.prNumber });
          state = { ...state, prState: "closed", merged: true };
        }
      } else if (task.autoMergeEnabled && !state.merged && state.prState !== "closed") {
        // GitHub native auto-merge may be disabled for the repository, so Manta
        // owns the wait: keep polling until approvals, checks, and mergeability
        // are all ready, then call the merge endpoint directly above.
        logger.debug("auto-merge waiting on PR readiness", {
          taskId: task.id,
          repo: task.repo,
          prNumber: task.prNumber,
          blockers: autoMergeBlockersForState,
          checksStatus: state.checksStatus,
          reviewDecision: state.reviewDecision,
          mergeable: state.mergeable,
        });
      }

      const nextAutoMergeEnabled = state.prState === "closed" ? false : task.autoMergeEnabled;
      const nextTitle = cardTitleForPrRefresh(task, state.prTitle);
      const prTitleChanged = task.prTitle !== state.prTitle;
      const changed = prTitleChanged || task.title !== nextTitle || task.prState !== state.prState || task.checksStatus !== state.checksStatus || JSON.stringify(task.checks) !== JSON.stringify(state.checks) || task.reviewDecision !== state.reviewDecision || task.mergeable !== state.mergeable || task.autoMergeEnabled !== nextAutoMergeEnabled;
      await prisma.task.update({
        where: { id: task.id },
        data: {
          ...(task.title !== nextTitle ? { title: nextTitle } : {}),
          prTitle: state.prTitle,
          prState: state.prState,
          checks: state.checks as unknown as Prisma.InputJsonValue,
          checksStatus: state.checksStatus,
          reviewDecision: state.reviewDecision,
          mergeable: state.mergeable,
          autoMergeEnabled: nextAutoMergeEnabled,
          prUpdatedAt: new Date(),
        },
      });
      if (changed) {
        bus.publish(kanbanTopic(task.workspaceId), {});
        bus.publish(chanTopic(task.workspaceId, task.id), { type: "task_updated" });
      }

      // Reconciler: PR merged → card done.
      if (state.merged && task.cardStatus !== "done") {
        await prisma.$transaction([
          prisma.taskTransition.create({
            data: {
              taskId: task.id,
              workspaceId: task.workspaceId,
              fromStatus: task.cardStatus,
              toStatus: "done",
              by: "poller",
              reason: "PR merged",
            },
          }),
          prisma.task.update({
            where: { id: task.id },
            data: { cardStatus: "done", doneReason: "merged" },
          }),
        ]);
        logger.info("card graduated: merged PR", { taskId: task.id });
      }
    } catch (err) {
      logger.warn("PR refresh failed", { taskId: task.id, err });
    }
  }
}

// ─────────────────── Linear PR-handoff ──────────────────────────────────────

async function linearPrHandoff(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      cardStatus: "done",
      linearCommentPosted: false,
      linearIssueIdentifier: { not: null },
      archivedAt: null,
    },
    select: { id: true, linearIssueIdentifier: true, linearTriage: true },
  });

  for (const task of tasks) {
    try {
      if (!shouldPostLinearHandoffComment(task)) {
        await prisma.task.update({ where: { id: task.id }, data: { linearCommentPosted: true } });
        logger.info("linear handoff comment suppressed", { taskId: task.id, issue: task.linearIssueIdentifier });
        continue;
      }
    } catch (err) {
      logger.warn("linear handoff suppression failed", { taskId: task.id, err });
    }
  }
}

// ─────────────────── Scout digest (periodic status brief) ───────────────────

const SCOUT_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
let lastScoutRun = 0;
// Single-flight guard: if a previous digest is still running (e.g. a slow LLM
// run that overran the interval), skip this tick rather than piling on a second
// concurrent sweep. This is what stops the bursty 12-runs-in-an-hour pattern.
let scoutInFlight = false;

async function scoutDigest(deps?: PollerDeps): Promise<void> {
  if (scoutInFlight) return;
  const now = Date.now();
  if (now - lastScoutRun < SCOUT_INTERVAL_MS) return;
  lastScoutRun = now;
  scoutInFlight = true;
  try {
    await runScoutDigest(deps);
  } finally {
    scoutInFlight = false;
  }
}

async function runScoutDigest(deps?: PollerDeps): Promise<void> {
  // Only scout workspaces that actually have open cards — no open cards, nothing
  // to triage, so we never spend a turn (or any tokens) on an idle workspace.
  const workspacesWithTasks = await prisma.workspace.findMany({
    where: { tasks: { some: { archivedAt: null, cardStatus: { notIn: ["done", "backlog"] } } } },
    select: { id: true },
  });

  for (const ws of workspacesWithTasks) {
    // Resolve Scout's model from THIS workspace's own credentials (configured
    // scout model → cheapest available → brain default). Never the server's
    // ambient creds — that's how a hosted box's IAM Bedrock access used to leak
    // in and make every scout turn fail. null → no creds → plain text digest.
    const scoutBackendId = await resolveScoutBackendId(ws.id);

    // If a backend is available, run the LLM-powered Scout session.
    if (deps?.backend && scoutBackendId) {
      try {
        await runScoutTurn({ workspaceId: ws.id, backend: deps.backend, backendId: scoutBackendId });
        logger.info("scout turn completed", { workspaceId: ws.id, backendId: scoutBackendId });
      } catch (err) {
        logger.error("scout turn failed", { workspaceId: ws.id, err });
      }
      continue;
    }

    // Fallback: simple text digest (no backend configured).
    const activeTasks = await prisma.task.findMany({
      where: { workspaceId: ws.id, archivedAt: null, cardStatus: { notIn: ["done", "backlog"] } },
      select: { id: true, title: true, cardStatus: true, workerStatus: true, prNumber: true },
    });
    if (!activeTasks.length) continue;

    const lines = activeTasks.map((t) => {
      const parts = [`• [${t.cardStatus}] ${t.title}`];
      if (t.workerStatus) parts.push(`worker:${t.workerStatus}`);
      if (t.prNumber) parts.push(`PR#${t.prNumber}`);
      return parts.join(" — ");
    });
    const body = `[Scout digest] ${activeTasks.length} active task(s):\n${lines.join("\n")}`;
    await inbox.push(ws.id, { channel: "brain", body, source: "poller" });
    logger.info("scout digest sent", { workspaceId: ws.id, taskCount: activeTasks.length });
  }
}

// ─────────────────── Daily Manta health-check report ───────────────────────

const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24 hours
let lastHealthCheckRun = 0;

async function dailyHealthCheck(deps?: PollerDeps): Promise<void> {
  if (!deps?.backend || !deps.backendId) return;
  if (!(process.env["MANTA_HEALTH_CHECK_SLACK_CHANNEL"] || process.env["SLACK_SPOTCHECK_CHANNEL"]) || !process.env["SLACK_BOT_TOKEN"]) return;

  const now = Date.now();
  if (now - lastHealthCheckRun < HEALTH_CHECK_INTERVAL_MS) return;
  lastHealthCheckRun = now;

  const allWorkspaces = await prisma.workspace.findMany({ select: { id: true } });
  for (const ws of allWorkspaces) {
    try {
      await runHealthCheck({ workspaceId: ws.id, backend: deps.backend, backendId: deps.backendId });
      logger.info("health check completed", { workspaceId: ws.id });
    } catch (err) {
      logger.error("health check failed", { workspaceId: ws.id, err });
    }
  }
}

// ─────────────────────────── Poller loop ─────────────────────────────────────

export interface PollerDeps {
  backend?: AgentBackend;
  backendId?: string;
  defaultBrainPrompt?: string;
  tools?: ToolDefinition[];
}

export function startPoller(deps?: PollerDeps): () => void {
  const tick = async () => {
    try {
      await Promise.all([
        startUnassignedWorkers(),
        detectStalls(),
        reapHiddenBackgroundTasks(),
        refreshPrStates(),
        sendSlackNotifications(),
        sendDueScheduledSlackMessages(deps?.backend && deps.backendId && deps.defaultBrainPrompt && deps.tools
          ? { backend: deps.backend, backendId: deps.backendId, defaultBrainPrompt: deps.defaultBrainPrompt, tools: deps.tools }
          : undefined),
        sendDueSpotChecks(deps?.backendId && deps.defaultBrainPrompt
          ? { brainBackendId: deps.backendId, defaultBrainPrompt: deps.defaultBrainPrompt }
          : undefined),
        linearPrHandoff(),
        scoutDigest(deps),
        dailyHealthCheck(deps),
      ]);
    } catch (err) {
      logger.error("poller tick failed", { err });
    }
  };

  // Run once immediately (after a short delay so the server is fully up), then
  // on the regular interval.
  const initTimer = setTimeout(() => void tick(), 5_000);
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);

  return () => {
    clearTimeout(initTimer);
    clearInterval(interval);
  };
}
