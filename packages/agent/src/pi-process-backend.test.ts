import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@manta/shared";
import { ProcessIsolatedPiBackend, type IsolatedPiChild } from "./pi-process-backend.ts";
import type { ParentToIsolatedTurnMessage } from "./pi-process-protocol.ts";
import { defineTool, type RunTurnInput } from "./index.ts";

class FakeChild extends EventEmitter {
  readonly pid = 999_999;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sendReturn = true;
  sendError: Error | null = null;
  ignoreTerm = false;
  readonly kills: (NodeJS.Signals | number)[] = [];
  readonly sent: ParentToIsolatedTurnMessage[] = [];
  onSend?: (message: ParentToIsolatedTurnMessage) => void;

  send(message: ParentToIsolatedTurnMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(this.sendError);
    if (!this.sendError) queueMicrotask(() => this.onSend?.(message));
    return this.sendReturn;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.ignoreTerm && signal === "SIGTERM") return true;
    this.finish(null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const baseInput = (overrides: Partial<RunTurnInput> = {}): RunTurnInput => ({
  systemPrompt: "system",
  message: "hello",
  tools: [],
  backend: "pi-claude-bridge:claude-opus-4-8",
  ctx: { workspaceId: "workspace-1", channel: "task-1" },
  ...overrides,
});

async function collect(backend: ProcessIsolatedPiBackend, input: RunTurnInput): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of backend.runTurn(input)) events.push(event);
  return events;
}

describe("ProcessIsolatedPiBackend", () => {
  it("starts concurrent turns in separate children with separate cwd values", async () => {
    const children: FakeChild[] = [];
    const cwdValues: string[] = [];
    const factory = (cwd: string) => {
      cwdValues.push(cwd);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as IsolatedPiChild;
    };
    const parentCwd = process.cwd();
    const first = collect(new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, factory), baseInput());
    const second = collect(new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-b" }, factory), baseInput());
    await new Promise((resolve) => setImmediate(resolve));

    expect(children).toHaveLength(2);
    expect(cwdValues).toEqual(["/worktrees/card-a", "/worktrees/card-b"]);
    expect(process.cwd()).toBe(parentCwd);

    for (const [index, child] of children.entries()) {
      child.emit("message", { type: "event", event: { type: "text", text: `card-${index}` } });
      child.emit("message", { type: "complete" });
      child.finish(0);
    }
    expect(await first).toEqual([{ type: "text", text: "card-0" }]);
    expect(await second).toEqual([{ type: "text", text: "card-1" }]);
  });

  it("proxies tools and session callbacks to the parent turn", async () => {
    const child = new FakeChild();
    const toolCalls: unknown[] = [];
    const sessions: string[] = [];
    const tool = defineTool<{ value: number }>({
      name: "double",
      description: "double a number",
      parameters: { type: "object" },
      handler: (args, ctx) => {
        toolCalls.push({ args, ctx });
        return { value: args.value * 2 };
      },
    });
    child.onSend = (message) => {
      if (message.type === "start") {
        child.emit("message", { type: "rpc", id: 1, request: { kind: "tool", name: "double", args: { value: 4 } } });
      } else if (message.type === "rpc_result" && message.id === 1) {
        expect(message.value).toEqual({ value: 8 });
        child.emit("message", { type: "rpc", id: 2, request: { kind: "session", sessionKey: "/sessions/task.jsonl" } });
      } else if (message.type === "rpc_result" && message.id === 2) {
        child.emit("message", { type: "complete" });
        child.finish(0);
      }
    };

    await collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput({ tools: [tool], onSession: (key) => { sessions.push(key); } }),
    );

    expect(toolCalls).toEqual([{ args: { value: 4 }, ctx: baseInput().ctx }]);
    expect(sessions).toEqual(["/sessions/task.jsonl"]);
  });

  it("aborts and reaps only the child for that turn", async () => {
    const child = new FakeChild();
    child.onSend = (message) => {
      if (message.type === "abort") child.finish(null, "SIGTERM");
    };
    const controller = new AbortController();
    const turn = collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput({ signal: controller.signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    expect(await turn).toEqual([]);
    expect(child.sent.some((message) => message.type === "abort")).toBe(true);
  });

  it("surfaces an unexpected child exit as a turn error", async () => {
    const child = new FakeChild();
    const turn = collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.finish(7);

    expect(await turn).toEqual([
      { type: "error", message: "isolated Pi child exited before completing (code 7)" },
    ]);
  });

  it("treats a false IPC send return as backpressure rather than failure", async () => {
    const child = new FakeChild();
    child.sendReturn = false;
    child.onSend = (message) => {
      if (message.type !== "start") return;
      child.emit("message", { type: "complete" });
      child.finish(0);
    };

    await expect(collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput(),
    )).resolves.toEqual([]);
  });

  it("finishes on complete and reaps a child that has not exited", async () => {
    const child = new FakeChild();
    child.onSend = (message) => {
      if (message.type === "start") child.emit("message", { type: "complete" });
    };

    await expect(collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput(),
    )).resolves.toEqual([]);
    expect(child.kills).toContain("SIGTERM");
  });

  it("keeps the hard-kill deadline armed until an aborted child exits", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.ignoreTerm = true;
      const controller = new AbortController();
      let settled = false;
      const turn = collect(
        new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
        baseInput({ signal: controller.signal }),
      ).then((events) => {
        settled = true;
        return events;
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      await vi.advanceTimersByTimeAsync(3_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(turn).resolves.toEqual([]);
      expect(child.kills).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for hard-kill teardown when returned while suspended at yield", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.ignoreTerm = true;
      const controller = new AbortController();
      const iterator = new ProcessIsolatedPiBackend(
        { cwd: "/worktrees/card-a" },
        () => child as unknown as IsolatedPiChild,
      ).runTurn(baseInput({ signal: controller.signal }));
      const first = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      child.emit("message", { type: "event", event: { type: "text", text: "started" } });
      await expect(first).resolves.toEqual({ done: false, value: { type: "text", text: "started" } });

      controller.abort();
      let returned = false;
      const stopped = iterator.return().then((result) => {
        returned = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(3_999);
      expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(stopped).resolves.toEqual({ done: true, value: undefined });
      expect(child.kills).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams a startup IPC failure as an agent error", async () => {
    const child = new FakeChild();
    child.sendError = new Error("channel unavailable");

    await expect(collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => child as unknown as IsolatedPiChild),
      baseInput(),
    )).resolves.toEqual([
      { type: "error", message: "failed to start isolated Pi child: channel unavailable" },
    ]);
  });

  it("streams a synchronous child factory failure as an agent error", async () => {
    await expect(collect(
      new ProcessIsolatedPiBackend({ cwd: "/worktrees/card-a" }, () => {
        throw new Error("fork unavailable");
      }),
      baseInput(),
    )).resolves.toEqual([
      { type: "error", message: "failed to start isolated Pi child: fork unavailable" },
    ]);
  });
});
