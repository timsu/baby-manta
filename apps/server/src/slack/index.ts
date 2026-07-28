// Inbound Slack events, multi-bot. One Manta workspace ↔ one Slack workspace ↔
// many bots. Each bot is its own Slack app (own token + signing secret +
// operating instructions). A single /events endpoint routes by Slack's
// `api_app_id`: look up the bot, verify with THAT bot's signing secret, decrypt
// THAT bot's token, then run the turn as the resolved human (auto-linked by
// email) on their board.

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { workspaces, slack, users, repos, prisma, cardImages, agentSessions, type SlackBot, type SpawnCardPolicy, type Workspace } from "@manta/db";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import type { SlackDriver } from "../brain/tools.ts";
import { runBrainTurn } from "../brain/runner.ts";
import { taskCreationConfirmation } from "../brain/task-confirmations.ts";
import { brainBackendIdFor } from "../models/service.ts";
import { decrypt } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Slack");
const MAX_SLACK_THREAD_IMAGES = 10;
const MAX_SLACK_IMAGE_BYTES = 10 * 1024 * 1024;

export interface SlackDeps {
  brainBackend: AgentBackend;
  brainBackendId: string;
  defaultBrainPrompt: string;
  /** Build the brain tool set bound to one bot's Slack client (per request), so
   * reply_to_slack + create_task post with the right bot token. */
  brainToolsFactory: (slack: SlackDriver) => ToolDefinition[];
}

export function verifySignature(signingSecret: string, body: string, timestamp: string, signature: string): boolean {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret).update(baseString).digest();
  const expected = Buffer.from(`v0=${hmac.toString("hex")}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Whether a plain channel message should auto-trigger this bot. Empty allowlist
 * ⇒ never (mention/DM only). Skip messages that @-mention the bot — those also
 * fire `app_mention`, which handles them (dedupe). */
/** True when the message opens by @-mentioning someone OTHER than the bot — i.e.
 * it's directed at that person, not us, so we should stay out of it. Captures the
 * id up to a `|` label or closing `>` (Slack may send <@U123|name>). */
export function leadsWithForeignMention(text: string | undefined, botUserId?: string | null): boolean {
  const lead = (text ?? "").trimStart().match(/^<@([^|>]+)/);
  return Boolean(lead && lead[1] !== botUserId);
}

/** Why a channel message was NOT auto-responded, or `null` when it should be. Lets
 * the router log the exact gate that dropped a message, so a silent non-fire is
 * diagnosable instead of indistinguishable from the brain choosing to `ignore`. */
export type AutoRespondSkip = "bot_message" | "subtype" | "empty" | "not_allowlisted" | "mentions_bot" | "foreign_mention" | "thread_reply";

export function autoRespondSkipReason(
  bot: Pick<SlackBot, "autoRespondChannels" | "botUserId">,
  event: Record<string, unknown>,
): AutoRespondSkip | null {
  if (event.bot_id) return "bot_message";
  // `file_share` is how Slack delivers an ordinary channel message that carries
  // an attached file/screenshot. Support channels are full of pasted screenshots,
  // so we MUST treat it like a plain message; every other subtype (edits, joins,
  // channel_topic, …) is noise we stay out of.
  if (event.subtype && event.subtype !== "file_share") return "subtype";
  const text = (event.text as string | undefined) ?? "";
  const hasFiles = Array.isArray(event.files) && event.files.length > 0;
  // A bare screenshot with no caption is still a real report — the image is the
  // content. Only skip when there's neither text nor a file to act on.
  if (!text.trim() && !hasFiles) return "empty";
  if (!bot.autoRespondChannels.includes(event.channel as string)) return "not_allowlisted";
  // Messages that @-mention the bot fire app_mention instead — handled there.
  if (bot.botUserId && text.includes(`<@${bot.botUserId}>`)) return "mentions_bot";
  if (leadsWithForeignMention(text, bot.botUserId)) return "foreign_mention";
  // Auto-respond fires on top-level channel messages only. Once a thread exists,
  // we stay out of the back-and-forth unless explicitly re-summoned with @mention
  // (handled above by mentions_bot → app_mention). A reply carries a thread_ts
  // that differs from its own ts; a thread's root message has thread_ts === ts.
  const threadTs = event.thread_ts as string | undefined;
  if (threadTs && threadTs !== (event.ts as string | undefined)) return "thread_reply";
  return null;
}

export function shouldAutoRespond(
  bot: Pick<SlackBot, "autoRespondChannels" | "botUserId">,
  event: Record<string, unknown>,
): boolean {
  return autoRespondSkipReason(bot, event) === null;
}

/** A Slack-safe error message: a friendly line plus a truncated detail so an
 * operator can see what broke without digging through server logs. */
export function errorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `:warning: Something went wrong handling that request.\n\`${detail.slice(0, 300)}\``;
}

/** The card-policy instruction appended to a bot's system prompt. `never` forbids
 * cards entirely; `auto` lets the brain decide per request. */
/** Appended to the Slack system prompt: tell the brain to give the user a heads-up
 * before slow work, so the thread shows progress instead of dead air. */
export const progressSuffix =
  "\n\n## Progress updates\nYou're replying in a Slack thread. Before any step that takes more than a moment (answer_question, create_task, multi-step lookups), post a one-line heads-up first with reply_to_slack (e.g. \"On it — checking acme/web…\"), and feel free to post brief updates as you go. They land in this thread automatically — no need to specify a channel. Your FINAL answer is posted for you as your normal reply, so do NOT repeat it via reply_to_slack.";

/** Appended to the Slack system prompt: the bot lives in shared threads/channels
 * where plenty of talk isn't for it. Let it bow out silently instead of replying
 * to everything. */
export const relevanceSuffix =
  "\n\n## When NOT to reply\nYou're in a shared Slack space — much of what's said isn't for you. If a message isn't a request or question directed at you (people chatting, thinking out loud, talking to each other, or addressing someone else), call `ignore` and stop — say nothing. Only respond when there's a clear ask for you.";

/** Replaces relevanceSuffix on auto-respond channel turns. These are channels you
 * were explicitly added to and configured to watch, so the conservative "only if
 * it's clearly for you" rule does NOT apply — it would override the channel's own
 * triage instructions. This defers the "what to act on" decision to the
 * per-channel instructions above and only carves out pure noise. It intentionally
 * does NOT restate bug-filing/triage policy — that's configured per channel. */
export const autoChannelRelevanceSuffix =
  "\n\n## When to reply in this channel\nThis is a channel you were explicitly added to and configured to watch, so do NOT stay silent just because a message isn't addressed to you by name — messages here are your job. Follow the channel instructions above to decide what to act on, and when in doubt, lean toward acting (triage / answer) rather than ignoring. Only call `ignore` for messages that plainly need nothing from you — pure social chatter, acknowledgements (\"thanks!\", \"sounds good\"), or people coordinating among themselves with no question, problem, or request in play.";

export function cardPolicySuffix(policy: SpawnCardPolicy): string {
  return policy === "never"
    ? "\n\n## Card policy\nDo NOT create cards. Answer inline using your knowledge and read-only tools. Never call create_task."
    : "\n\n## Card policy\nCall create_task to spawn a worker card when the request needs writing to disk, changing code, running migrations, or other side effects — it runs on the requester's board and reports back when done. If the request is a longer read-only investigation that should finish asynchronously, use create_task with cardType `investigation` so the worker reports findings back and marks it Investigation Complete. For questions you can answer directly, reply inline without a card.";
}

export function unlinkedTaskCreationMessage(r: { email?: string }): string {
  return `I can help with most things here, but spawning a worker task needs a linked Manta account${r.email ? ` (I couldn't find one for ${r.email})` : ""}. Ask someone on the team to get you invited, and I'll be able to kick off tasks for you.`;
}

export function unlinkedSlackUserSuffix(r: { email?: string }): string {
  return `\n\n## Unlinked Slack user\nThis Slack user is not linked to a Manta account${r.email ? ` (${r.email})` : ""}. Help them fully anyway — answer their questions, investigate with answer_question, and file or comment on Linear issues as usual. The ONLY thing you cannot do for them is spawn a worker task/card (create_task): that runs on a Manta member's board, so it needs a linked account. This section overrides the card policy above ONLY for task spawning: if the request specifically requires creating a worker task/card, do the rest of what you can, then explain the limitation by replying exactly: "${unlinkedTaskCreationMessage(r)}"`;
}

// Manta serves unlinked Slack users (no Manta account, or a member of another
// workspace) with the FULL toolset — answering questions, filing/commenting on
// Linear issues, updating memory, etc. — because it's only useful if it can do
// things for people. The ONLY capability gated behind a linked account is
// SPAWNING worker tasks: those run a sandbox on a member's board (real compute
// and cost) and need an owner to attribute and route to. Everything else is
// allowed regardless of linking.
const TASK_SPAWN_TOOLS_BLOCKED_FOR_UNLINKED = new Set([
  "create_task",
  "resurrect_worker",
]);

export function restrictToolsForUnlinkedSlackUser(tools: ToolDefinition[], r: { email?: string }): ToolDefinition[] {
  const message = unlinkedTaskCreationMessage(r);
  return tools.map((tool) => {
    if (!TASK_SPAWN_TOOLS_BLOCKED_FOR_UNLINKED.has(tool.name)) return tool;
    return {
      ...tool,
      description: `${tool.description}\n\nUnavailable for unlinked Slack users. Return this message instead: ${message}`,
      handler: async () => ({ error: "manta_account_required", message }),
    } satisfies ToolDefinition;
  });
}

export function defaultRepoInstruction(defaultRepo: string | null, repoRows: { orgRepo: string; enabled: boolean }[]): string {
  if (!defaultRepo) return "";
  const repo = repoRows.find((r) => r.enabled && r.orgRepo === defaultRepo);
  if (!repo) return "";
  return `\n\n## Default repo\nWhen the user doesn't specify a repo, use ${repo.orgRepo} for create_task and answer_question. If the user names another configured repo, use that instead.`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsRepoName(message: string, repoName: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(repoName)}([^a-z0-9_-]|$)`, "i").test(message);
}

function withoutSlackMentions(message: string): string {
  return message.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " ");
}

export function mentionedRepos(
  userMessage: string,
  repoRows: { orgRepo: string; enabled: boolean }[],
): string[] {
  const enabled = repoRows.filter((r) => r.enabled);
  const repoNameCounts = new Map<string, number>();
  for (const repo of enabled) {
    const name = repo.orgRepo.split("/").pop()?.toLowerCase();
    if (name) repoNameCounts.set(name, (repoNameCounts.get(name) ?? 0) + 1);
  }

  const message = withoutSlackMentions(userMessage).toLowerCase();
  return enabled
    .filter((repo) => {
      if (message.includes(repo.orgRepo.toLowerCase())) return true;
      const name = repo.orgRepo.split("/").pop()?.toLowerCase();
      return Boolean(name && repoNameCounts.get(name) === 1 && containsRepoName(message, name));
    })
    .map((repo) => repo.orgRepo);
}

export function resolveSlackToolRepo(
  requestedRepo: string | undefined,
  defaultRepo: string | null,
  repoRows: { orgRepo: string; enabled: boolean }[],
  userMessage: string,
): string | undefined {
  const defaultEnabled = defaultRepo ? repoRows.find((r) => r.enabled && r.orgRepo === defaultRepo) : null;
  if (!defaultEnabled) return requestedRepo;

  const mentioned = mentionedRepos(userMessage, repoRows);
  if (mentioned.length === 1) return mentioned[0];
  if (mentioned.length > 1) return requestedRepo;
  return defaultEnabled.orgRepo;
}

type SlackThreadMessage = {
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  files?: SlackThreadFile[];
};

type SlackThreadFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  mantaUrl?: string;
};

function safeImageAlt(name: string | undefined): string {
  return (name || "image").replace(/[\]\n\r]/g, " ").trim() || "image";
}

export function formatSlackThreadMessages(messages: SlackThreadMessage[], currentTs?: string): string {
  return messages
    .filter((message) => {
      const hasText = typeof message.text === "string" && message.text.trim();
      const hasImages = message.files?.some((file) => file.mantaUrl);
      return hasText || hasImages;
    })
    .map((message) => {
      const author = message.user ? `<@${message.user}>` : message.username ?? (message.bot_id ? `<bot:${message.bot_id}>` : "unknown");
      const ts = message.ts ? ` ts=${message.ts}` : "";
      const marker = currentTs && message.ts === currentTs ? " (triggering message)" : "";
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const images = (message.files ?? [])
        .filter((file) => file.mantaUrl)
        .map((file) => `![${safeImageAlt(file.title ?? file.name)}](${file.mantaUrl})`);
      return `- ${author}${ts}${marker}: ${[text, ...images].filter(Boolean).join(" ")}`;
    })
    .join("\n");
}

export function slackUserMessageForTurn(
  userMessage: string,
  opts: { threadMessages?: string; hasFiles?: boolean },
): string {
  const text = userMessage.trim();
  const threadMessages = opts.threadMessages?.trim();
  if (!opts.hasFiles) return userMessage;

  if (threadMessages) {
    const context = `Slack thread context (including attachments):\n${threadMessages}`;
    return text ? `${text}\n\n${context}` : `Please triage this Slack message and its attachments.\n\n${context}`;
  }

  return text || "Please triage this Slack message and its attached files/screenshots.";
}

function withSlackDefaultRepo(
  tools: ToolDefinition[],
  defaultRepo: string | null,
  repoRows: { orgRepo: string; enabled: boolean }[],
  userMessage: string,
): ToolDefinition[] {
  const repoToolNames = new Set(["create_task", "answer_question"]);
  if (!defaultRepo || !repoRows.some((r) => r.enabled && r.orgRepo === defaultRepo)) return tools;

  return tools.map((tool) => {
    if (!repoToolNames.has(tool.name)) return tool;

    const parameters = { ...tool.parameters } as { required?: unknown; properties?: Record<string, unknown> };
    if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter((key) => key !== "repo");
    if (parameters.properties?.["repo"] && typeof parameters.properties["repo"] === "object") {
      parameters.properties = {
        ...parameters.properties,
        repo: {
          ...(parameters.properties["repo"] as Record<string, unknown>),
          description: `org/repo. Optional in Slack: defaults to ${defaultRepo} unless the user names another configured repo.`,
        },
      };
    }

    return {
      ...tool,
      parameters,
      handler: (args, ctx) => {
        const argObj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const repo = typeof argObj["repo"] === "string" ? argObj["repo"] : undefined;
        return tool.handler({ ...argObj, repo: resolveSlackToolRepo(repo, defaultRepo, repoRows, userMessage) }, ctx);
      },
    };
  });
}

export function createSlackRoutes(deps: SlackDeps): Hono {
  const app = new Hono();

  const botClient = (bot: SlackBot): WebClient =>
    new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));

  const slackDriver = (client: WebClient): SlackDriver => ({
    postMessage: async (channel, text, threadTs) => {
      await client.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    },
    getPermalink: async (channel, messageTs) => {
      const res = await client.chat.getPermalink({ channel, message_ts: messageTs });
      return typeof res.permalink === "string" ? res.permalink : null;
    },
  });

  async function fetchSlackThreadMessages(client: WebClient, channel: string, threadTs: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...((page.messages ?? []) as SlackThreadMessage[]));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages;
  }

  async function responseBodyBase64Limited(res: Response, maxBytes: number): Promise<string> {
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) throw new Error(`Slack image too large: ${contentLength} bytes`);
    if (!res.body) return Buffer.from(await res.arrayBuffer()).toString("base64");

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error(`Slack image too large: over ${maxBytes} bytes`);
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("base64");
  }

  async function storeSlackThreadImages(botToken: string, workspaceId: string, messages: SlackThreadMessage[]): Promise<void> {
    const storedBySlackFileId = new Map<string, string>();
    let storedCount = 0;
    for (const message of messages) {
      for (const file of message.files ?? []) {
        if (!file.mimetype?.startsWith("image/") || !(file.url_private_download || file.url_private)) continue;
        if (file.id && storedBySlackFileId.has(file.id)) {
          file.mantaUrl = storedBySlackFileId.get(file.id);
          continue;
        }
        if (storedCount >= MAX_SLACK_THREAD_IMAGES) return;
        try {
          const res = await fetch(file.url_private_download ?? file.url_private!, {
            headers: { Authorization: `Bearer ${botToken}` },
          });
          if (!res.ok) throw new Error(`Slack image download failed: ${res.status}`);
          const mimeType = res.headers.get("content-type")?.split(";")[0] || file.mimetype || "image/png";
          if (!mimeType.startsWith("image/")) throw new Error(`Slack file was not an image: ${mimeType}`);
          const data = await responseBodyBase64Limited(res, MAX_SLACK_IMAGE_BYTES);
          const image = await cardImages.createOrReuse({ workspaceId }, { mimeType, data });
          file.mantaUrl = `/api/images/${image.id}`;
          if (file.id) storedBySlackFileId.set(file.id, file.mantaUrl);
          storedCount++;
        } catch (err) {
          // Non-fatal: we just omit this one image from the thread context. The
          // common case is Slack returning an HTML auth/redirect page instead of
          // image bytes — expected noise, so log at debug, not warn.
          logger.debug("slack image fetch failed", { workspaceId, fileId: file.id, err });
        }
      }
    }
  }

  async function slackThreadContext(bot: SlackBot, client: WebClient, channel: string, threadTs: string, currentTs?: string): Promise<string | undefined> {
    try {
      const messages = await fetchSlackThreadMessages(client, channel, threadTs);
      await storeSlackThreadImages(decrypt(Buffer.from(bot.botTokenCipher)), bot.workspaceId, messages);
      const formatted = formatSlackThreadMessages(messages, currentTs);
      return formatted || undefined;
    } catch (err) {
      logger.warn("slack thread fetch failed", { channel, threadTs, err });
      return undefined;
    }
  }

  // base prompt = bot instructions (fallback workspace prompt) + the workspace's
  // repo list + a card policy derived from spawnCardPolicy.
  function composeBasePrompt(
    bot: SlackBot,
    ws: Workspace | null,
    repoRows: { orgRepo: string; defaultBranch: string; enabled: boolean }[],
    autoChannelId?: string,
  ): string {
    const base = bot.instructions.trim() || ws?.brainPrompt?.trim() || deps.defaultBrainPrompt;
    const channelInstructions = autoChannelId && bot.autoRespondChannels.includes(autoChannelId)
      ? ((bot.autoRespondChannelInstructions as Record<string, unknown> | null)?.[autoChannelId] as string | undefined)?.trim()
      : "";
    const channelSection = channelInstructions
      ? `\n\n## Auto-respond channel instructions\nThese instructions apply only because this auto-respond turn came from Slack channel ${autoChannelId}:\n${channelInstructions}`
      : "";
    // The brain orchestrates; it has no checkout of its own. Tell it which repos
    // exist and that the way to touch code is to spawn a worker (create_task),
    // which gets a real checkout — so it stops guessing it's "in" a repo.
    const enabled = repoRows.filter((r) => r.enabled);
    const repoSection = enabled.length
      ? `\n\n## Workspace repos\nYou have no local checkout. To ANSWER a question about a repo's code, call answer_question(repo, question) — a worker investigates in a real checkout and hands back the answer (no card). To CHANGE code, spawn a worker with create_task. Use one of these slugs:\n${enabled
          .map((r) => `- ${r.orgRepo} (default branch ${r.defaultBranch})`)
          .join("\n")}\nIf asked about a repo not in this list, say it isn't configured in this workspace rather than guessing.`
      : "\n\n## Workspace repos\nNo repos are configured in this workspace yet — add one in Settings → Repos before acting on code.";
    // On auto-respond channel turns, the bot was explicitly invited to watch and
    // triage — lower the bar for engaging. Mention/DM turns keep the conservative
    // "only if it's for you" guidance.
    const isAutoChannel = Boolean(autoChannelId && bot.autoRespondChannels.includes(autoChannelId));
    const relevance = isAutoChannel ? autoChannelRelevanceSuffix : relevanceSuffix;
    return base + channelSection + repoSection + defaultRepoInstruction(bot.defaultRepo, enabled) + progressSuffix + relevance + cardPolicySuffix(bot.spawnCardPolicy);
  }

  // Resolve the Slack user to a member of this bot's workspace, auto-linking by
  // email on first contact. Returns the Manta userId, or an error the caller
  // surfaces to the user in Slack.
  type Resolved = { userId: string } | { error: "unlinked" | "not_member"; email?: string };
  async function resolveMember(client: WebClient, bot: SlackBot, slackUserId: string): Promise<Resolved> {
    let user = await users.bySlackUserId(slackUserId);
    if (!user) {
      const info = await client.users.info({ user: slackUserId }).catch(() => null);
      const email = info?.user?.profile?.email ?? undefined;
      if (email) {
        user = await users.byEmail(email);
        // Best-effort link: a rare unique collision on slackUserId must not crash
        // the turn — we've already resolved the user by email.
        if (user) await users.setSlack(user.id, slackUserId).catch(() => {});
      }
      if (!user) return { error: "unlinked", ...(email ? { email } : {}) };
    }
    if (!(await workspaces.isMember(user.id, bot.workspaceId))) {
      return { error: "not_member", ...(user.email ? { email: user.email } : {}) };
    }
    return { userId: user.id };
  }

  // Resolve the human, run one brain turn on their board, and return the text to
  // post: the brain's answer, the unlinked-account guidance, a fallback when the
  // turn produced nothing, or `null` when the brain already replied via the
  // reply_to_slack tool (so the caller posts nothing). THROWS on a real failure —
  // the caller is responsible for surfacing that to Slack.
  async function runTurn(
    bot: SlackBot,
    client: WebClient,
    opts: {
      eventChannel: string;
      threadTs: string;
      mantaChannel: string;
      slackUserId: string;
      userMessage: string;
      repoResolutionMessage?: string;
      eventTs?: string;
      threadMessages?: string;
      autoChannelId?: string;
    },
  ): Promise<{ text: string | null; interimCount: number }> {
    // Count messages the brain/worker post mid-turn (reply_to_slack updates and
    // the question agent's progress notes both flow through this driver). The
    // final answer is posted by the handler, NOT through here — so a non-zero
    // count means interim messages exist and the final answer must go below them.
    let interimCount = 0;
    const base = slackDriver(client);
    const countingDriver: SlackDriver = {
      postMessage: async (channel, text, threadTs) => {
        interimCount++;
        await base.postMessage(channel, text, threadTs);
      },
      getPermalink: base.getPermalink,
    };

    const member = await resolveMember(client, bot, opts.slackUserId);
    // Both "unlinked" (no Manta account) and "not_member" (account exists, not in
    // this workspace) get the FULL toolset — answers, Linear writes, memory — so
    // Manta is actually useful to everyone in the Slack workspace. The single
    // exception is spawning a worker task/card (see
    // TASK_SPAWN_TOOLS_BLOCKED_FOR_UNLINKED): that runs real compute on a member's
    // board and needs a linked owner to attribute and route to.

    const ws = await workspaces.byId(bot.workspaceId);
    const repoRows = await repos.list({ workspaceId: bot.workspaceId });
    const membership =
      "error" in member
        ? null
        : await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId: member.userId, workspaceId: bot.workspaceId } },
            select: { personalMemory: true },
          });

    const unlinked = "error" in member ? member : null;
    const userId = "error" in member ? undefined : member.userId;
    const slackTools = withSlackDefaultRepo(deps.brainToolsFactory(countingDriver), bot.defaultRepo, repoRows, opts.repoResolutionMessage ?? opts.userMessage);
    const tools = unlinked ? restrictToolsForUnlinkedSlackUser(slackTools, unlinked) : slackTools;
    const threadMessages =
      opts.threadMessages ?? (opts.eventTs && opts.eventTs !== opts.threadTs ? await slackThreadContext(bot, client, opts.eventChannel, opts.threadTs, opts.eventTs) : undefined);

    // Use the workspace's configured brain model, not the server's ambient pick
    // (which in hosted mode resolves to an unusable IAM-derived Bedrock model).
    const [backendId, resumeFrom] = await Promise.all([
      brainBackendIdFor(bot.workspaceId, deps.brainBackendId),
      agentSessions.getSessionKey(bot.workspaceId, opts.mantaChannel),
    ]);
    const result = await runBrainTurn({
      scope: { workspaceId: bot.workspaceId },
      channel: opts.mantaChannel,
      userMessage: opts.userMessage,
      backend: deps.brainBackend,
      backendId,
      // reply_to_slack stays IN so the brain can post progress updates mid-turn;
      // it's bound to this thread via slackOrigin. The handler still owns the
      // FINAL answer (placeholder edit / trailing post), and the brain is told not
      // to repeat its final answer via the tool — so no duplicate.
      tools,
      ...(userId ? { userId } : {}),
      slackOrigin: {
        channel: opts.eventChannel,
        threadTs: opts.threadTs,
        slackUserId: opts.slackUserId,
        slackBotId: bot.id,
      },
      promptParts: {
        basePrompt: composeBasePrompt(bot, ws, repoRows, opts.autoChannelId) + (unlinked ? unlinkedSlackUserSuffix(unlinked) : ""),
        ...(ws?.teamMemory ? { teamMemory: ws.teamMemory } : {}),
        ...(membership?.personalMemory ? { personalMemory: membership.personalMemory } : {}),
        slackContext: {
          channel: opts.eventChannel,
          threadTs: opts.threadTs,
          user: opts.slackUserId,
          ...(threadMessages ? { threadMessages } : {}),
        },
      },
      ...(resumeFrom ? { resumeFrom } : {}),
      onSession: (key) => agentSessions.upsertSessionKey(bot.workspaceId, opts.mantaChannel, key, "support"),
    });

    // Why a turn produced (or didn't produce) a reply — the single most useful
    // signal when debugging "the bot saw it but stayed silent". `member` is one of
    // resolved / unlinked / not_member; `outcome` is the branch taken below.
    const memberState = "error" in member ? member.error : "resolved";
    const logOutcome = (outcome: string) =>
      logger.info("slack turn outcome", { channel: opts.eventChannel, autoChannel: Boolean(opts.autoChannelId), member: memberState, outcome, interimCount });

    // The brain decided this message wasn't for it — stay completely silent.
    const ignored = result.events.some((e) => e.type === "tool_use" && e.toolName === "ignore");
    if (ignored) {
      logOutcome("ignored");
      return { text: null, interimCount };
    }
    if (unlinked && result.events.some((e) => e.type === "tool_use" && TASK_SPAWN_TOOLS_BLOCKED_FOR_UNLINKED.has(e.toolName))) {
      logOutcome("task_spawn_blocked");
      return { text: unlinkedTaskCreationMessage(unlinked), interimCount };
    }
    const canonicalTaskReply = taskCreationConfirmation(result.createdTasks);
    if (canonicalTaskReply) {
      logOutcome("task_created");
      return { text: canonicalTaskReply, interimCount };
    }
    const text = result.assistantText.trim();
    if (text) {
      logOutcome("replied");
      return { text, interimCount };
    }
    // The brain may have answered by calling reply_to_slack instead of returning
    // text — in that case it already posted, so we add nothing.
    const repliedViaTool = result.events.some((e) => e.type === "tool_use" && e.toolName === "reply_to_slack");
    if (repliedViaTool) {
      logOutcome("replied_via_tool");
      return { text: null, interimCount };
    }
    logOutcome("empty");
    return { text: "I finished but didn't have anything to say back. Try rephrasing?", interimCount };
  }

  // Post a "Thinking…" placeholder, run the turn, then EDIT the placeholder into
  // the result — or into an error if the turn throws. Guarantees the user never
  // sees a dangling "Thinking…": every path resolves to a visible message.
  async function respondInThread(
    client: WebClient,
    channel: string,
    threadTs: string,
    run: () => Promise<{ text: string | null; interimCount: number }>,
  ): Promise<void> {
    let placeholderTs: string | undefined;
    try {
      const ph = await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Thinking…" });
      placeholderTs = ph.ts ?? undefined;
    } catch {
      // Couldn't post a placeholder; we'll still try to post the result below.
    }
    const dropPlaceholder = async () => {
      if (placeholderTs) await client.chat.delete({ channel, ts: placeholderTs }).catch(() => {});
    };
    const settle = async (text: string) => {
      if (placeholderTs) await client.chat.update({ channel, ts: placeholderTs, text });
      else await client.chat.postMessage({ channel, thread_ts: threadTs, text });
    };
    try {
      const { text, interimCount } = await run();
      if (text === null) {
        // Brain already replied via a tool — drop the placeholder so it's not orphaned.
        await dropPlaceholder();
        return;
      }
      if (interimCount > 0) {
        // Progress updates were posted below the placeholder; editing it in place
        // would strand the final answer ABOVE them. Drop it and post the answer
        // last so the thread reads in order.
        await dropPlaceholder();
        await client.chat.postMessage({ channel, thread_ts: threadTs, text });
      } else {
        await settle(text);
      }
    } catch (err) {
      logger.error("slack turn failed", { channel, err });
      await settle(errorMessage(err)).catch(() => {});
    }
  }

  // One brain turn per Slack conversation at a time. If the bot is tagged again
  // (or Slack redelivers the event) while a turn is already in flight for the
  // same conversation, don't start another — that would run two brain turns and
  // spin up duplicate workers for one thread. Keyed by the resolved Manta channel
  // (per bot, per thread/DM). In-memory: a process restart clears it, which is
  // fine (turns don't survive a restart anyway).
  const inFlightConversations = new Set<string>();
  async function withConversationLock(key: string, onBusy: () => Promise<void>, run: () => Promise<void>): Promise<void> {
    if (inFlightConversations.has(key)) {
      logger.info("slack turn skipped — conversation already in flight", { key });
      await onBusy().catch(() => {});
      return;
    }
    inFlightConversations.add(key);
    try {
      await run();
    } finally {
      inFlightConversations.delete(key);
    }
  }

  /** Best-effort "received, but I'm busy" signal on the triggering message. */
  const busyReaction = (client: WebClient, channel: string, ts: string | undefined): Promise<void> =>
    ts
      ? client.reactions.add({ channel, timestamp: ts, name: "hourglass_flowing_sand" }).then(() => {}, () => {})
      : Promise.resolve();

  async function handleMentionOrDm(bot: SlackBot, client: WebClient, event: Record<string, unknown>) {
    const eventChannel = event.channel as string;
    const eventTs = event.ts as string;
    const threadTs = (event.thread_ts as string | undefined) ?? eventTs;
    const isDm = (event.channel_type as string | undefined) === "im";
    const mantaChannel = isDm ? `slack-${eventChannel}` : `slack-${eventChannel}-${threadTs}`;
    const userMessage = ((event.text as string | undefined) ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const slackUserId = event.user as string;

    await withConversationLock(
      `${bot.id}:${mantaChannel}`,
      () => busyReaction(client, eventChannel, eventTs),
      async () => {
        // Fetch context for an existing thread, or for a top-level message that
        // carries a screenshot (so the brain sees the attached image).
        const hasFiles = Array.isArray(event.files) && event.files.length > 0;
        const threadMessages = event.thread_ts || hasFiles ? await slackThreadContext(bot, client, eventChannel, threadTs, eventTs) : undefined;
        const turnUserMessage = slackUserMessageForTurn(userMessage, { threadMessages, hasFiles });
        await respondInThread(client, eventChannel, threadTs, () =>
          runTurn(bot, client, { eventChannel, threadTs, mantaChannel, slackUserId, userMessage: turnUserMessage, repoResolutionMessage: userMessage, eventTs, threadMessages }),
        );
      },
    );
  }

  async function handleChannelMessage(bot: SlackBot, client: WebClient, event: Record<string, unknown>) {
    const eventChannel = event.channel as string;
    const eventTs = event.ts as string;
    const threadTs = (event.thread_ts as string | undefined) ?? eventTs;
    const mantaChannel = `slack-ch-${eventChannel}-${threadTs}`;
    const slackUserId = event.user as string;
    const userMessage = (event.text as string | undefined) ?? "";
    // Auto-respond fires on top-level messages (threadTs === eventTs), so runTurn
    // won't fetch thread context on its own. When the triggering message carries a
    // screenshot, fetch that single message's context here so its image (the actual
    // content of most support reports) is surfaced to the brain.
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;

    await withConversationLock(
      `${bot.id}:${mantaChannel}`,
      () => busyReaction(client, eventChannel, eventTs),
      async () => {
        // Channels use a reaction rather than a placeholder message (less noise),
        // but still always surface an answer or an error.
        await client.reactions.add({ channel: eventChannel, timestamp: eventTs, name: "thinking_face" }).catch(() => {});
        try {
          const threadMessages = hasFiles ? await slackThreadContext(bot, client, eventChannel, threadTs, eventTs) : undefined;
          const turnUserMessage = slackUserMessageForTurn(userMessage, { threadMessages, hasFiles });
          const { text } = await runTurn(bot, client, { eventChannel, threadTs, mantaChannel, slackUserId, userMessage: turnUserMessage, repoResolutionMessage: userMessage, eventTs, autoChannelId: eventChannel, ...(threadMessages ? { threadMessages } : {}) });
          if (text) await client.chat.postMessage({ channel: eventChannel, thread_ts: threadTs, text });
        } catch (err) {
          logger.error("slack channel turn failed", { channel: eventChannel, err });
          await client.chat.postMessage({ channel: eventChannel, thread_ts: threadTs, text: errorMessage(err) }).catch(() => {});
        } finally {
          await client.reactions.remove({ channel: eventChannel, timestamp: eventTs, name: "thinking_face" }).catch(() => {});
        }
      },
    );
  }

  async function handleAssistantUserMessage(bot: SlackBot, client: WebClient, event: Record<string, unknown>) {
    const eventChannel = event.channel as string;
    const threadTs = event.thread_ts as string;
    const mantaChannel = `slack-${eventChannel}-${threadTs}`;
    const slackUserId = event.user as string;
    const userMessage = (event.text as string | undefined) ?? "";
    const eventTs = event.ts as string | undefined;

    await withConversationLock(
      `${bot.id}:${mantaChannel}`,
      () => busyReaction(client, eventChannel, eventTs),
      async () => {
        await client.assistant.threads.setStatus({ channel_id: eventChannel, thread_ts: threadTs, status: "Thinking..." }).catch(() => {});
        try {
          const { text } = await runTurn(bot, client, { eventChannel, threadTs, mantaChannel, slackUserId, userMessage, eventTs });
          if (text) await client.chat.postMessage({ channel: eventChannel, thread_ts: threadTs, text });
        } catch (err) {
          logger.error("slack assistant turn failed", { channel: eventChannel, err });
          await client.chat.postMessage({ channel: eventChannel, thread_ts: threadTs, text: errorMessage(err) }).catch(() => {});
        } finally {
          await client.assistant.threads.setStatus({ channel_id: eventChannel, thread_ts: threadTs, status: "" }).catch(() => {});
        }
      },
    );
  }

  async function handleAssistantThreadStarted(client: WebClient, event: Record<string, unknown>) {
    const assistantThread = event.assistant_thread as Record<string, unknown>;
    const eventChannel = assistantThread.channel_id as string;
    const threadTs = assistantThread.thread_ts as string;
    await client.assistant.threads.setSuggestedPrompts({
      channel_id: eventChannel,
      thread_ts: threadTs,
      prompts: [
        { title: "In-progress cards", message: "What cards are currently in progress?" },
        { title: "Create a card", message: "Create a card to..." },
        { title: "Feature questions", message: "How does [feature] work?" },
      ],
    });
    await client.assistant.threads.setStatus({ channel_id: eventChannel, thread_ts: threadTs, status: "" });
  }

  app.post("/events", async (c) => {
    const rawBody = await c.req.text();
    const payload = JSON.parse(rawBody) as Record<string, unknown>;

    // URL-verification handshake carries no api_app_id, so it can't be routed to a
    // bot; echo the challenge (harmless one-time setup ping).
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }

    const appId = payload.api_app_id as string | undefined;
    if (!appId) return c.json({ ok: true });
    const bot = await slack.findBotByAppId(appId);
    if (!bot || !bot.enabled) return c.json({ ok: true });

    // Verify with THIS bot's signing secret.
    const signingSecret = decrypt(Buffer.from(bot.signingSecretCipher));
    const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
    const signature = c.req.header("X-Slack-Signature") ?? "";
    if (!verifySignature(signingSecret, rawBody, timestamp, signature)) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    if (payload.type === "event_callback") {
      const event = payload.event as Record<string, unknown>;
      const eventType = event.type as string;
      const client = botClient(bot);
      const guard = (p: Promise<unknown>, what: string) =>
        void p.catch((err) => logger.warn(`slack ${what} failed`, { botId: bot.id, err }));

      // Never act on the bot's OWN messages (or any bot's): now that we post
      // multiple replies/updates, a self-@mention would otherwise loop. The DM
      // and channel branches below already gate on !bot_id; app_mention and the
      // assistant event don't, so guard them explicitly.
      const selfAuthored = Boolean(event.bot_id) || event.user === bot.botUserId;

      if (eventType === "app_mention") {
        // The bot is in the text, but if the message OPENS by mentioning someone
        // else (e.g. "@alice ask @bot to…"), it's aimed at them — stay out.
        if (!selfAuthored && !leadsWithForeignMention(event.text as string | undefined, bot.botUserId)) {
          guard(handleMentionOrDm(bot, client, event), "app_mention");
        }
        // `file_share` (a message with an attached file/screenshot) must pass: it's
        // an ordinary user message Slack happens to tag with a subtype. Drop every
        // other subtype (edits, joins, …) as noise.
      } else if (eventType === "message" && !event.bot_id && (!event.subtype || event.subtype === "file_share")) {
        if (event.channel_type === "im") {
          guard(handleMentionOrDm(bot, client, event), "dm");
        } else if (event.channel_type === "channel") {
          const skip = autoRespondSkipReason(bot, event);
          if (skip === null) {
            guard(handleChannelMessage(bot, client, event), "channel_message");
          } else {
            // The other half of "slack turn outcome": a channel message that never
            // reached the brain, and why. `not_allowlisted` is the common one (bot
            // is in the channel but it isn't configured for auto-respond).
            logger.debug("slack channel message skipped", { channel: event.channel, reason: skip });
          }
        }
      } else if (eventType === "assistant_thread_started") {
        guard(handleAssistantThreadStarted(client, event), "assistant_thread_started");
      } else if (eventType === "assistant_user_message") {
        if (!selfAuthored) guard(handleAssistantUserMessage(bot, client, event), "assistant_user_message");
      }
    }

    return c.json({ ok: true });
  });

  return app;
}
