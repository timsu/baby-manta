// Daily Manta health check: LLM-generated engineering health report for each
// workspace, posted to a configured Slack channel (MANTA_HEALTH_CHECK_SLACK_CHANNEL
// env var; SLACK_SPOTCHECK_CHANNEL is still accepted for existing deployments).
// Runs once per day via the poller. Uses agentSessions to maintain a persistent
// "health-check" channel so the brain carries context across days.

import { defineTool } from "@manta/agent";
import type { AgentBackend } from "@manta/agent";
import { prisma, agentSessions } from "@manta/db";
import { WebClient } from "@slack/web-api";
import { runBrainTurn } from "../brain/runner.ts";
import { getLinearToken, listLinearTeams, listLinearIssues, getLinearIssue } from "../linear/client.ts";
import { tokenForWorkspaceRepo } from "../github/tokens.ts";

const HEALTH_CHECK_CHANNEL = process.env["MANTA_HEALTH_CHECK_SLACK_CHANNEL"] || process.env["SLACK_SPOTCHECK_CHANNEL"];

const HEALTH_CHECK_PROMPT = `You are Manta's daily health reporter. Once a day you review the workspace and post a structured verdicts report to Slack via post_report.

Report format (use this structure, emoji ✅/⚠️/❌ for status):
**Daily Engineering Health Check**
- Tasks: <count> active, <count> needs_help, <count> ready_to_test
- PRs: list of open PRs with CI status
- Blockers: any tasks stalled >24h
- Linear: any in-progress issues with no linked Manta task
- Recommendation: one-sentence action item

Keep the report under 300 words. Call post_report EXACTLY ONCE.
Available tools: get_all_tasks, list_github_prs, list_linear_teams, list_linear_issues, post_report.
`;

export interface HealthCheckDeps {
  workspaceId: string;
  backend: AgentBackend;
  backendId: string;
}

function buildHealthCheckTools(workspaceId: string, slackClient: WebClient) {
  const getAllTasks = defineTool({
    name: "get_all_tasks",
    description: "List all non-archived tasks including done ones from the last 7 days.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await prisma.task.findMany({
        where: {
          workspaceId,
          archivedAt: null,
          hidden: false,
          OR: [{ cardStatus: { not: "done" } }, { updatedAt: { gte: cutoff } }],
        },
        select: {
          id: true, title: true, cardStatus: true, workerStatus: true,
          prNumber: true, prState: true, checksStatus: true, repo: true,
          updatedAt: true, workerActive: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
      return { tasks: rows, asOf: new Date().toISOString() };
    },
  });

  const listPrs = defineTool<{ repo: string }>({
    name: "list_github_prs",
    description: "List open pull requests for a GitHub repo (org/repo).",
    parameters: {
      type: "object",
      required: ["repo"],
      properties: { repo: { type: "string" } },
    },
    handler: async (args) => {
      const [owner, repo] = args.repo.split("/");
      if (!owner || !repo) return { error: "invalid repo format" };
      const token = await tokenForWorkspaceRepo(workspaceId, args.repo);
      if (!token) return { error: "GitHub not connected for this workspace" };
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return { error: `GitHub API ${res.status}` };
      const prs = (await res.json()) as { number: number; title: string; html_url: string; draft: boolean; updated_at: string }[];
      return { prs: prs.map((p) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft, updatedAt: p.updated_at })) };
    },
  });

  const listTeamsTool = defineTool({
    name: "list_linear_teams",
    description: "List available Linear teams.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!getLinearToken()) return { error: "LINEAR_API_KEY not set" };
      return { teams: await listLinearTeams() };
    },
  });

  const listIssues = defineTool<{ teamId: string; limit?: number }>({
    name: "list_linear_issues",
    description: "List active Linear issues for a team.",
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
    description: "Fetch a single Linear issue by UUID or identifier.",
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

  const postReport = defineTool<{ report: string }>({
    name: "post_report",
    description: "Post the formatted health report to the configured Slack channel. Call exactly once.",
    parameters: {
      type: "object",
      required: ["report"],
      properties: { report: { type: "string" } },
    },
    handler: async (args) => {
      if (!HEALTH_CHECK_CHANNEL) return { error: "MANTA_HEALTH_CHECK_SLACK_CHANNEL not set" };
      await slackClient.chat.postMessage({ channel: HEALTH_CHECK_CHANNEL, text: args.report });
      return { ok: true };
    },
  });

  return [getAllTasks, listPrs, listTeamsTool, listIssues, getIssueTool, postReport];
}

/** Run one daily Manta health-check brain turn for a workspace. */
export async function runHealthCheck(deps: HealthCheckDeps): Promise<void> {
  const slackToken = process.env["SLACK_BOT_TOKEN"];
  if (!HEALTH_CHECK_CHANNEL || !slackToken) return;

  const slackClient = new WebClient(slackToken);
  const tools = buildHealthCheckTools(deps.workspaceId, slackClient);

  const existingKey = await agentSessions.getSessionKey(deps.workspaceId, "health-check");

  await runBrainTurn({
    scope: { workspaceId: deps.workspaceId },
    channel: "health-check",
    userMessage: "Generate today's health report.",
    backend: deps.backend,
    backendId: deps.backendId,
    tools,
    promptParts: { basePrompt: HEALTH_CHECK_PROMPT },
    resumeFrom: existingKey ?? undefined,
    onSession: async (key) => {
      await agentSessions.upsertSessionKey(deps.workspaceId, "health-check", key, "custom", "pi");
    },
  });
}
