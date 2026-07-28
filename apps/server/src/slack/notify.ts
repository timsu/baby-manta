// Outbound Slack notifications for task state changes.
// Called from the poller — not from transition code — to keep the DB layer
// Slack-free. We find un-notified tasks that reached a notable status, post to
// their originating thread with the ORIGINATING BOT's token, then mark
// slackDmSent. This is also the "no-code card posts its answer to Slack and
// moves to Done" path: the worker/brain transitions the card to done, and the
// poller fans the completion back to the Slack thread.

import { WebClient } from "@slack/web-api";
import { prisma, slack } from "@manta/db";
import type { CardStatus, SlackBot } from "@manta/db";
import { decrypt } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:SlackNotify");

const NOTIFY_STATUSES = ["done", "needs_help", "ready_to_test"] as const;
type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

function slackLink(url: string, label: string): string {
  const safeLabel = label.replace(/[|<>]/g, " ").replace(/\s+/g, " ").trim() || url;
  return `<${url}|${safeLabel}>`;
}

export function buildSlackNotificationMessage(input: {
  status: NotifyStatus;
  title: string;
  prUrl: string | null;
  prTitle?: string | null;
  doneReason?: string | null;
}): string {
  const { status, title, prUrl, prTitle, doneReason } = input;
  switch (status) {
    case "done":
      if (doneReason === "merged" && prUrl) {
        return `:white_check_mark: PR ${slackLink(prUrl, prTitle ?? title)} was merged`;
      }
      return prUrl
        ? `:white_check_mark: *${title}* is done! PR: ${prUrl}`
        : `:white_check_mark: *${title}* is done!`;
    case "needs_help":
      return `:sos: *${title}* needs your attention — the worker got stuck and the brain has been notified.`;
    case "ready_to_test":
      return prUrl
        ? `:test_tube: *${title}* has a PR ready to review: ${prUrl}`
        : `:test_tube: *${title}* is ready to test.`;
  }
}

export async function sendSlackNotifications(): Promise<void> {
  // Only cards that carry a Slack origin AND know which bot to post as can be
  // notified — without a bot we have no token.
  const tasks = await prisma.task.findMany({
    where: {
      slackDmSent: false,
      slackChannel: { not: null },
      slackBotId: { not: null },
      cardStatus: { in: NOTIFY_STATUSES as unknown as CardStatus[] },
      archivedAt: null,
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      cardStatus: true,
      doneReason: true,
      slackChannel: true,
      slackThreadTs: true,
      slackBotId: true,
      prUrl: true,
      prTitle: true,
    },
  });

  if (!tasks.length) return;

  // Cache decrypted clients per bot within this run; a botId that's missing or
  // disabled resolves to null so we skip its tasks without re-querying.
  const clientCache = new Map<string, WebClient | null>();
  async function clientFor(workspaceId: string, botId: string): Promise<WebClient | null> {
    // Key by (workspaceId, botId): getBot is workspace-scoped, so a miss in one
    // workspace must not be cached against a bot id looked up under another.
    const key = `${workspaceId}:${botId}`;
    const cached = clientCache.get(key);
    if (cached !== undefined) return cached;
    const bot: SlackBot | null = await slack.getBot(workspaceId, botId);
    const client = bot && bot.enabled ? new WebClient(decrypt(Buffer.from(bot.botTokenCipher))) : null;
    clientCache.set(key, client);
    return client;
  }

  for (const task of tasks) {
    try {
      const client = await clientFor(task.workspaceId, task.slackBotId!);
      if (!client) {
        logger.warn("slack notification skipped — bot missing/disabled", { taskId: task.id, botId: task.slackBotId });
        continue;
      }
      const status = task.cardStatus as NotifyStatus;
      const text = buildSlackNotificationMessage({
        status,
        title: task.title,
        prUrl: task.prUrl,
        prTitle: task.prTitle,
        doneReason: task.doneReason,
      });
      await client.chat.postMessage({
        channel: task.slackChannel!,
        thread_ts: task.slackThreadTs ?? undefined,
        text,
      });
      await prisma.task.update({ where: { id: task.id }, data: { slackDmSent: true } });
      logger.info("slack notification sent", { taskId: task.id, status });
    } catch (err) {
      logger.warn("slack notification failed", { taskId: task.id, err });
    }
  }
}
