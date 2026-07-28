// Daytona implementation of the Sandboxes driver. Mirrors the proven calls in
// an internal sandbox service using the same SDK version. The control
// plane stays stateless about live sandboxes — Daytona is the source of truth;
// we reattach by label after a restart.

import { Daytona } from "@daytona/sdk";
import { createLogger } from "../logger.ts";
import type {
  Sandboxes,
  SandboxHandle,
  CreateSandboxInput,
  ExecResult,
  StreamLogsInput,
} from "./sandboxes.ts";

const logger = createLogger("Manta:Daytona");

// Loose shapes for the bits of the SDK we touch (its types are heavy/decorated).
interface DaytonaSandbox {
  id: string;
  labels: Record<string, string>;
  state?: string;
  createdAt?: string;
  process: {
    executeCommand(cmd: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ result?: string; exitCode?: number }>;
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(sessionId: string, req: { command: string; runAsync?: boolean }, timeout?: number): Promise<{ cmdId?: string }>;
    getSessionCommandLogs(sessionId: string, cmdId: string, onStdout: (c: string) => void, onStderr: (c: string) => void): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
  };
  fs: {
    uploadFile(src: Buffer, dst: string, timeout?: number): Promise<void>;
    setFilePermissions(path: string, perms: { mode?: string }): Promise<void>;
  };
}

interface DaytonaClient {
  create(params: unknown, options?: unknown): Promise<DaytonaSandbox>;
  get(id: string): Promise<DaytonaSandbox>;
  list(query?: { labels?: Record<string, string> }): AsyncIterableIterator<DaytonaSandbox>;
  start(sandbox: DaytonaSandbox): Promise<void>;
  stop(sandbox: DaytonaSandbox): Promise<void>;
  delete(sandbox: DaytonaSandbox, timeout?: number): Promise<void>;
}

export class DaytonaSandboxes implements Sandboxes {
  private readonly client: DaytonaClient;

  constructor(apiKey: string, apiUrl?: string) {
    this.client = new Daytona({ apiKey, ...(apiUrl ? { apiUrl } : {}) }) as unknown as DaytonaClient;
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const params: Record<string, unknown> = { labels: input.labels };
    if (input.env) params["envVars"] = input.env;
    if (input.snapshot) params["snapshot"] = input.snapshot;
    else if (input.image) params["image"] = input.image;
    // Cost backstop: Daytona auto-stops an idle box, then archives, then deletes
    // it (the control plane's own idle-spindown is the primary mechanism; these
    // are the safety net so nothing runs forever if the server misses one).
    if (input.autoStopMinutes !== undefined) params["autoStopInterval"] = input.autoStopMinutes;
    if (input.autoArchiveMinutes !== undefined) params["autoArchiveInterval"] = input.autoArchiveMinutes;
    if (input.autoDeleteMinutes !== undefined) params["autoDeleteInterval"] = input.autoDeleteMinutes;
    const sandbox = await this.client.create(params);
    logger.info("sandbox created", { id: sandbox.id, labels: input.labels });
    return { id: sandbox.id, labels: sandbox.labels, ...(sandbox.state ? { state: sandbox.state } : {}), ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}) };
  }

  async exec(id: string, command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    const sandbox = await this.client.get(id);
    const res = await sandbox.process.executeCommand(command, opts?.cwd, opts?.env);
    return { stdout: res.result ?? "", exitCode: res.exitCode ?? 0 };
  }

  // Atomic: upload to a tmp path, chmod, then mv -f into place (the sandbox service pattern).
  async pushFile(id: string, path: string, content: string, mode = "600"): Promise<void> {
    const sandbox = await this.client.get(id);
    const tmp = `${path}.tmp.${Math.random().toString(36).slice(2)}`;
    await sandbox.fs.uploadFile(Buffer.from(content), tmp);
    await sandbox.fs.setFilePermissions(tmp, { mode });
    await sandbox.process.executeCommand(`mv -f "${tmp}" "${path}"`);
  }

  async streamLogs(input: StreamLogsInput): Promise<{ abort: () => void }> {
    const sandbox = await this.client.get(input.id);
    const sessionId = `manta-${Math.random().toString(36).slice(2)}`;
    await sandbox.process.createSession(sessionId);
    const exec = await sandbox.process.executeSessionCommand(sessionId, { command: input.command, runAsync: true });
    let cancelled = false;
    const emit = (c: string) => {
      if (!cancelled) input.onChunk(c);
    };
    void sandbox.process
      .getSessionCommandLogs(sessionId, exec.cmdId ?? "", emit, emit)
      .then(() => !cancelled && input.onClose())
      .catch((err: unknown) => (input.onError ? input.onError(err) : logger.warn("stream error", { err })))
      .finally(() => void sandbox.process.deleteSession(sessionId).catch(() => {}));
    return {
      abort: () => {
        cancelled = true;
      },
    };
  }

  async listByLabel(labels: Record<string, string>): Promise<SandboxHandle[]> {
    const out: SandboxHandle[] = [];
    for await (const sandbox of this.client.list({ labels })) {
      out.push({
        id: sandbox.id,
        labels: sandbox.labels,
        ...(sandbox.state ? { state: sandbox.state } : {}),
        ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}),
      });
    }
    return out;
  }

  async start(id: string): Promise<void> {
    const sandbox = await this.client.get(id);
    await this.client.start(sandbox);
  }

  async stop(id: string): Promise<void> {
    const sandbox = await this.client.get(id);
    await this.client.stop(sandbox);
  }

  async delete(id: string): Promise<void> {
    const sandbox = await this.client.get(id);
    await this.client.delete(sandbox);
  }
}
