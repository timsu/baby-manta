import { describe, it, expect } from "vitest";
import { brainTaskTools } from "./tools.ts";

describe("reply_to_slack brain tool", () => {
  function toolWithCapture() {
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const slack = { postMessage: async (channel: string, text: string, threadTs?: string) => { posts.push({ channel, text, threadTs }); } };
    const tool = brainTaskTools({ slack }).find((t) => t.name === "reply_to_slack")!;
    return { tool, posts };
  }

  it("posts to the originating thread, ignoring any channel the model passes", async () => {
    const { tool, posts } = toolWithCapture();
    // The model passes a (possibly wrong) channel; the origin must win.
    await tool.handler(
      { channel: "C-WRONG", text: "On it — checking acme/web…" },
      { workspaceId: "w1", channel: "brain", slackOrigin: { channel: "C-RIGHT", threadTs: "T1" } },
    );
    expect(posts).toEqual([{ channel: "C-RIGHT", text: "On it — checking acme/web…", threadTs: "T1" }]);
  });

  it("falls back to the passed channel outside a Slack turn (proactive contexts)", async () => {
    const { tool, posts } = toolWithCapture();
    await tool.handler({ channel: "C9", text: "FYI" }, { workspaceId: "w1", channel: "brain" });
    expect(posts).toEqual([{ channel: "C9", text: "FYI", threadTs: undefined }]);
  });

  it("errors when there is neither an origin thread nor a channel", async () => {
    const { tool } = toolWithCapture();
    const res = await tool.handler({ text: "hi" }, { workspaceId: "w1", channel: "brain" });
    expect(res).toMatchObject({ error: expect.stringContaining("no channel") });
  });
});

describe("ignore brain tool", () => {
  it("is available and signals an intentional no-reply", async () => {
    const tool = brainTaskTools().find((t) => t.name === "ignore")!;
    expect(tool).toBeTruthy();
    expect(await tool.handler({ reason: "people chatting" }, { workspaceId: "w1", channel: "brain" })).toEqual({ ignored: true });
  });
});
