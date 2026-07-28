// A scripted, deterministic AgentBackend for tests — emits a fixed sequence of
// events and, like a real backend (Pi/Claude), OWNS tool execution: when the
// script says to call a tool, it invokes the provided tool handler and emits
// the corresponding tool_use/tool_result events. This lets us exercise the full
// turn/stream/persist/tool-dispatch path with zero tokens and no network.

import type { AgentBackend, RunTurnInput } from "./index.ts";
import type { AgentEvent } from "@manta/shared";

export type ScriptStep =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "call"; tool: string; args: unknown };

export class ScriptedBackend implements AgentBackend {
  readonly id = "fake";

  constructor(private readonly script: ScriptStep[]) {}

  supports(backend: string): boolean {
    return backend === "fake" || backend.startsWith("fake-");
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, void, void> {
    for (const step of this.script) {
      if (input.signal?.aborted) {
        yield { type: "error", message: "interrupted" };
        return;
      }
      if (step.type === "text") {
        yield { type: "text", text: step.text };
      } else if (step.type === "thinking") {
        yield { type: "thinking", text: step.text };
      } else {
        const tool = input.tools.find((t) => t.name === step.tool);
        if (!tool) {
          yield { type: "error", message: `unknown tool ${step.tool}` };
          return;
        }
        yield { type: "tool_use", toolName: step.tool, argsPreview: JSON.stringify(step.args) };
        try {
          const result = await tool.handler(step.args, input.ctx);
          yield { type: "tool_result", ok: true, preview: JSON.stringify(result) };
        } catch (err) {
          yield {
            type: "tool_result",
            ok: false,
            preview: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
    yield { type: "done", reason: "end_turn" };
  }
}
