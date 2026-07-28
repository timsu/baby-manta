// In-memory Sandboxes fake for unit/integration tests (no Daytona, no network).
// exec runs a pluggable command handler; default echoes the command back.

import type { Sandboxes, SandboxHandle, CreateSandboxInput, ExecResult, StreamLogsInput } from "./sandboxes.ts";

interface FakeBox {
  id: string;
  labels: Record<string, string>;
  files: Map<string, string>;
  stopped: boolean;
  createdAt: string;
}

export class FakeSandboxes implements Sandboxes {
  private readonly boxes = new Map<string, FakeBox>();
  private seq = 0;

  constructor(private readonly execHandler: (command: string, box: SandboxHandle) => ExecResult = (c) => ({ stdout: c, exitCode: 0 })) {}

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const id = `fake-${++this.seq}`;
    const createdAt = new Date().toISOString();
    this.boxes.set(id, { id, labels: input.labels, files: new Map(), stopped: false, createdAt });
    return { id, labels: input.labels, state: "started", createdAt };
  }

  private require(id: string): FakeBox {
    const b = this.boxes.get(id);
    if (!b) throw new Error(`no sandbox ${id}`);
    return b;
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    const b = this.require(id);
    return this.execHandler(command, { id: b.id, labels: b.labels });
  }

  async pushFile(id: string, path: string, content: string): Promise<void> {
    this.require(id).files.set(path, content);
  }

  async streamLogs(input: StreamLogsInput): Promise<{ abort: () => void }> {
    const b = this.require(input.id);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      input.onChunk(this.execHandler(input.command, { id: b.id, labels: b.labels }).stdout);
      input.onClose();
    });
    return { abort: () => { cancelled = true; } };
  }

  async listByLabel(labels: Record<string, string>): Promise<SandboxHandle[]> {
    return [...this.boxes.values()]
      .filter((b) => Object.entries(labels).every(([k, v]) => b.labels[k] === v))
      .map((b) => ({ id: b.id, labels: b.labels, state: b.stopped ? "stopped" : "started", createdAt: b.createdAt }));
  }

  async start(id: string): Promise<void> {
    this.require(id).stopped = false;
  }

  async stop(id: string): Promise<void> {
    this.require(id).stopped = true;
  }

  async delete(id: string): Promise<void> {
    this.boxes.delete(id);
  }

  // Test helpers
  fileAt(id: string, path: string): string | undefined {
    return this.boxes.get(id)?.files.get(path);
  }
}
