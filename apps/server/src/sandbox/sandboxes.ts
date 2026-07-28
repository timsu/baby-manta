// Sandbox driver abstraction (the `Manta.Sandbox` behaviour from ARCHITECTURE).
// Production = Daytona (the sandbox service's pattern); tests use FakeSandboxes. Workers
// are dispatched into a sandbox per task; the control plane streams events back.
//
// Ownership is enforced by labels (workspace + task), mirroring the sandbox service: list/
// get filter by the workspace label so one tenant can't see another's sandboxes.

export interface SandboxHandle {
  id: string;
  labels: Record<string, string>;
  /** Provider state (e.g. "started" | "stopped" | "archived"), if known. */
  state?: string;
  /** When the sandbox was created (ISO), if known — used to show uptime. */
  createdAt?: string;
}

/** Archived provider records cannot be resumed or controlled as workers. Daytona
 * keeps them around until auto-delete, but they should not appear in live worker
 * surfaces during that retention window. */
export function isVisibleSandbox(sandbox: Pick<SandboxHandle, "state">): boolean {
  return sandbox.state?.toLowerCase() !== "archived";
}

export interface CreateSandboxInput {
  /** Labels for ownership + reattachment. MUST include `workspace`. */
  labels: Record<string, string>;
  env?: Record<string, string>;
  /** Daytona snapshot name (preferred — honors entrypoint). Omit → base image. */
  snapshot?: string;
  /** Fallback base image when no snapshot (dev/smoke). */
  image?: string;
  /** Idle minutes before the provider auto-stops the box (the cost backstop).
   * Omit → provider default. Plus archive/delete cleanup intervals. */
  autoStopMinutes?: number;
  autoArchiveMinutes?: number;
  autoDeleteMinutes?: number;
}

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export interface StreamLogsInput {
  id: string;
  command: string;
  onChunk: (chunk: string) => void;
  onClose: () => void;
  onError?: (err: unknown) => void;
}

export interface Sandboxes {
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  exec(id: string, command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  /** Push a file (e.g. credentials) atomically, then chmod. */
  pushFile(id: string, path: string, content: string, mode?: string): Promise<void>;
  /** Run a long command and stream its output; resolves with an abort handle. */
  streamLogs(input: StreamLogsInput): Promise<{ abort: () => void }>;
  /** List sandboxes matching all the given labels (workspace-scoped reattach). */
  listByLabel(labels: Record<string, string>): Promise<SandboxHandle[]>;
  /** Start a stopped sandbox (resume after an idle auto-stop). */
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Permanently delete a sandbox (running or stopped) — full cleanup, not just
   * stop. Used when a task is terminal so the box stops billing and disappears. */
  delete(id: string): Promise<void>;
}
