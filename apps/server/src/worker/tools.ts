// Worker control-plane tools — injected into every worker turn so the agent
// can report results back to the server without needing a separate HTTP call.
//
// These complement the Pi built-in coding tools (read/edit/bash/grep/…).
// The Pi backend converts them to tool definitions the model can call.

import { defineTool, type ToolContext } from "@manta/agent";
import { WebClient } from "@slack/web-api";
import { prisma, tasks, inbox, slack } from "@manta/db";
import { bus, kanbanTopic, chanTopic } from "../bus.ts";
import { createPr, mintInstallationToken, isConfigured as githubAppConfigured } from "../github/app.ts";
import { routeNonEngineerPrReview } from "../github/reviewRouting.ts";
import { githubPrTokenSourceForTask, githubUserTokenStatusForTask } from "../github/userTokens.ts";
import { parseGitHubPrUrl } from "../github/urls.ts";
import { linearTokenForWorkspace, linearAppTokenForWorkspace, getLinearIssue, commentOnIssue, listLinearMembers as linearListMembers, assignLinearIssue as linearAssignIssue, updateLinearIssue as linearUpdateIssue } from "../linear/client.ts";
import { createLogger } from "../logger.ts";
import { noteOnCard } from "../notices.ts";
import { appendTaskTranscriptLink } from "./conversationLinks.ts";
import { disposeTaskWorker } from "./registry.ts";
import { decrypt } from "../secrets/crypto.ts";
import { startWorkerForTask } from "./dispatch.ts";
import { prFieldsForReport } from "./prReport.ts";
import { recreateTaskInRepo, SwitchRepoError } from "./switchRepo.ts";
import { buildNotionTools } from "../notion/tools.ts";
import { workerHandoffBody } from "./handoff.ts";

const logger = createLogger("Manta:WorkerTools");

const PR_TITLE_GUIDANCE =
  "Use a concise, implementation-focused title based on the actual changes (ideally 50-72 characters). " +
  "Do not reuse the raw card title when it is conversational, profane, a question, or truncated; never end with an unfinished word or ellipsis.";

interface ReportPrArgs {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  branch: string;
}

interface GetTokenArgs {
  orgRepo: string;
}

interface RenameCardArgs {
  title: string;
}

interface CreateGithubPrArgs {
  title: string;
  body?: string;
  head: string;
  base: string;
}

interface PlanReadyArgs {
  plan: string;
}

interface SwitchCardRepoArgs {
  targetRepo: string;
  reason: string;
}

/** Build the list of control-plane tools for a worker turn. */
export function buildWorkerTools(taskId: string) {
  const renameCard = defineTool<RenameCardArgs>({
    name: "rename_card",
    description:
      "Rename this card to a short, useful title. Use this near the beginning of brand-new work " +
      "after you understand the task. Keep it concise and descriptive; do not include trailing punctuation.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A concise card title, ideally 4-10 words" },
      },
      required: ["title"],
    },
    handler: async (args, ctx: ToolContext) => {
      const title = args.title.trim();
      if (!title) return { ok: false, message: "title required" };
      try {
        const res = await prisma.task.updateMany({
          where: { id: taskId, workspaceId: ctx.workspaceId },
          data: { title },
        });
        if (res.count === 0) return { ok: false, message: "task not found" };
        bus.publish(chanTopic(ctx.workspaceId, taskId), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true, message: `Card renamed to ${title}` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to rename card" };
      }
    },
  });

  const reportPr = defineTool<ReportPrArgs>({
    name: "report_pr",
    description:
      "Report the pull request this task updated. For existing-PR cards, report the existing PR after pushing commits; " +
      "for new work, call this after create_github_pr succeeds.",
    parameters: {
      type: "object",
      properties: {
        prNumber: { type: "number", description: "The PR number (integer)" },
        prUrl: { type: "string", description: "The full PR HTML URL" },
        prTitle: { type: "string", description: "The PR title" },
        branch: { type: "string", description: "The branch name you pushed" },
      },
      required: ["prNumber", "prUrl", "prTitle", "branch"],
    },
    handler: async (args, ctx: ToolContext) => {
      const scope = { workspaceId: ctx.workspaceId };
      try {
        const task = await tasks.get(scope, taskId);
        if (!task) return { ok: false, message: "task not found" };
        const prFields = prFieldsForReport(args.prTitle);
        if (!prFields) return { ok: false, message: "prTitle required" };
        const parsedPr = parseGitHubPrUrl(args.prUrl);
        if (!parsedPr) return { ok: false, message: "invalid GitHub PR URL" };
        if (parsedPr.orgRepo.toLowerCase() !== task.repo.toLowerCase() || parsedPr.prNumber !== args.prNumber) {
          logger.warn("report_pr rejected: PR does not match task repo/number", {
            taskId,
            taskRepo: task.repo,
            reportedRepo: parsedPr.orgRepo,
            taskPrNumber: args.prNumber,
            reportedPrNumber: parsedPr.prNumber,
          });
          return { ok: false, message: `PR ${args.prUrl} does not match this card's repo (${task.repo}).` };
        }
        await Promise.all([
          tasks.setWorker(scope, taskId, {
            workerStatus: "pr_created",
            branch: args.branch,
          }),
          tasks.setPr(scope, taskId, {
            ...prFields,
            prNumber: args.prNumber,
            prUrl: args.prUrl,
            prState: "open",
            prUpdatedAt: new Date(),
          }),
          // Graduate bot_working → ready_to_test when PR work is ready.
          task?.cardStatus === "bot_working"
            ? tasks.transition(scope, taskId, "ready_to_test", "worker")
            : Promise.resolve(),
        ]);
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        logger.info("PR reported", { taskId, prNumber: args.prNumber });
        return { ok: true, message: `PR #${args.prNumber} recorded.` };
      } catch (err) {
        logger.error("report_pr failed", { taskId, err });
        return { ok: false, message: err instanceof Error ? err.message : "failed to record PR" };
      }
    },
  });

  const updateChecklist = defineTool<{ items: { id: string; text: string; checked: boolean }[] }>({
    name: "update_checklist",
    description:
      "Update the task's checklist. Pass the full array of items with checked=true for completed steps. " +
      "Use this to track your progress through multi-step tasks.",
    parameters: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "checked"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        // updateMany returns count instead of throwing on no match — surface the
        // miss as a failure rather than reporting ok and firing spurious events.
        const res = await prisma.task.updateMany({
          where: { id: taskId, workspaceId: ctx.workspaceId },
          data: { checklist: args.items },
        });
        if (res.count === 0) return { ok: false, message: "task not found" };
        bus.publish(chanTopic(ctx.workspaceId, taskId), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to update checklist" };
      }
    },
  });

  const switchCardRepo = defineTool<SwitchCardRepoArgs>({
    name: "switch_card_repo",
    description:
      "Switch this card to a different enabled repo in the same workspace when the request clearly belongs there. " +
      "Use this instead of Needs Help for wrong-repo cards. It creates a replacement card in the target repo and cancels this one.",
    parameters: {
      type: "object",
      required: ["targetRepo", "reason"],
      properties: {
        targetRepo: { type: "string", description: "The enabled workspace repo in org/repo format." },
        reason: { type: "string", description: "Short explanation for why the card belongs in the target repo." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const targetRepo = args.targetRepo.trim();
      const reason = args.reason.trim();
      if (!targetRepo || !reason) return { ok: false, message: "targetRepo and reason required" };
      const scope = { workspaceId: ctx.workspaceId };
      try {
        const task = await tasks.get(scope, taskId);
        if (!task) return { ok: false, message: "task not found" };
        const replacement = await recreateTaskInRepo({
          workspaceId: ctx.workspaceId,
          taskId,
          targetRepo,
          reason,
        });
        const started = await startWorkerForTask(replacement, task.description);
        const sameRepoRefresh = replacement.repo === task.repo;
        await noteOnCard(scope, taskId, `🔀 Worker ${sameRepoRefresh ? "refreshed" : "recreated"} this card as ${replacement.id} in ${replacement.repo}: ${reason}`);
        await noteOnCard(scope, replacement.id, `🔀 Created from ${task.id} in ${task.repo}${sameRepoRefresh ? " to refresh its worker checkout" : ` because the worker determined the card belonged in ${replacement.repo}`}.\n\nReason: ${reason}`);
        disposeTaskWorker(taskId);
        bus.publish(chanTopic(ctx.workspaceId, taskId), { type: "task_updated" });
        bus.publish(chanTopic(ctx.workspaceId, replacement.id), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return {
          ok: true,
          repo: replacement.repo,
          newTaskId: replacement.id,
          newTaskNumber: replacement.taskNumber,
          workerStarted: started,
          message: `Created replacement card ${replacement.id} in ${replacement.repo} and canceled the old card.`,
        };
      } catch (err) {
        if (err instanceof SwitchRepoError) return { ok: false, message: err.code };
        logger.error("switch_card_repo failed", { taskId, err });
        return { ok: false, message: err instanceof Error ? err.message : "failed to switch card repo" };
      }
    },
  });

  const linkLinearIssue = defineTool<{ issueIdentifier: string }>({
    name: "link_linear_issue",
    description:
      "Link this task to a Linear issue so it appears in the Manta UI with a clickable link. " +
      "Pass the issue identifier (e.g. 'ENG-42'). The issue must exist in the connected Linear workspace.",
    parameters: {
      type: "object",
      required: ["issueIdentifier"],
      properties: {
        issueIdentifier: { type: "string", description: "Linear issue identifier, e.g. 'ENG-42'" },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const token = await linearTokenForWorkspace(ctx.workspaceId);
        if (!token) return { ok: false, message: "No Linear integration configured for this workspace" };
        const issue = await getLinearIssue(args.issueIdentifier, token);
        if (!issue) return { ok: false, message: `Linear issue '${args.issueIdentifier}' not found` };
        const res = await prisma.task.updateMany({
          where: { id: taskId, workspaceId: ctx.workspaceId },
          data: { linearIssueIdentifier: issue.identifier, linearIssueUrl: issue.url },
        });
        if (res.count === 0) return { ok: false, message: "task not found" };
        bus.publish(chanTopic(ctx.workspaceId, taskId), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true, message: `Linked to ${issue.identifier}: ${issue.title}` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to link Linear issue" };
      }
    },
  });

  const commentOnLinearIssue = defineTool<{ issueId?: string; body: string }>({
    name: "comment_on_linear_issue",
    description:
      "Post an investigation result or status update to this card's linked Linear issue using the workspace's Linear connection. " +
      "Omit issueId to use the linked issue.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        issueId: { type: "string", description: "Optional Linear issue UUID or identifier; defaults to this card's linked issue." },
        body: { type: "string", description: "Markdown comment body to post to Linear." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
        if (!task) return { ok: false, message: "task not found" };
        const issueId = args.issueId?.trim() || task.linearIssueIdentifier;
        if (!issueId) return { ok: false, message: "task has no linked Linear issue" };
        const token = await linearAppTokenForWorkspace(ctx.workspaceId);
        if (!token) return { ok: false, message: "No Linear app OAuth connection configured; refusing to post with a user token" };
        await commentOnIssue(issueId, args.body.trim(), token);
        if (task.cardStatus === "bot_working" && !task.prNumber) {
          if (task.cardType !== "investigation") disposeTaskWorker(task.id);
          await tasks.transition({ workspaceId: ctx.workspaceId }, task.id, task.cardType === "investigation" ? "investigation_complete" : "done", "worker", {
            doneReason: task.cardType === "investigation" ? "investigation_complete" : "completed",
            reason: task.cardType === "investigation" ? "Investigation complete; result posted to Linear" : "Investigation result posted to Linear",
          });
          await tasks.setWorker({ workspaceId: ctx.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
          bus.publish(chanTopic(ctx.workspaceId, task.id), { type: "task_updated" });
          bus.publish(kanbanTopic(ctx.workspaceId), {});
        }
        return { ok: true, issueId };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to comment on Linear issue" };
      }
    },
  });

  const reportSlackResult = defineTool<{ body: string }>({
    name: "report_slack_result",
    description:
      "Post the final findings for this Slack-originated investigation back to the originating Slack thread. " +
      "Use this instead of moving the card to Needs Help when the work is an investigation or answer that produced no PR.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Concise final findings to post to Slack. Markdown is okay; do not include secrets." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const body = args.body.trim();
        if (!body) return { ok: false, message: "body required" };
        const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
        if (!task) return { ok: false, message: "task not found" };
        if (!task.slackChannel || !task.slackThreadTs || !task.slackBotId) return { ok: false, message: "task has no linked Slack thread" };
        const bot = await slack.getBot(ctx.workspaceId, task.slackBotId);
        if (!bot?.enabled) return { ok: false, message: "Slack bot unavailable" };
        const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
        await client.chat.postMessage({ channel: task.slackChannel, thread_ts: task.slackThreadTs, text: body });
        if (task.cardStatus === "bot_working" && !task.prNumber) {
          if (task.cardType !== "investigation") disposeTaskWorker(task.id);
          await tasks.transition({ workspaceId: ctx.workspaceId }, task.id, task.cardType === "investigation" ? "investigation_complete" : "done", "worker", {
            doneReason: task.cardType === "investigation" ? "investigation_complete" : "completed",
            reason: task.cardType === "investigation" ? "Investigation complete; result posted to Slack" : "Investigation result posted to Slack",
          });
          await tasks.setWorker({ workspaceId: ctx.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
          await prisma.task.updateMany({ where: { id: task.id, workspaceId: ctx.workspaceId }, data: { slackDmSent: true } });
        }
        bus.publish(chanTopic(ctx.workspaceId, task.id), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to post Slack result" };
      }
    },
  });

  const completeInvestigation = defineTool<{ body: string }>({
    name: "complete_investigation",
    description:
      "Complete this investigation card when there is no Slack or Linear destination to report to. " +
      "Saves the final findings on the card and marks it Investigation Complete.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Concise final investigation findings to save on the card." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const body = args.body.trim();
        if (!body) return { ok: false, message: "body required" };
        const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
        if (!task) return { ok: false, message: "task not found" };
        if (task.cardType !== "investigation") return { ok: false, message: "task is not an investigation" };
        await noteOnCard({ workspaceId: ctx.workspaceId }, task.id, `🔎 Investigation complete\n\n${body}`);
        if (task.cardStatus === "bot_working" && !task.prNumber) {
          await tasks.transition({ workspaceId: ctx.workspaceId }, task.id, "investigation_complete", "worker", {
            doneReason: "investigation_complete",
            reason: "Investigation complete",
          });
          await tasks.setWorker({ workspaceId: ctx.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
        }
        bus.publish(chanTopic(ctx.workspaceId, task.id), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to complete investigation" };
      }
    },
  });

  const listLinearMembers = defineTool({
    name: "list_linear_members",
    description: "List active Linear members so you can find an engineer's assigneeId before assigning the linked Linear issue.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx: ToolContext) => {
      const token = await linearTokenForWorkspace(ctx.workspaceId);
      if (!token) return { ok: false, message: "No Linear integration configured for this workspace" };
      return { members: await linearListMembers(token) };
    },
  });

  const assignLinearIssue = defineTool<{ assigneeId: string; issueId?: string }>({
    name: "assign_linear_issue",
    description: "Assign this card's linked Linear issue to an engineer and move it back to Todo for their review work. Use list_linear_members first to find the assigneeId. Omit issueId to use the linked issue.",
    parameters: {
      type: "object",
      required: ["assigneeId"],
      properties: {
        assigneeId: { type: "string", description: "Linear user ID from list_linear_members." },
        issueId: { type: "string", description: "Optional Linear issue UUID or identifier; defaults to this card's linked issue." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
        if (!task) return { ok: false, message: "task not found" };
        const issueId = args.issueId?.trim() || task.linearIssueIdentifier;
        if (!issueId) return { ok: false, message: "task has no linked Linear issue" };
        const token = await linearAppTokenForWorkspace(ctx.workspaceId);
        if (!token) return { ok: false, message: "No Linear app OAuth connection configured; refusing to assign with a user token" };
        await linearAssignIssue(issueId, args.assigneeId.trim(), token);
        return { ok: true, issueId, assigneeId: args.assigneeId.trim() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to assign Linear issue" };
      }
    },
  });

  const updateLinearIssue = defineTool<{ issueId?: string; stateId?: string; stateName?: string; labelIds?: string[]; labelNames?: string[] }>({
    name: "update_linear_issue",
    description:
      "Update this card's linked Linear issue, or another issue by identifier/UUID. " +
      "Use this to move status/state and/or add labels such as AutoValidated or NeedsHumanQA. " +
      "Pass stateName (e.g. Done) or stateId, and labelNames or labelIds. Existing labels are preserved. Omit issueId to use the linked issue.",
    parameters: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Optional Linear issue UUID or identifier; defaults to this card's linked issue." },
        stateId: { type: "string", description: "Linear workflow state ID to move to, if known." },
        stateName: { type: "string", description: "Linear workflow state name to move to, e.g. Done." },
        labelIds: { type: "array", items: { type: "string" }, description: "Linear label IDs to add, if known." },
        labelNames: { type: "array", items: { type: "string" }, description: "Linear label names to add, e.g. [\"AutoValidated\"]." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      try {
        const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
        if (!task) return { ok: false, message: "task not found" };
        const issueId = args.issueId?.trim() || task.linearIssueIdentifier;
        if (!issueId) return { ok: false, message: "task has no linked Linear issue" };
        const token = await linearAppTokenForWorkspace(ctx.workspaceId);
        if (!token) return { ok: false, message: "No Linear app OAuth connection configured; refusing to mutate with a user token" };
        const issue = await linearUpdateIssue(issueId, {
          ...(args.stateId ? { stateId: args.stateId } : {}),
          ...(args.stateName ? { stateName: args.stateName } : {}),
          ...(args.labelIds ? { labelIds: args.labelIds } : {}),
          ...(args.labelNames ? { labelNames: args.labelNames } : {}),
        }, token);
        return { ok: true, issueId, issue };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to update Linear issue" };
      }
    },
  });

  const messageBrain = defineTool<{ message: string }>({
    name: "message_brain",
    description:
      "Send an orchestration request to the Manta brain for this workspace. " +
      "Use when follow-up work should be handled by Manta orchestration, such as spawning a fix card or assigning a Linear issue to an engineer.",
    parameters: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string", description: "Concise request with context, desired follow-up, and any relevant files/PR/Linear issue." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const message = args.message.trim();
      if (!message) return { ok: false, message: "message required" };
      const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
      if (!task) return { ok: false, message: "task not found" };
      await inbox.push(ctx.workspaceId, {
        channel: "brain",
        source: "worker",
        body: workerHandoffBody(task, message),
      });
      bus.publish(chanTopic(ctx.workspaceId, "brain"), { type: "status", text: `Worker ${task.id} sent a handoff to the brain.` });
      return { ok: true };
    },
  });

  const planReady = defineTool<PlanReadyArgs>({
    name: "plan_ready",
    description:
      "Submit the final markdown plan for a plan-mode card. This saves the plan, stops active work, and moves the card to Needs Help for human review.",
    parameters: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: { type: "string", description: "A concise markdown implementation plan with scope, steps, risks, and validation notes." },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const plan = args.plan.trim();
      if (!plan) return { ok: false, message: "plan required" };
      const scope = { workspaceId: ctx.workspaceId };
      try {
        const task = await tasks.get(scope, taskId);
        if (!task) return { ok: false, message: "task not found" };
        if (task.cardType !== "plan") return { ok: false, message: "task is not in plan mode" };
        await prisma.task.updateMany({
          where: { id: taskId, workspaceId: ctx.workspaceId },
          data: { planDocument: plan, workerActive: false, workerStatus: "stalled" },
        });
        if (task.cardStatus !== "needs_help") {
          await tasks.transition(scope, taskId, "needs_help", "worker", { reason: "Plan ready for review" });
        }
        await noteOnCard(scope, taskId, "📋 Plan ready for review — moved to Needs Help.");
        bus.publish(chanTopic(ctx.workspaceId, taskId), { type: "task_updated" });
        bus.publish(kanbanTopic(ctx.workspaceId), {});
        return { ok: true, message: "Plan saved and card moved to Needs Help." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "failed to save plan" };
      }
    },
  });

  const tools = [renameCard, reportPr, updateChecklist, switchCardRepo, linkLinearIssue, commentOnLinearIssue, reportSlackResult, completeInvestigation, listLinearMembers, assignLinearIssue, updateLinearIssue, ...buildNotionTools(), messageBrain, planReady];

  // Only expose GitHub helpers if the GitHub App is configured.
  if (githubAppConfigured()) {
    const getGithubToken = defineTool<GetTokenArgs>({
      name: "get_github_token",
      description:
        "Get a short-lived GitHub token for the task's repo. Use it to configure git credentials " +
        "before pushing: run `git remote set-url origin https://x-access-token:<token>@github.com/<org>/<repo>.git`",
      parameters: {
        type: "object",
        properties: {
          orgRepo: { type: "string", description: "The repo in org/repo format, e.g. acme/platform" },
        },
        required: ["orgRepo"],
      },
      handler: async (args, ctx: ToolContext) => {
        try {
          // Always mint for THIS task's repo, never an arbitrary one the model
          // names — otherwise a worker could obtain push tokens for any repo the
          // GitHub App is installed on. Reject mismatches so the agent notices.
          const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
          if (!task?.repo) return { error: "task repo not found" };
          if (args.orgRepo && args.orgRepo !== task.repo) {
            return { error: `token is scoped to ${task.repo}, not ${args.orgRepo}` };
          }
          const token = await mintInstallationToken(task.repo);
          return { token };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "failed to mint token" };
        }
      },
    });
    tools.push(getGithubToken);

    const createGithubPr = defineTool<CreateGithubPrArgs>({
      name: "create_github_pr",
      description:
        "Create a GitHub pull request for this task. Uses the card creator's linked GitHub account when available; " +
        "falls back to the Manta GitHub App when no creator GitHub exists. " +
        PR_TITLE_GUIDANCE,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: PR_TITLE_GUIDANCE },
          body: { type: "string" },
          head: { type: "string", description: "Head branch name, e.g. manta/my-task" },
          base: { type: "string", description: "Base branch name, e.g. main" },
        },
        required: ["title", "head", "base"],
      },
      handler: async (args, ctx: ToolContext) => {
        try {
          const task = await tasks.get({ workspaceId: ctx.workspaceId }, taskId);
          if (!task?.repo) return { error: "task repo not found" };
          const userToken = await githubUserTokenStatusForTask(task);
          const tokenSource = githubPrTokenSourceForTask(task, userToken);
          logger.info("creating GitHub PR", { taskId, repo: task.repo, tokenSource });
          const token = userToken.token ?? await mintInstallationToken(task.repo);
          const pr = await createPr({
            orgRepo: task.repo,
            token,
            title: args.title,
            body: appendTaskTranscriptLink(args.body, ctx.workspaceId, taskId),
            head: args.head,
            base: args.base,
          });
          await routeNonEngineerPrReview({ task, orgRepo: task.repo, token, prNumber: pr.number, prUrl: pr.html_url, base: args.base }).catch((err) => {
            logger.warn("failed to route non-engineer PR review", { taskId, prUrl: pr.html_url, err: err instanceof Error ? err.message : String(err) });
          });
          return { pr: { prNumber: pr.number, prUrl: pr.html_url, prTitle: pr.title, branch: args.head } };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "failed to create PR" };
        }
      },
    });
    tools.push(createGithubPr);
  }

  return tools;
}
