// The task payload handed to a worker (laptop daemon or cloud sandbox) so it can
// provision a worktree and run a turn without a DB connection. Shared by the
// /worker-ws dispatch path (ws.ts) and the cloud venue runner (cloud.ts).

import { repos, workspaces, type Task } from "@manta/db";
import { linearAppTokenForWorkspace } from "../linear/client.ts";

/** One entry from a repo's skill repos config. */
export interface SkillRepoConfig {
  /** GitHub org/repo slug (e.g. "acme/skills"). */
  repo: string;
  /** Subdirectory within the cloned repo to treat as the skill root (e.g. "skill"). Defaults to repo root. */
  path?: string;
}

export interface WorkerTaskPayload {
  id: string;
  name: string;
  repo: string;
  title: string;
  cardType: string;
  backgroundMode?: string | null;
  executionMode?: "task" | "background" | "background_readonly";
  workerBackend: string;
  worktreePath?: string;
  branch?: string;
  defaultBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  linearIssueIdentifier?: string;
  /** True when the card was spawned from Slack and can report final findings there. */
  slackOriginated?: boolean;
  sessionKey?: string;
  /** Repo "Setup commands" to run once on first provision (server has the DB). */
  setupCommands?: string;
  /** Workspace-wide durable context to include in every worker turn. */
  teamMemory?: string;
  /** Enabled repos in this workspace, used so workers can detect likely repo mismatches. */
  workspaceRepos?: string[];
  /** Skill repos to clone alongside the main repo and register with Pi. */
  skillRepos?: SkillRepoConfig[];
  /** Workspace Linear app token for Linear automation workers. */
  linearApiKey?: string;
}

function isLinearAutomationTask(task: Pick<Task, "linearIssueIdentifier" | "linearTriage">): boolean {
  if (task.linearIssueIdentifier) return true;
  const triage = task.linearTriage;
  return Boolean(triage && typeof triage === "object" && (triage as Record<string, unknown>)["statusAutomation"] === true);
}

function normalizeSkillRepos(raw: unknown): SkillRepoConfig[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const result: SkillRepoConfig[] = [];
  for (const entry of raw) {
    if (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>)["repo"] === "string") {
      const e = entry as Record<string, unknown>;
      const repo = (e["repo"] as string).trim();
      const path = typeof e["path"] === "string" ? e["path"].trim() : "";
      if (repo) result.push({ repo, ...(path ? { path } : {}) });
    }
  }
  return result.length > 0 ? result : undefined;
}

export async function buildTaskPayload(
  task: Pick<
    Task,
    | "id" | "workspaceId" | "name" | "repo" | "title" | "workerBackend"
    | "cardType" | "hidden" | "backgroundMode" | "worktreePath" | "branch" | "prNumber" | "prUrl" | "prTitle" | "linearIssueIdentifier" | "linearTriage" | "sessionBlobKey"
    | "slackChannel" | "slackBotId"
  >,
  extra?: { setupCommands?: string; executionMode?: WorkerTaskPayload["executionMode"] },
): Promise<WorkerTaskPayload> {
  const [workspace, repo, workspaceRepoRows, linearApiKey] = await Promise.all([
    workspaces.byId(task.workspaceId).catch(() => null),
    repos.byOrgRepo({ workspaceId: task.workspaceId }, task.repo).catch(() => null),
    repos.list({ workspaceId: task.workspaceId }).catch(() => []),
    isLinearAutomationTask(task) ? linearAppTokenForWorkspace(task.workspaceId).catch(() => null) : null,
  ]);
  const skillRepos = normalizeSkillRepos(repo?.skillRepos);
  const workspaceRepos = workspaceRepoRows.filter((r) => r.enabled).map((r) => r.orgRepo);
  return {
    id: task.id,
    name: task.name,
    repo: task.repo,
    title: task.title,
    cardType: task.cardType,
    backgroundMode: task.backgroundMode ?? undefined,
    ...(extra?.executionMode
      ? { executionMode: extra.executionMode }
      : task.backgroundMode
        ? { executionMode: (task.backgroundMode === "orchestration" || task.backgroundMode === "spot_check" || task.backgroundMode === "linear_status_automation") ? "background" as const : "background_readonly" as const }
        : {}),
    workerBackend: task.workerBackend,
    worktreePath: task.worktreePath ?? undefined,
    branch: task.branch ?? undefined,
    defaultBranch: repo?.defaultBranch ?? undefined,
    prNumber: task.prNumber ?? undefined,
    prUrl: task.prUrl ?? undefined,
    prTitle: task.prTitle ?? undefined,
    linearIssueIdentifier: task.linearIssueIdentifier ?? undefined,
    slackOriginated: Boolean(task.slackChannel && task.slackBotId) || undefined,
    sessionKey: task.sessionBlobKey ?? undefined,
    teamMemory: workspace?.teamMemory?.trim() || undefined,
    ...(workspaceRepos.length > 0 ? { workspaceRepos } : {}),
    ...(extra?.setupCommands ? { setupCommands: extra.setupCommands } : {}),
    ...(skillRepos ? { skillRepos } : {}),
    ...(linearApiKey ? { linearApiKey } : {}),
  };
}
