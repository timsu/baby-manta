// End-to-end brain turn against real Postgres with a scripted backend — proves
// the whole loop: inbox drain → user msg persisted → backend streams + executes
// a tool (create_task) → assistant msg persisted → events returned. No tokens,
// no network. Skipped without DATABASE_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, workspaces, tasks, messages } from "@manta/db";
import { ScriptedBackend } from "@manta/agent";
import { runBrainTurn } from "./runner.ts";
import { brainTaskTools } from "./tools.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);

describe.skipIf(!hasDb)("runBrainTurn (end-to-end, scripted backend)", () => {
  let wid = "";
  beforeAll(async () => {
    await prisma.$connect();
    const ws = await workspaces.create({ slug: "ws-run-" + Math.random().toString(36).slice(2, 8), name: "Run" });
    wid = ws.id;
  });
  afterAll(async () => {
    if (wid) await prisma.workspace.deleteMany({ where: { id: wid } });
    await prisma.$disconnect();
  });

  it("runs a turn that spawns a task and persists the conversation", async () => {
    const scope = { workspaceId: wid };
    const backend = new ScriptedBackend([
      { type: "text", text: "On it — spinning up a worker." },
      { type: "call", tool: "create_task", args: { description: "Add a /health endpoint", repo: "acme/api" } },
      { type: "text", text: "Done, card created." },
    ]);

    const result = await runBrainTurn({
      scope,
      channel: "brain",
      userMessage: "please add a health endpoint",
      backend,
      tools: brainTaskTools(),
      promptParts: { basePrompt: "You are the brain." },
      inbox: [{ id: "i1", body: "[STALL] c-old", source: "poller", createdAt: 1 }],
    });

    // The inbox item was drained for consumption.
    expect(result.consumedInboxIds).toEqual(["i1"]);
    expect(result.terminalReason).toBe("end_turn");
    expect(result.assistantText).toContain("On it");
    expect(result.assistantText).toContain("Done");
    expect(result.createdTasks).toEqual([
      expect.objectContaining({ repo: "acme/api", title: "Add a /health endpoint", cardStatus: "bot_working" }),
    ]);

    // The tool actually created a task in this workspace.
    const taskList = await tasks.list(scope);
    expect(taskList).toHaveLength(1);
    expect(taskList[0]?.repo).toBe("acme/api");

    // Conversation persisted: user message then assistant message.
    const convo = await messages.list(scope, "brain");
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convo[0]?.content).toBe("please add a health endpoint");
    // The assistant message carries a tool-call trace in meta.
    const meta = convo[1]?.meta as { tools?: Array<{ tool: string }> } | null;
    expect(meta?.tools?.[0]?.tool).toBe("create_task");

    // Event stream shape: a tool_use + tool_result + a terminal done.
    expect(result.events.some((e) => e.type === "tool_use")).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: "done" });
  });
});
