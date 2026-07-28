// End-to-end Scout turn against real Postgres with a recording backend. Proves
// the runaway-cost fixes hold: Scout starts a FRESH session (never resumes),
// stops the moment brief_brain is called (terminal action), and a runaway is
// capped at MAX_TOOL_CALLS. No tokens, no network. Skipped without DATABASE_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, workspaces, tasks, inbox } from "@manta/db";
import type { AgentBackend, RunTurnInput, ToolDefinition } from "@manta/agent";
import type { AgentEvent } from "@manta/shared";
import { runScoutTurn } from "./runner.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);

// A backend that runs a scripted tool sequence (executing real handlers) while
// recording what it saw: the resumeFrom handle and how many tool calls actually
// ran before the turn was aborted. Mirrors ScriptedBackend but instrumented.
type Step = { tool: string; args: unknown };
class RecordingBackend implements AgentBackend {
  readonly id = "fake";
  resumeFrom: string | undefined = "UNSET";
  executed = 0;
  constructor(private readonly script: Step[]) {}
  supports(b: string): boolean { return b === "fake" || b.startsWith("fake-"); }
  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, void, void> {
    this.resumeFrom = input.resumeFrom;
    for (const step of this.script) {
      if (input.signal?.aborted) { yield { type: "error", message: "interrupted" }; return; }
      const tool = input.tools.find((t: ToolDefinition) => t.name === step.tool);
      if (!tool) { yield { type: "error", message: `unknown tool ${step.tool}` }; return; }
      yield { type: "tool_use", toolName: step.tool, argsPreview: JSON.stringify(step.args) };
      this.executed += 1;
      const result = await tool.handler(step.args, input.ctx);
      yield { type: "tool_result", ok: true, preview: JSON.stringify(result) };
    }
    yield { type: "done", reason: "end_turn" };
  }
}

describe.skipIf(!hasDb)("runScoutTurn (end-to-end, recording backend)", () => {
  let wid = "";
  beforeAll(async () => {
    await prisma.$connect();
    const ws = await workspaces.create({ slug: "ws-scout-" + Math.random().toString(36).slice(2, 8), name: "Scout" });
    wid = ws.id;
  });
  afterAll(async () => {
    if (wid) await prisma.workspace.deleteMany({ where: { id: wid } });
    await prisma.$disconnect();
  });

  it("flags a stalled card, briefs once, and stops (never resumes)", async () => {
    const scope = { workspaceId: wid };
    const stalled = await tasks.create(scope, {
      name: "stuck-card", title: "stuck card", description: "", kind: "self",
      cardType: "bot", repo: "acme/api", workerBackend: "fake", cardStatus: "bot_working",
    });
    await prisma.task.update({ where: { id: stalled.id }, data: { workerActive: false } });

    const backend = new RecordingBackend([
      { tool: "get_active_tasks", args: {} },
      { tool: "flag_needs_help", args: { taskId: stalled.id, reason: "no worker for 30m" } },
      { tool: "brief_brain", args: { brief: "Flagged 1 stalled card." } },
      // Anything after brief_brain must NOT execute — the turn ends on brief.
      { tool: "get_active_tasks", args: {} },
      { tool: "get_active_tasks", args: {} },
    ]);

    await runScoutTurn({ workspaceId: wid, backend, backendId: "fake" });

    // Fresh session — Scout must never resume an accumulating context.
    expect(backend.resumeFrom).toBeUndefined();
    // brief_brain was terminal: the two trailing reads were skipped.
    expect(backend.executed).toBe(3);
    // The stalled card moved to needs_help.
    const after = await tasks.get(scope, stalled.id);
    expect(after?.cardStatus).toBe("needs_help");
    // The brief landed in the brain inbox.
    const pending = await inbox.pending(wid, "brain");
    expect(pending.some((i) => i.body.includes("[Scout brief]"))).toBe(true);
  });

  it("caps a runaway at MAX_TOOL_CALLS even if the model never briefs", async () => {
    const backend = new RecordingBackend(
      // 20 read calls, no brief_brain — simulates the old never-terminating loop.
      Array.from({ length: 20 }, () => ({ tool: "get_active_tasks", args: {} })),
    );
    await runScoutTurn({ workspaceId: wid, backend, backendId: "fake" });
    // Hard cap kicks in well before 20 (MAX_TOOL_CALLS = 12).
    expect(backend.executed).toBeLessThanOrEqual(12);
    expect(backend.executed).toBeGreaterThan(0);
  });
});
