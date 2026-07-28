import { describe, it, expect } from "vitest";
import { BackendRegistry, type AgentBackend, type RunTurnInput } from "./index.ts";
import type { AgentEvent } from "@manta/shared";

function fakeBackend(id: string, prefix: string): AgentBackend {
  return {
    id,
    supports: (backend) => backend.startsWith(prefix),
    async *runTurn(_input: RunTurnInput): AsyncGenerator<AgentEvent> {
      yield { type: "text", text: "hello" };
      yield { type: "done", reason: "end_turn" };
    },
  };
}

describe("BackendRegistry", () => {
  it("resolves a backend by support predicate", () => {
    const reg = new BackendRegistry()
      .register(fakeBackend("pi", "pi-"))
      .register(fakeBackend("claude", "claude-"));
    expect(reg.resolve("pi-gpt-5.4").id).toBe("pi");
    expect(reg.resolve("claude-sonnet").id).toBe("claude");
  });

  it("throws when no backend supports the id", () => {
    const reg = new BackendRegistry().register(fakeBackend("pi", "pi-"));
    expect(() => reg.resolve("gemini-2.0")).toThrow(/No agent backend/);
  });

  it("a turn streams events ending in done", async () => {
    const reg = new BackendRegistry().register(fakeBackend("pi", "pi-"));
    const events: AgentEvent[] = [];
    for await (const e of reg.resolve("pi-x").runTurn({
      systemPrompt: "",
      message: "hi",
      tools: [],
      backend: "pi-x",
      ctx: { workspaceId: "w1", channel: "brain" },
    })) {
      events.push(e);
    }
    expect(events.at(-1)).toEqual({ type: "done", reason: "end_turn" });
  });
});
