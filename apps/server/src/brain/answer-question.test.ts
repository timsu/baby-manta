import { describe, it, expect, vi } from "vitest";
import { brainTaskTools, type QuestionDriver } from "./tools.ts";

vi.mock("../repos/canonical.ts", () => ({
  canonicalRepoForWorkspace: async (_workspaceId: string, repo: string) => repo,
}));

const ctx = { workspaceId: "w1", channel: "brain" };

describe("answer_question brain tool", () => {
  it("is present and errors when no driver is wired", async () => {
    const tools = brainTaskTools();
    const tool = tools.find((t) => t.name === "answer_question");
    expect(tool).toBeTruthy();
    expect(await tool!.handler({ repo: "acme/x", question: "how?" }, ctx)).toEqual({
      error: "question delegation not configured",
    });
  });

  it("relays the worker's answer", async () => {
    const driver: QuestionDriver = { ask: async () => ({ ok: true, answer: "It uses a queue." }) };
    const tool = brainTaskTools({ question: driver }).find((t) => t.name === "answer_question")!;
    expect(await tool.handler({ repo: "acme/x", question: "how does it work?" }, ctx)).toEqual({
      answer: "It uses a queue.",
    });
  });

  it("surfaces a no_worker outcome the brain can act on", async () => {
    const driver: QuestionDriver = { ask: async () => ({ ok: false, reason: "no_worker" }) };
    const tool = brainTaskTools({ question: driver }).find((t) => t.name === "answer_question")!;
    const res = (await tool.handler({ repo: "acme/x", question: "?" }, ctx)) as { error: string };
    expect(res.error).toBe("no_worker");
  });

  it("passes the workspace from ctx, never from args", async () => {
    let seenWorkspace = "";
    const driver: QuestionDriver = {
      ask: async (workspaceId) => { seenWorkspace = workspaceId; return { ok: true, answer: "ok" }; },
    };
    const tool = brainTaskTools({ question: driver }).find((t) => t.name === "answer_question")!;
    await tool.handler({ repo: "acme/x", question: "?" }, { workspaceId: "w-real", channel: "brain" });
    expect(seenWorkspace).toBe("w-real");
  });

  it("streams the worker's progress notes into the originating Slack thread", async () => {
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const slack = { postMessage: async (channel: string, text: string, threadTs?: string) => { posts.push({ channel, text, threadTs }); } };
    const driver: QuestionDriver = {
      ask: async (_w, _r, _q, onUpdate) => { onUpdate?.("Checking migrations…"); return { ok: true, answer: "done" }; },
    };
    const tool = brainTaskTools({ question: driver, slack }).find((t) => t.name === "answer_question")!;
    const res = await tool.handler({ repo: "acme/x", question: "?" }, { workspaceId: "w1", channel: "brain", slackOrigin: { channel: "C1", threadTs: "T1" } });
    expect(res).toEqual({ answer: "done" });
    expect(posts).toEqual([{ channel: "C1", text: "Checking migrations…", threadTs: "T1" }]);
  });

  it("provides no update sink outside a Slack turn", async () => {
    let sawSink: boolean | undefined;
    const driver: QuestionDriver = {
      ask: async (_w, _r, _q, onUpdate) => { sawSink = Boolean(onUpdate); return { ok: true, answer: "x" }; },
    };
    const tool = brainTaskTools({ question: driver, slack: { postMessage: async () => {} } }).find((t) => t.name === "answer_question")!;
    await tool.handler({ repo: "acme/x", question: "?" }, ctx);
    expect(sawSink).toBe(false);
  });
});
