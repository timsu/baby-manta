import { WebClient } from "@slack/web-api";
import { slack, type SlackBot } from "@manta/db";
import { decrypt } from "../secrets/crypto.ts";

export interface WorkerSlackPostInput {
  workspaceId: string;
  text: string;
  bot?: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
}

interface SlackPostClient {
  openDm(userId: string): Promise<string | undefined>;
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<{ channel?: string; ts?: string }>;
}

interface WorkerSlackPostDeps {
  listBots: (workspaceId: string) => Promise<SlackBot[]>;
  clientForBot: (bot: SlackBot) => SlackPostClient;
}

export class WorkerSlackPostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkerSlackPostError";
  }
}

function defaultClientForBot(bot: SlackBot): SlackPostClient {
  const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
  return {
    openDm: async (userId) => {
      const response = await client.conversations.open({ users: userId });
      return response.channel?.id;
    },
    postMessage: async ({ channel, text, threadTs }) => {
      const response = await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return { channel: response.channel, ts: response.ts };
    },
  };
}

const defaultDeps: WorkerSlackPostDeps = {
  listBots: slack.listBots,
  clientForBot: defaultClientForBot,
};

function selectBot(bots: SlackBot[], selector?: string): SlackBot {
  const enabled = bots.filter((bot) => bot.enabled);
  if (!selector) {
    if (enabled.length === 1) return enabled[0]!;
    if (enabled.length === 0) throw new WorkerSlackPostError("slack_bot_unavailable", "No enabled Slack bot is configured for this workspace");
    throw new WorkerSlackPostError(
      "slack_bot_required",
      `Multiple Slack bots are enabled; choose one by name or ID: ${enabled.map((bot) => `${bot.name} (${bot.id})`).join(", ")}`,
    );
  }

  const normalized = selector.trim().toLowerCase();
  const matches = enabled.filter((bot) => bot.id.toLowerCase() === normalized || bot.name.trim().toLowerCase() === normalized);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new WorkerSlackPostError("slack_bot_ambiguous", `More than one enabled Slack bot is named "${selector}"; use its bot ID`);
  }
  throw new WorkerSlackPostError("slack_bot_unavailable", `Enabled Slack bot "${selector}" was not found in this workspace`);
}

export async function postWorkerSlackMessage(
  input: WorkerSlackPostInput,
  deps: WorkerSlackPostDeps = defaultDeps,
): Promise<{ ok: true; botId: string; botName: string; channelId: string; messageTs?: string }> {
  const text = input.text.trim();
  const channelId = input.channelId?.trim();
  const userId = input.userId?.trim();
  const threadTs = input.threadTs?.trim();
  if (!text) throw new WorkerSlackPostError("text_required", "text required");
  if (Boolean(channelId) === Boolean(userId)) {
    throw new WorkerSlackPostError("destination_required", "Provide exactly one of channelId or userId");
  }
  if (userId && threadTs) {
    throw new WorkerSlackPostError("invalid_thread_destination", "threadTs requires channelId; use channelId for replies in a DM thread");
  }

  const bot = selectBot(await deps.listBots(input.workspaceId), input.bot);
  const client = deps.clientForBot(bot);
  let destination = channelId;
  if (userId) {
    destination = await client.openDm(userId);
    if (!destination) throw new WorkerSlackPostError("slack_dm_open_failed", `Slack did not return a DM channel for ${userId}`);
  }

  const result = await client.postMessage({ channel: destination!, text, ...(threadTs ? { threadTs } : {}) });
  return {
    ok: true,
    botId: bot.id,
    botName: bot.name,
    channelId: result.channel ?? destination!,
    ...(result.ts ? { messageTs: result.ts } : {}),
  };
}
