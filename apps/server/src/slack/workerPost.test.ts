import { describe, expect, it, vi } from "vitest";
import type { SlackBot } from "@manta/db";
import { postWorkerSlackMessage, WorkerSlackPostError } from "./workerPost.ts";

function bot(id: string, name: string, enabled = true): SlackBot {
  return { id, name, enabled } as SlackBot;
}

function deps(bots: SlackBot[]) {
  const openDm = vi.fn(async () => "D123");
  const postMessage = vi.fn(async (input: { channel: string; text: string; threadTs?: string }) => ({
    channel: input.channel,
    ts: "1700.001",
  }));
  return {
    openDm,
    postMessage,
    value: {
      listBots: vi.fn(async () => bots),
      clientForBot: vi.fn(() => ({ openDm, postMessage })),
    },
  };
}

describe("worker Slack posting", () => {
  it("posts to a channel with the only enabled bot", async () => {
    const mock = deps([bot("bot-1", "Support")]);

    await expect(postWorkerSlackMessage({
      workspaceId: "workspace-1",
      channelId: "C123",
      text: "Hello channel",
    }, mock.value)).resolves.toEqual({
      ok: true,
      botId: "bot-1",
      botName: "Support",
      channelId: "C123",
      messageTs: "1700.001",
    });
    expect(mock.postMessage).toHaveBeenCalledWith({ channel: "C123", text: "Hello channel" });
    expect(mock.openDm).not.toHaveBeenCalled();
  });

  it("selects a configured bot by name and replies to a thread", async () => {
    const mock = deps([bot("bot-1", "Support"), bot("bot-2", "Engineering")]);

    await postWorkerSlackMessage({
      workspaceId: "workspace-1",
      bot: "engineering",
      channelId: "C123",
      threadTs: "1699.001",
      text: "Thread reply",
    }, mock.value);

    expect(mock.value.clientForBot).toHaveBeenCalledWith(expect.objectContaining({ id: "bot-2" }));
    expect(mock.postMessage).toHaveBeenCalledWith({ channel: "C123", text: "Thread reply", threadTs: "1699.001" });
  });

  it("opens and posts to a direct-message conversation", async () => {
    const mock = deps([bot("bot-1", "Support")]);

    await postWorkerSlackMessage({ workspaceId: "workspace-1", userId: "U123", text: "Hello user" }, mock.value);

    expect(mock.openDm).toHaveBeenCalledWith("U123");
    expect(mock.postMessage).toHaveBeenCalledWith({ channel: "D123", text: "Hello user" });
  });

  it("requires a bot selector when multiple bots are enabled", async () => {
    const mock = deps([bot("bot-1", "Support"), bot("bot-2", "Engineering"), bot("bot-3", "Disabled", false)]);

    await expect(postWorkerSlackMessage({
      workspaceId: "workspace-1",
      channelId: "C123",
      text: "Hello",
    }, mock.value)).rejects.toMatchObject({
      code: "slack_bot_required",
      message: "Multiple Slack bots are enabled; choose one by name or ID: Support (bot-1), Engineering (bot-2)",
    } satisfies Partial<WorkerSlackPostError>);
    expect(mock.postMessage).not.toHaveBeenCalled();
  });

  it("rejects ambiguous destinations and DM thread timestamps", async () => {
    const mock = deps([bot("bot-1", "Support")]);

    await expect(postWorkerSlackMessage({
      workspaceId: "workspace-1",
      channelId: "C123",
      userId: "U123",
      text: "Hello",
    }, mock.value)).rejects.toMatchObject({ code: "destination_required" });
    await expect(postWorkerSlackMessage({
      workspaceId: "workspace-1",
      userId: "U123",
      threadTs: "1699.001",
      text: "Hello",
    }, mock.value)).rejects.toMatchObject({ code: "invalid_thread_destination" });
  });
});
