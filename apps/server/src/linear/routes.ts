// Linear integration routes, mounted at /api/linear.
//
// Linear is a per-workspace, bring-your-own-app connector. Each workspace:
//   1. Registers its own Linear OAuth app (actor=app) in its own Linear.
//   2. Saves that app's clientId/clientSecret/webhookSecret into Manta
//      (POST /app-config) — stored encrypted in WorkspaceSecret(linear_app).
//   3. Connects via OAuth (/oauth/connect → /oauth/callback), which mints an
//      actor=app token (stored as WorkspaceSecret(linear_oauth)) so the bot
//      posts as its own identity (no seat consumed), and auto-links Manta users
//      to Linear members by email.
//
// Webhooks arrive at a per-workspace path /webhook/:workspaceId so we know which
// workspace's signing secret to verify against. Verified issue/label events are
// summarized into the brain inbox; comments only wake Manta when they explicitly
// mention the Linear bot.
//
// Per-workspace URLs to register in the Linear app (one-time, manual):
//   OAuth redirect URI → …/api/linear/oauth/callback   (same for every workspace)
//   Webhook URL        → …/api/linear/webhook/<workspaceId>

import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { prisma, workspaces, workspaceSecrets, repos, users, agentSessions, slack, tasks, type SlackBot } from "@manta/db";
import { inbox } from "@manta/db";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import type { Sessions } from "../auth/session.ts";
import { createLogger } from "../logger.ts";
import { encrypt, decrypt } from "../secrets/crypto.ts";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import { runBrainTurn } from "../brain/runner.ts";
import { taskCreationConfirmation } from "../brain/task-confirmations.ts";
import { brainBackendIdFor, firstAvailableCardBackendForUser } from "../models/service.ts";
import {
  linearViewer,
  linearTokenForWorkspace,
  linearAppTokenForWorkspace,
  listLinearMembers,
  listLinearProjects,
  listLinearTeams,
  listLinearIssuesAssignedTo,
  listLinearWorkflowStates,
  listLinearIssuesByState,
  moveLinearIssueToState,
  commentOnIssue,
  type LinearSecretMeta,
} from "./client.ts";
import { getLinearAppConfig, setLinearAppConfig, clearLinearAppConfig } from "./app-config.ts";
import { syncLinearMembers } from "./members.ts";
import { spawnWorker } from "../worker/dispatch.ts";

const logger = createLogger("Manta:Linear");

// Scopes: read/write for issues+comments, plus app:* so the bot can be mentioned
// and assigned. actor=app makes mutations post as the app's bot identity.
const LINEAR_SCOPES = "read,write,issues:create,comments:create,app:assignable,app:mentionable";
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const OAUTH_STATE_COOKIE = "manta_linear_oauth";
const SLACK_LINEAR_REQUEST_MARKER = "manta:slack-request";

interface SlackLinearRequestOrigin {
  slackUserId: string;
  slackBotId: string;
  channel?: string;
  threadTs?: string;
}

export interface LinearBrainDeps {
  brainBackend: AgentBackend;
  brainBackendId: string;
  brainTools: ToolDefinition[];
  defaultBrainPrompt: string;
}

export interface LinearRoutesDeps {
  sessions?: Sessions;
  /** Web origin to build the OAuth redirect URI and bounce browsers back to. */
  webAppUrl: string;
  secureCookies: boolean;
  /** When present, @Manta mentions in Linear comments trigger immediate brain turns. */
  brain?: LinearBrainDeps;
}

export function filterLinearIssuesWithoutOwnedCards<T extends { identifier: string }>(
  issues: T[],
  trackedTasks: Array<{ linearIssueIdentifier: string | null; createdBy: string | null }>,
  userId: string,
): T[] {
  const ownedIdentifiers = new Set(
    trackedTasks
      .filter((task) => task.createdBy === userId)
      .map((task) => task.linearIssueIdentifier)
      .filter((identifier): identifier is string => Boolean(identifier)),
  );
  return issues.filter((issue) => !ownedIdentifiers.has(issue.identifier));
}

function verifyLinearSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const expected = Buffer.from(hmac);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// Build a concise plain-text summary of a Linear event for the brain inbox.
function summarizeEvent(type: string, action: string, data: Record<string, unknown>): string {
  const title = (data.title ?? data.name ?? data.body ?? "(no title)") as string;
  const identifier = (data.identifier ?? "") as string;
  const url = (data.url ?? "") as string;
  const assigneeName = ((data.assignee as Record<string, unknown> | undefined)?.name ?? "") as string;
  const stateName = ((data.state as Record<string, unknown> | undefined)?.name ?? "") as string;

  const parts: string[] = [`[Linear] ${type} ${action}`];
  if (identifier) parts.push(`#${identifier}`);
  parts.push(`"${title.slice(0, 100)}"`);
  if (assigneeName) parts.push(`assigned to ${assigneeName}`);
  if (stateName) parts.push(`state: ${stateName}`);
  if (url) parts.push(url);
  return parts.join(" — ");
}

function slackRequestOriginFromDescription(description: string | undefined): SlackLinearRequestOrigin | null {
  if (!description) return null;
  const match = description.match(new RegExp(`<!--\\s*${SLACK_LINEAR_REQUEST_MARKER}\\s+(\\{[\\s\\S]*?\\})\\s*-->`));
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<SlackLinearRequestOrigin>;
    return parsed.slackUserId && parsed.slackBotId
      ? { slackUserId: parsed.slackUserId, slackBotId: parsed.slackBotId, ...(parsed.channel ? { channel: parsed.channel } : {}), ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}) }
      : null;
  } catch {
    return null;
  }
}

function isSlackRequestDoneState(state: Record<string, unknown> | undefined): boolean {
  const name = String(state?.name ?? "").trim().toLowerCase();
  const type = String(state?.type ?? "").trim().toLowerCase();
  return type === "completed" || name === "done" || name === "to verify";
}

function nestedId(value: unknown): string | undefined {
  return typeof (value as Record<string, unknown> | undefined)?.id === "string"
    ? ((value as Record<string, unknown>).id as string)
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasSlackMarker(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes("slack");
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSlackMarker);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    key.toLowerCase().includes("slack") || hasSlackMarker(nested),
  );
}

function isSlackActor(value: unknown): boolean {
  const actor = parseJsonObject(value);
  if (!actor) return false;
  const type = typeof actor.type === "string" ? actor.type.toLowerCase() : "";
  const subType = typeof actor.subType === "string" ? actor.subType.toLowerCase() : "";
  const name = typeof actor.name === "string" ? actor.name.toLowerCase() : "";
  return type === "slack" || subType === "slack" || name === "slack" || name === "linear for slack";
}

/** True when a Linear webhook was authored by Manta's Linear app identity. These
 * events are expected side effects of Manta tool calls (e.g. creating a Linear
 * issue from Slack), so they should not be summarized back into the brain inbox
 * as fresh external activity. */
export function isSelfAuthoredLinearWebhook(
  type: string,
  action: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  appUserId: string | undefined | null,
): boolean {
  if (!appUserId) return false;
  const authorIds = [nestedId(payload.actor)];
  // `data.creator` is immutable on issues; only use entity author fields for
  // create events. On updates, the top-level webhook actor is the source of
  // truth, otherwise a human update to an app-created issue would be dropped.
  if (action === "create") {
    if (type === "Comment") authorIds.push(nestedId(data.user));
    if (type === "Issue") authorIds.push(nestedId(data.creator));
  }
  return authorIds.includes(appUserId);
}

/** Linear can sync Slack thread replies into issue comments. If the Slack reply
 * also mentioned Manta, Slack Events will trigger the Slack path directly; the
 * mirrored Linear comment is just a bridge copy and must not trigger a second
 * brain turn or inbox item. */
export function isSlackSyncedLinearComment(
  type: string,
  action: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  if (type !== "Comment" || action !== "create") return false;
  return isSlackActor(payload.actor) || isSlackActor(data.botActor) || hasSlackMarker(data.syncedWith);
}

export function isLinearBrainInboxEvent(type: string, action: string): boolean {
  return (
    (type === "Issue" && (action === "create" || action === "update")) ||
    (type === "IssueLabel" && action === "create")
  );
}

async function notifySlackRequesterIfLinearDone(workspaceId: string, payload: Record<string, unknown>, updatedFrom: Record<string, unknown>, actorId?: string): Promise<void> {
  if (!("stateId" in updatedFrom) || !isSlackRequestDoneState(payload.state as Record<string, unknown> | undefined)) return;

  const origin = slackRequestOriginFromDescription(payload.description as string | undefined);
  if (!origin) return;

  if (actorId) {
    const requester = await users.bySlackUserId(origin.slackUserId).catch(() => null);
    if (requester?.linearUserId && requester.linearUserId === actorId) return;
  }

  const bot: SlackBot | null = await slack.getBot(workspaceId, origin.slackBotId);
  if (!bot?.enabled) return;

  const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
  const dm = await client.conversations.open({ users: origin.slackUserId }).catch(() => null);
  const channel = dm?.channel?.id;
  if (!channel) return;

  const title = String(payload.title ?? "your request");
  const identifier = String(payload.identifier ?? "");
  const url = String(payload.url ?? "");
  const stateName = String((payload.state as Record<string, unknown> | undefined)?.name ?? "done");
  const issue = [identifier, title].filter(Boolean).join(" — ");
  await client.chat.postMessage({
    channel,
    text: `:white_check_mark: ${issue || "Your Slack request"} is now ${stateName}.${url ? `\n${url}` : ""}`,
  });
}

function setStateCookie(c: Context, value: string, secure: boolean) {
  setCookie(c, OAUTH_STATE_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
}

interface LinearWorkspaceSettings extends workspaces.WorkspaceSettings {
  /** Linear project id → GitHub org/repo slug. */
  linearProjectRepos?: Record<string, string>;
  /** Linear team id → GitHub org/repo slug (fallback when issue has no project or project is unmapped). */
  linearTeamRepos?: Record<string, string>;
  /** Status-driven Linear automations configured from workspace settings. */
  linearStatusAutomations?: LinearStatusAutomation[];
  /** Remembered issue identifiers already queued by status automation batch runs. */
  linearStatusAutomationHistory?: Record<string, string[]>;
}

interface LinearStatusAutomation {
  id: string;
  enabled: boolean;
  statusId: string;
  statusName: string;
  teamId?: string;
  teamKey?: string;
  instructions: string;
}

async function linearSettings(workspaceId: string): Promise<LinearWorkspaceSettings> {
  return (await workspaces.getSettings(workspaceId)) as LinearWorkspaceSettings;
}

async function requireWorkspaceMember(c: Context, workspaceId: string) {
  if (!(await workspaces.isMember(c.get("userId"), workspaceId))) {
    return c.json({ error: "not_a_member" }, 403);
  }
  return null;
}

function normalizeAutomation(input: Partial<LinearStatusAutomation>): LinearStatusAutomation | null {
  const statusId = input.statusId?.trim();
  const statusName = input.statusName?.trim();
  const instructions = input.instructions?.trim();
  if (!statusId || !statusName || !instructions) return null;
  return {
    id: input.id?.trim() || statusId,
    enabled: input.enabled !== false,
    statusId,
    statusName,
    ...(input.teamId?.trim() ? { teamId: input.teamId.trim() } : {}),
    ...(input.teamKey?.trim() ? { teamKey: input.teamKey.trim() } : {}),
    instructions,
  };
}

function issueRepoFromMappings(settings: LinearWorkspaceSettings, issue: { project?: { id: string } | null; team?: { id: string } | null }, repoRows: Array<{ orgRepo: string }>): string | null {
  return (issue.project?.id ? settings.linearProjectRepos?.[issue.project.id] : undefined)
    ?? (issue.team?.id ? settings.linearTeamRepos?.[issue.team.id] : undefined)
    ?? repoRows[0]?.orgRepo
    ?? null;
}

async function createAndStartLinearAutomationWorker(input: {
  workspaceId: string;
  automation: LinearStatusAutomation;
  issueData: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const issueId = input.issueData.id as string | undefined;
  const identifier = input.issueData.identifier as string | undefined;
  if (!issueId || !identifier) return null;
  const [settings, repoRows, workerBackend] = await Promise.all([
    linearSettings(input.workspaceId),
    repos.list({ workspaceId: input.workspaceId }),
    firstAvailableCardBackendForUser(input.workspaceId),
  ]);
  const repo = issueRepoFromMappings(
    settings,
    {
      project: input.issueData.project as { id: string } | null | undefined,
      team: input.issueData.team as { id: string } | null | undefined,
    },
    repoRows,
  );
  if (!repo) {
    logger.warn("linear status automation skipped: no repo configured", { workspaceId: input.workspaceId, issue: identifier });
    return null;
  }
  const issueTitle = (input.issueData.title as string | undefined) ?? identifier;
  const issueUrl = (input.issueData.url as string | undefined) ?? "";
  const description = [
    `Linear issue ${identifier} entered the auto-handled status "${input.automation.statusName}"${input.automation.teamKey ? ` for ${input.automation.teamKey}` : ""}.`,
    issueUrl,
    "Run this validation/triage workflow in the local repo checkout. Use the worker Linear tools to comment, apply labels, or move statuses; do not depend on LINEAR_API_KEY being available in the shell.",
    `Configured instructions:\n${input.automation.instructions}`,
    ((input.issueData.description as string | undefined) ?? "").trim() && `Issue description:\n${((input.issueData.description as string | undefined) ?? "").trim()}`,
  ].filter(Boolean).join("\n\n");
  const task = await tasks.create({ workspaceId: input.workspaceId }, {
    name: `linear-${identifier.toLowerCase()}`,
    title: `Linear ${input.automation.statusName}: ${identifier} — ${issueTitle}`.slice(0, 140),
    description,
    kind: "agent",
    cardType: "investigation",
    cardStatus: "bot_working",
    type: "investigation",
    hidden: true,
    backgroundMode: "linear_status_automation",
    repo,
    workerBackend,
    linearIssueIdentifier: identifier,
  });
  const stamped = await prisma.task.update({
    where: { id: task.id },
    data: { linearTriage: { statusAutomation: true, statusId: input.automation.statusId, statusName: input.automation.statusName, issueId } },
  });
  const claimed = await tasks.beginWork({ workspaceId: input.workspaceId }, stamped.id);
  if (claimed) spawnWorker(stamped, description);
  return { id: stamped.id };
}

/** Run a brain turn and post the response as a comment on the issue. */
async function runBrainAndReply(
  workspaceId: string,
  issueId: string,
  issueIdentifier: string | undefined,
  userMessage: string,
  userId: string | undefined,
  brainDeps: LinearBrainDeps,
  parentCommentId?: string,
): Promise<void> {
  const channel = `linear-${issueId}`;
  const [wsSettings, wsRecord, backendId, sessionKey, pendingItems, repoRows] = await Promise.all([
    workspaces.getSettings(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { brainPrompt: true } }),
    brainBackendIdFor(workspaceId, brainDeps.brainBackendId),
    agentSessions.getSessionKey(workspaceId, channel),
    inbox.pending(workspaceId, channel),
    repos.list({ workspaceId }),
  ]);
  const inboxItems = pendingItems.map((i) => ({
    id: i.id,
    body: i.body,
    source: i.source,
    createdAt: i.createdAt.getTime(),
  }));

  const result = await runBrainTurn({
    scope: { workspaceId },
    channel,
    userMessage,
    backend: brainDeps.brainBackend,
    backendId: wsSettings.defaultModel || backendId,
    tools: brainDeps.brainTools,
    promptParts: {
      basePrompt: [
        wsRecord?.brainPrompt?.trim() || brainDeps.defaultBrainPrompt,
        linearTurnPrompt(issueId, issueIdentifier),
      ].join("\n\n"),
      workspaceRepos: repoRows.filter((repo) => repo.enabled).map((repo) => ({ orgRepo: repo.orgRepo, defaultBranch: repo.defaultBranch })),
    },
    ...(userId ? { userId } : {}),
    ...(sessionKey ? { resumeFrom: sessionKey } : {}),
    onSession: (key) => agentSessions.upsertSessionKey(workspaceId, channel, key, "support"),
    ...(inboxItems.length ? { inbox: inboxItems } : {}),
  });

  await inbox.markConsumed(workspaceId, result.consumedInboxIds);

  const replyText = taskCreationConfirmation(result.createdTasks) ?? result.assistantText.trim();
  if (replyText) {
    const token = await linearAppTokenForWorkspace(workspaceId);
    if (token) await commentOnIssue(issueId, replyText, token, parentCommentId ? { parentId: parentCommentId } : undefined);
    else logger.warn("linear reply skipped: app OAuth token not connected", { workspaceId, issueId });
  }
}

function linearTurnPrompt(issueId: string, issueIdentifier: string | undefined): string {
  const issueRef = issueIdentifier || issueId;
  return [
    "## Current Linear issue",
    `This turn came from Linear issue ${issueRef}. Your final assistant response is automatically posted as a Linear comment, so do not also call comment_on_linear_issue for the same final reply. Use comment_on_linear_issue only for intentional extra status updates during this turn.`,
    `If you create a worker card for this Linear issue, pass linearIssueIdentifier: "${issueRef}" to create_task so the card stays linked to Linear and the worker can read the issue and post investigation results back.`,
  ].join("\n");
}

/** Build a "[Linear issue X-123 — "title" — url]" context prefix. */
function issueContextPrefix(identifier: string, title: string, url: string): string {
  return [identifier && `Linear issue ${identifier}`, title && `"${title}"`, url]
    .filter(Boolean)
    .join(" — ");
}

/** Fire a brain turn in response to an @Manta mention in a Linear comment. */
async function handleLinearMention(
  workspaceId: string,
  commentData: Record<string, unknown>,
  brainDeps: LinearBrainDeps,
): Promise<void> {
  const issue = (commentData.issue as Record<string, unknown> | undefined) ?? {};
  const issueId = issue.id as string | undefined;
  if (!issueId) {
    logger.warn("linear mention: missing issue id in comment payload", { workspaceId });
    return;
  }

  const linearUserId = (commentData.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const mantaUser = linearUserId ? await prisma.user.findFirst({ where: { linearUserId } }) : null;

  const rawBody = (commentData.body as string | undefined) ?? "";
  const commentText = rawBody.replace(/^@\S+\s*/u, "").trim() || rawBody;
  const prefix = issueContextPrefix(
    (issue.identifier as string | undefined) ?? "",
    (issue.title as string | undefined) ?? "",
    (issue.url as string | undefined) ?? "",
  );
  const userMessage = prefix ? `${prefix}\n\n${commentText}` : commentText;

  const parentCommentId = commentData.id as string | undefined;
  await runBrainAndReply(workspaceId, issueId, issue.identifier as string | undefined, userMessage, mantaUser?.id, brainDeps, parentCommentId);
}

/** Fire a brain turn when the Manta bot is assigned to a Linear issue. */
async function handleLinearAssignment(
  workspaceId: string,
  issueData: Record<string, unknown>,
  brainDeps: LinearBrainDeps,
): Promise<void> {
  const issueId = issueData.id as string | undefined;
  if (!issueId) {
    logger.warn("linear assignment: missing issue id in payload", { workspaceId });
    return;
  }

  const prefix = issueContextPrefix(
    (issueData.identifier as string | undefined) ?? "",
    (issueData.title as string | undefined) ?? "",
    (issueData.url as string | undefined) ?? "",
  );
  const description = ((issueData.description as string | undefined) ?? "").trim();
  const userMessage = [
    `I've been assigned to ${prefix || "a Linear issue"}.`,
    description && `Issue description:\n${description}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  await runBrainAndReply(workspaceId, issueId, issueData.identifier as string | undefined, userMessage, undefined, brainDeps);
}

async function handleLinearStatusAutomation(
  workspaceId: string,
  issueData: Record<string, unknown>,
  automation: LinearStatusAutomation,
): Promise<void> {
  await createAndStartLinearAutomationWorker({ workspaceId, issueData, automation });
}

export function createLinearRoutes(deps: LinearRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  const sessions = deps.sessions;

  // Gate a route on auth, returning 503 when auth isn't configured.
  const authGate = async (c: Context<{ Variables: AuthVars }>, next: () => Promise<void>) => {
    if (!sessions) return c.json({ error: "auth_not_configured" }, 503);
    return requireAuth(sessions)(c, next);
  };

  const redirectUri = `${deps.webAppUrl}/api/linear/oauth/callback`;

  // ── Webhook receiver (per-workspace; verified by that workspace's secret) ────

  app.post("/webhook/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const appCfg = await getLinearAppConfig(workspaceId);
    // No app config or no webhook secret → we can't verify; ack and ignore so
    // Linear stops retrying (and we never reveal whether the workspace exists).
    if (!appCfg?.webhookSecret) return c.json({ ok: true });

    const rawBody = await c.req.text();
    const signature = c.req.header("Linear-Signature");
    if (!verifyLinearSignature(rawBody, signature, appCfg.webhookSecret)) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // Reject stale/replayed payloads. Linear stamps each delivery with
    // webhookTimestamp (ms epoch); a captured-and-replayed body keeps its old
    // timestamp, so anything beyond a minute old is rejected.
    const ts = Number(payload.webhookTimestamp);
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > 60_000) {
      logger.warn("linear webhook timestamp stale — rejecting", { ts });
      return c.json({ error: "stale_timestamp" }, 401);
    }

    const type = (payload.type as string | undefined) ?? "";
    const action = (payload.action as string | undefined) ?? "";
    const data = (payload.data as Record<string, unknown> | undefined) ?? {};
    // updatedFrom holds the previous values of changed fields on update events.
    const updatedFrom = (payload.updatedFrom as Record<string, unknown> | undefined) ?? {};
    const actorId = (payload.actor as Record<string, unknown> | undefined)?.id as string | undefined;

    const inboxInteresting = isLinearBrainInboxEvent(type, action);

    // Several webhook branches need the bot identity. Load it up front when a
    // brain-visible path may use it, including the inbox summary filter below.
    const needsBotMeta =
      inboxInteresting ||
      (deps.brain &&
        ((type === "Comment" && action === "create") ||
          (type === "Issue" && action === "update" && "assigneeId" in updatedFrom)));

    const botMeta = needsBotMeta
      ? ((await workspaceSecrets.get({ workspaceId }, "linear_oauth"))?.meta ?? {}) as LinearSecretMeta
      : null;

    const selfAuthored = isSelfAuthoredLinearWebhook(type, action, payload, data, botMeta?.appUserId);
    const slackSyncedComment = isSlackSyncedLinearComment(type, action, payload, data);

    if (inboxInteresting && !selfAuthored) {
      const body = summarizeEvent(type, action, data);
      await inbox.push(workspaceId, { channel: "brain", body, source: "linear" });
      logger.info("linear event → brain inbox", { type, action, workspaceId });
    } else if (inboxInteresting && selfAuthored) {
      logger.debug("linear self-authored event skipped for brain inbox", { type, action, workspaceId });
    } else if (slackSyncedComment) {
      logger.debug("linear Slack-synced comment skipped", { type, action, workspaceId });
    }

    // When a comment @mentions the bot, trigger the brain immediately instead of
    // waiting for the next user-initiated chat turn.
    if (type === "Comment" && action === "create" && deps.brain && botMeta) {
      const commentAuthorId = (data.user as Record<string, unknown> | undefined)?.id as string | undefined;
      const commentBody = (data.body as string | undefined) ?? "";
      // Skip the bot's own comments to avoid reply loops.
      const isSelf = botMeta.appUserId && commentAuthorId === botMeta.appUserId;
      const isMentioned = botMeta.botName && commentBody.toLowerCase().includes(`@${botMeta.botName.toLowerCase()}`);
      if (!isSelf && !slackSyncedComment && isMentioned) {
        logger.info("linear @mention detected — triggering brain", { workspaceId });
        void handleLinearMention(workspaceId, data, deps.brain).catch((err) =>
          logger.warn("linear mention handler failed", { workspaceId, err }),
        );
      }
    }

    // When the issue is assigned to the bot, trigger the brain immediately.
    if (type === "Issue" && action === "update" && deps.brain && botMeta) {
      const newAssigneeId = (data.assignee as Record<string, unknown> | undefined)?.id as string | undefined;
      const assigneeChanged = "assigneeId" in updatedFrom;
      if (!selfAuthored && assigneeChanged && newAssigneeId && newAssigneeId === botMeta.appUserId) {
        logger.info("linear assigned to bot — triggering brain", { workspaceId });
        void handleLinearAssignment(workspaceId, data, deps.brain).catch((err) =>
          logger.warn("linear assignment handler failed", { workspaceId, err }),
        );
      }
    }

    if (type === "Issue" && action === "update" && !selfAuthored && "stateId" in updatedFrom) {
      const state = data.state as Record<string, unknown> | undefined;
      const stateId = state?.id as string | undefined;
      const teamId = (data.team as Record<string, unknown> | undefined)?.id as string | undefined;
      if (stateId) {
        const settings = await linearSettings(workspaceId);
        const automation = (settings.linearStatusAutomations ?? []).find((item) =>
          item.enabled && item.statusId === stateId && (!item.teamId || item.teamId === teamId),
        );
        if (automation) {
          logger.info("linear status automation matched — spawning worker", { workspaceId, statusId: stateId, issue: data.identifier });
          void handleLinearStatusAutomation(workspaceId, data, automation).catch((err) =>
            logger.warn("linear status automation failed", { workspaceId, err }),
          );
        }
      }
    }

    if (type === "Issue" && action === "update") {
      void notifySlackRequesterIfLinearDone(workspaceId, data, updatedFrom, actorId).catch((err) =>
        logger.warn("linear done Slack DM failed", { workspaceId, err }),
      );
    }

    // New issues often introduce a new contributor/assignee — refresh the
    // Manta↔Linear member links in the background (bounded to the rarer "create"
    // path so we don't hit the API on every comment).
    if (type === "Issue" && action === "create") {
      void syncLinearMembers(workspaceId).catch((err) =>
        logger.warn("background member sync failed", { workspaceId, err }),
      );
    }

    return c.json({ ok: true });
  });

  // ── App credentials: save / inspect / clear ─────────────────────────────────

  app.post("/app-config", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      ws?: string;
      clientId?: string;
      clientSecret?: string;
      webhookSecret?: string;
    };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    if (!body.clientId?.trim() || !body.clientSecret?.trim()) {
      return c.json({ error: "clientId and clientSecret required" }, 400);
    }
    await setLinearAppConfig(ws, {
      clientId: body.clientId.trim(),
      clientSecret: body.clientSecret.trim(),
      ...(body.webhookSecret?.trim() ? { webhookSecret: body.webhookSecret.trim() } : {}),
    });
    return c.json({ ok: true });
  });

  // Remove app credentials AND any active connection (full reset).
  app.delete("/app-config", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    await revokeAndForget(ws);
    await clearLinearAppConfig(ws);
    return c.json({ ok: true });
  });

  // ── OAuth connect: kick off (actor=app) ─────────────────────────────────────
  app.get("/oauth/connect", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const appCfg = await getLinearAppConfig(ws);
    if (!appCfg) return c.json({ error: "linear_app_not_configured" }, 400);

    const nonce = randomBytes(16).toString("hex");
    setStateCookie(c, nonce, deps.secureCookies);
    const state = `${nonce}.${ws}`;
    const url =
      `${LINEAR_AUTHORIZE_URL}?client_id=${encodeURIComponent(appCfg.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&scope=${encodeURIComponent(LINEAR_SCOPES)}` +
      `&state=${encodeURIComponent(state)}&actor=app`;
    return c.redirect(url);
  });

  // ── OAuth callback: exchange code, store token, link members ─────────────────
  app.get("/oauth/callback", authGate, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    const expected = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

    const [nonce, ws] = state.split(".");
    if (!code || !nonce || !ws || nonce !== expected) {
      return c.redirect(`${deps.webAppUrl}/?linear=error`);
    }
    if (!(await workspaces.isMember(c.get("userId"), ws))) {
      return c.redirect(`${deps.webAppUrl}/?linear=error`);
    }
    const appCfg = await getLinearAppConfig(ws);
    if (!appCfg) return c.redirect(`${deps.webAppUrl}/?linear=error`);

    try {
      const tokenRes = await fetch(LINEAR_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          redirect_uri: redirectUri,
          client_id: appCfg.clientId,
          client_secret: appCfg.clientSecret,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      const accessToken = tokenJson.access_token;
      if (!accessToken) throw new Error("no access_token");

      // Identify the org (for webhook routing/marker) and the bot's display name.
      const { viewer, organization } = await linearViewer(accessToken);
      const organizationId = organization?.id;
      if (!organizationId) throw new Error("could not resolve Linear organization");

      const meta: LinearSecretMeta = {
        refreshToken: tokenJson.refresh_token,
        expiresAt: tokenJson.expires_in ? Date.now() + tokenJson.expires_in * 1000 : undefined,
        organizationId,
        organizationName: organization?.name,
        appUserId: viewer?.id,
        botName: viewer?.name,
      };
      await workspaceSecrets.upsert({ workspaceId: ws }, "linear_oauth", encrypt(accessToken), meta);
      await prisma.workspaceIdentity.upsert({
        where: { provider_externalId: { provider: "linear", externalId: organizationId } },
        create: { workspaceId: ws, provider: "linear", externalId: organizationId },
        update: { workspaceId: ws },
      });

      // Auto-associate Manta users with Linear members by email.
      void syncLinearMembers(ws).catch((err) => logger.warn("member sync after connect failed", { ws, err }));

      logger.info("linear connected", { ws, organizationId, bot: viewer?.name });
      return c.redirect(`${deps.webAppUrl}/?linear=connected`);
    } catch (err) {
      logger.warn("linear oauth callback failed", { err });
      return c.redirect(`${deps.webAppUrl}/?linear=error`);
    }
  });

  // ── Connection status ───────────────────────────────────────────────────────
  app.get("/status", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);

    const [appCfg, stored, user] = await Promise.all([
      getLinearAppConfig(ws),
      workspaceSecrets.get({ workspaceId: ws }, "linear_oauth"),
      users.byId(c.get("userId")),
    ]);
    const meta = (stored?.meta ?? {}) as LinearSecretMeta;
    return c.json({
      appConfigured: Boolean(appCfg),
      clientId: appCfg?.clientId ?? null,
      hasWebhookSecret: Boolean(appCfg?.webhookSecret),
      connected: Boolean(stored),
      organization: stored ? meta.organizationName ?? null : null,
      botName: stored ? meta.botName ?? null : null,
      myLinearUser: user?.linearUserId ? { id: user.linearUserId, name: user.linearName ?? null } : null,
      // Per-workspace webhook URL to paste into the Linear app's webhook settings.
      webhookUrl: `${deps.webAppUrl}/api/linear/webhook/${ws}`,
      redirectUri,
    });
  });

  app.get("/automation", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    const settings = await linearSettings(ws);
    const states = token ? await listLinearWorkflowStates(token) : [];
    return c.json({
      automations: settings.linearStatusAutomations ?? [],
      history: settings.linearStatusAutomationHistory ?? {},
      states,
    });
  });

  app.put("/automation", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; automations?: Array<Partial<LinearStatusAutomation>> };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    const memberError = await requireWorkspaceMember(c, ws);
    if (memberError) return memberError;
    const automations = (body.automations ?? []).map(normalizeAutomation).filter((item): item is LinearStatusAutomation => Boolean(item));
    await workspaces.updateSettings(ws, { linearStatusAutomations: automations } as Partial<LinearWorkspaceSettings>);
    return c.json({ automations });
  });

  app.post("/automation/batch", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; statusId?: string; limit?: number };
    const ws = body.ws;
    if (!ws || !body.statusId) return c.json({ error: "ws and statusId required" }, 400);
    const memberError = await requireWorkspaceMember(c, ws);
    if (memberError) return memberError;
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ error: "linear_not_connected" }, 400);
    const settings = await linearSettings(ws);
    const automation = (settings.linearStatusAutomations ?? []).find((a) => a.statusId === body.statusId);
    if (!automation) return c.json({ error: "automation_not_found" }, 404);
    const limit = Math.min(Math.max(body.limit ?? 20, 1), 100);
    const candidateIssues = await listLinearIssuesByState(body.statusId, { limit: 250 }, token);
    const repoRows = await repos.list({ workspaceId: ws });
    const candidateRepo = new Map(candidateIssues.map((issue) => [issue.identifier, issueRepoFromMappings(settings, issue, repoRows)]));
    if (!Array.from(candidateRepo.values()).some(Boolean)) return c.json({ error: "no_repo_configured" }, 400);
    const workerBackend = await firstAvailableCardBackendForUser(ws);
    const createdTasks = await prisma.$transaction(async (tx) => {
      // Serialize concurrent batch runs against this workspace: the automation
      // history below is a read-modify-write, so two runs racing would create
      // duplicate cards for the same Linear issues. SQLite has no `SELECT … FOR
      // UPDATE`; an immediate write takes the transaction's write lock and gives
      // the same serialization.
      await tx.workspace.update({ where: { id: ws }, data: { updatedAt: new Date() } });
      const row = await tx.workspace.findUnique({ where: { id: ws }, select: { settings: true } });
      const lockedSettings = ((row?.settings as LinearWorkspaceSettings | null) ?? {}) as LinearWorkspaceSettings;
      const history = lockedSettings.linearStatusAutomationHistory ?? {};
      const seen = new Set(history[body.statusId!] ?? []);
      const selectedIssues = candidateIssues.filter((issue) => !seen.has(issue.identifier) && candidateRepo.get(issue.identifier)).slice(0, limit);
      if (selectedIssues.length === 0) return [];
      const identifiers = selectedIssues.map((issue) => issue.identifier);
      const byRepo = new Map<string, typeof selectedIssues>();
      for (const issue of selectedIssues) {
        const repo = candidateRepo.get(issue.identifier);
        if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), issue]);
      }
      const taskResults: Array<{ id: string; taskNumber: number | null; repo: string; identifiers: string[]; description: string }> = [];
      for (const [repo, repoIssues] of byRepo) {
        const repoIdentifiers = repoIssues.map((issue) => issue.identifier);
        const description = [
          `Run the Linear status automation batch for ${automation.statusName}.`,
          `Configured instructions:\n${automation.instructions}`,
          `Process only this batch of ${repoIssues.length} issues for ${repo}; do not expand beyond it. For each issue, use get_linear_issue before acting and leave a clear audit trail in Linear when appropriate.`,
          repoIdentifiers.map((id) => `- ${id}`).join("\n"),
        ].join("\n\n");
        const count = await tx.task.count({ where: { workspaceId: ws, repo } });
        const task = await tx.task.create({
          data: {
            id: tasks.newTaskId(),
            workspaceId: ws,
            name: `linear-${Date.now().toString(36)}-${taskResults.length + 1}`,
            title: `Linear batch: ${automation.statusName}`,
            description,
            kind: "agent",
            cardType: "investigation",
            cardStatus: "bot_working",
            type: "investigation",
            hidden: true,
            backgroundMode: "linear_status_automation",
            repo,
            workerBackend,
            workerActive: true,
            workerStatus: "running",
            taskNumber: count + 1,
            linearTriage: { statusAutomation: true, statusId: automation.statusId, statusName: automation.statusName, batch: true },
          },
        });
        taskResults.push({ id: task.id, taskNumber: task.taskNumber, repo, identifiers: repoIdentifiers, description });
      }
      const nextHistory = { ...history, [body.statusId!]: Array.from(new Set([...(history[body.statusId!] ?? []), ...identifiers])).slice(-5000) };
      await tx.workspace.update({ where: { id: ws }, data: { settings: { ...lockedSettings, linearStatusAutomationHistory: nextHistory } as object } });
      return taskResults;
    });
    const identifiers = createdTasks.flatMap((task) => task.identifiers);
    const skippedKnown = candidateIssues.length - identifiers.length;
    if (createdTasks.length === 0) return c.json({ queued: 0, skippedKnown, identifiers: [], taskId: null, taskIds: [] });
    for (const task of createdTasks) {
      const row = await prisma.task.findUnique({ where: { id: task.id } });
      if (row) spawnWorker(row, task.description, { messageAlreadyPersisted: false });
    }
    return c.json({ queued: identifiers.length, skippedKnown, identifiers, taskId: createdTasks[0]?.id ?? null, taskIds: createdTasks.map((task) => task.id), tasks: createdTasks.map(({ description, ...task }) => task) });
  });

  app.post("/automation/move-stale", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; fromStatusId?: string; toStatusId?: string; olderThanMonths?: number; limit?: number };
    const ws = body.ws;
    if (!ws || !body.fromStatusId || !body.toStatusId) return c.json({ error: "ws, fromStatusId, and toStatusId required" }, 400);
    const memberError = await requireWorkspaceMember(c, ws);
    if (memberError) return memberError;
    const token = await linearAppTokenForWorkspace(ws);
    if (!token) return c.json({ error: "linear_app_oauth_not_connected" }, 400);
    const months = Math.min(Math.max(body.olderThanMonths ?? 1, 1), 60);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const candidates = await listLinearIssuesByState(body.fromStatusId, { limit: Math.min(Math.max(body.limit ?? 100, 1), 250) }, token);
    const stale = candidates.filter((issue) => new Date(issue.updatedAt).getTime() < cutoff.getTime());
    for (const issue of stale) await moveLinearIssueToState(issue.id, body.toStatusId, token);
    return c.json({ moved: stale.length, identifiers: stale.map((issue) => issue.identifier), cutoff: cutoff.toISOString() });
  });

  // ── Members, project→repo mappings, and the user's assigned backlog ─────────

  app.get("/members", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ members: [] });
    const members = await listLinearMembers(token);
    return c.json({ members: members.map((m) => ({ id: m.id, name: m.name, email: m.email })) });
  });

  app.put("/me", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; linearUserId?: string | null };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ error: "linear_not_connected" }, 400);

    const linearUserId = body.linearUserId?.trim() || null;
    if (!linearUserId) {
      await prisma.user.update({ where: { id: c.get("userId") }, data: { linearUserId: null, linearName: null } });
      return c.json({ ok: true });
    }
    const member = (await listLinearMembers(token)).find((m) => m.id === linearUserId);
    if (!member) return c.json({ error: "linear_member_not_found" }, 404);
    try {
      await users.setLinear(c.get("userId"), { linearUserId: member.id, linearName: member.name });
      return c.json({ ok: true });
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        return c.json({ error: "linear_user_already_linked" }, 409);
      }
      throw err;
    }
  });

  app.get("/projects", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ projects: [], mappings: {} });
    const [projects, settings] = await Promise.all([listLinearProjects(token), linearSettings(ws)]);
    return c.json({ projects, mappings: settings.linearProjectRepos ?? {} });
  });

  app.put("/project-mappings", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; mappings?: Record<string, string | null> };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    const memberError = await requireWorkspaceMember(c, ws);
    if (memberError) return memberError;
    const repoList = await repos.list({ workspaceId: ws });
    const allowedRepos = new Set(repoList.map((r) => r.orgRepo));
    const clean: Record<string, string> = {};
    for (const [projectId, orgRepo] of Object.entries(body.mappings ?? {})) {
      const key = projectId.trim();
      if (!key || !orgRepo) continue;
      if (!allowedRepos.has(orgRepo)) return c.json({ error: `unknown_repo:${orgRepo}` }, 400);
      clean[key] = orgRepo;
    }
    await workspaces.updateSettings(ws, { linearProjectRepos: clean } as Partial<LinearWorkspaceSettings>);
    return c.json({ mappings: clean });
  });

  app.get("/teams", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ teams: [], mappings: {} });
    const [teams, settings] = await Promise.all([listLinearTeams(token), linearSettings(ws)]);
    return c.json({ teams, mappings: settings.linearTeamRepos ?? {} });
  });

  app.put("/team-mappings", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string; mappings?: Record<string, string | null> };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    const memberError = await requireWorkspaceMember(c, ws);
    if (memberError) return memberError;
    const repoList = await repos.list({ workspaceId: ws });
    const allowedRepos = new Set(repoList.map((r) => r.orgRepo));
    const clean: Record<string, string> = {};
    for (const [teamId, orgRepo] of Object.entries(body.mappings ?? {})) {
      const key = teamId.trim();
      if (!key || !orgRepo) continue;
      if (!allowedRepos.has(orgRepo)) return c.json({ error: `unknown_repo:${orgRepo}` }, 400);
      clean[key] = orgRepo;
    }
    await workspaces.updateSettings(ws, { linearTeamRepos: clean } as Partial<LinearWorkspaceSettings>);
    return c.json({ mappings: clean });
  });

  app.get("/my-issues", authGate, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, ws))) return c.json({ error: "not_a_member" }, 403);
    const token = await linearTokenForWorkspace(ws);
    if (!token) return c.json({ issues: [], needsLinearUser: false, connected: false });
    const user = await users.byId(userId);
    if (!user?.linearUserId) {
      // Best-effort auto-link on demand in case the user joined after OAuth connect.
      await syncLinearMembers(ws).catch((err) => logger.warn("member sync before my-issues failed", { ws, err }));
    }
    const linked = (await users.byId(userId))?.linearUserId;
    if (!linked) return c.json({ issues: [], needsLinearUser: true, connected: true });

    const [issues, settings] = await Promise.all([
      listLinearIssuesAssignedTo(linked, { limit: 75 }, token),
      linearSettings(ws),
    ]);
    const tracked = await prisma.task.findMany({
      where: {
        workspaceId: ws,
        archivedAt: null,
        linearIssueIdentifier: { in: issues.map((issue) => issue.identifier) },
      },
      select: { linearIssueIdentifier: true, createdBy: true },
    });
    const projectMappings = settings.linearProjectRepos ?? {};
    const teamMappings = settings.linearTeamRepos ?? {};
    return c.json({
      issues: filterLinearIssuesWithoutOwnedCards(issues, tracked, userId).map((issue) => ({
        ...issue,
        repo: issue.project?.id
          ? (projectMappings[issue.project.id] ?? teamMappings[issue.team?.id ?? ""] ?? null)
          : (teamMappings[issue.team?.id ?? ""] ?? null),
      })),
      needsLinearUser: false,
      connected: true,
    });
  });

  // ── Disconnect: revoke token + forget connection (keep app credentials) ──────
  app.post("/disconnect", authGate, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    await revokeAndForget(ws);
    return c.json({ ok: true });
  });

  return app;
}

/** Best-effort revoke the workspace's Linear token, then drop the token + the
 * identity marker. Leaves the app credentials in place. */
async function revokeAndForget(ws: string): Promise<void> {
  const stored = await workspaceSecrets.get({ workspaceId: ws }, "linear_oauth");
  if (stored) {
    const token = decrypt(Buffer.from(stored.ciphertext));
    // Linear revocation: the token goes in the `token` form field. Do NOT also
    // send it in an Authorization header — combining the two is rejected (the
    // header form is legacy/backwards-compat only).
    await fetch(LINEAR_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch((err) => logger.warn("linear token revocation failed", { ws, err }));
  }
  await workspaceSecrets.remove({ workspaceId: ws }, "linear_oauth");
  await prisma.workspaceIdentity.deleteMany({ where: { workspaceId: ws, provider: "linear" } });
}
