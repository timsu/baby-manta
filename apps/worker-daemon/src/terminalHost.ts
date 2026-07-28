import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { TerminalManager, WorktreeMissingError, type TerminalFrame, type TerminalSink } from "@manta/shared/terminal";

interface TerminalHostOptions {
  getWorktree: (taskId: string) => string | undefined;
  log: (message: string) => void;
  error: (message: string, ...rest: unknown[]) => void;
}

export interface TerminalHost {
  readonly port: number | null;
  start: () => Promise<number | null>;
  disposeTask: (taskId: string) => void;
  attachRelayTerminal: (
    send: (msg: unknown) => void,
    taskId: string,
    sessionId: string,
    cwd: string | undefined,
  ) => void;
  handleRelayMessage: (msg: Record<string, unknown>, send: (msg: unknown) => void) => boolean;
}

export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
  const terminals = new TerminalManager();
  /** Direct-port grants the server vouched for: token → {taskId, terminalId, exp(ms)}. */
  const terminalGrants = new Map<string, { taskId: string; terminalId: string; exp: number }>();
  /** Loopback port for direct terminal access; null until the server starts (or if
   * direct access is disabled, e.g. a remote/Daytona worker). */
  let terminalPort: number | null = null;

  function pruneGrants(): void {
    const now = Date.now();
    for (const [token, g] of terminalGrants) if (g.exp < now) terminalGrants.delete(token);
  }

  /** Read terminal dimensions a client supplied so the PTY can spawn at its real
   * size. Returns undefined unless both are sane positive integers. */
  function parseDims(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
    const c = Number(cols);
    const r = Number(rows);
    if (Number.isInteger(c) && c >= 1 && c <= 65535 && Number.isInteger(r) && r >= 1 && r <= 65535) {
      return { cols: c, rows: r };
    }
    return undefined;
  }

  /** Map a PTY frame to the browser wire protocol (the direct path speaks this). */
  function frameToBrowser(frame: TerminalFrame): Record<string, unknown> {
    return frame.type === "output" ? { type: "output", data: frame.data } : { type: frame.type };
  }

  /** Map a PTY frame to a /worker-ws relay envelope (the relay path speaks this). */
  function relayFrame(frame: TerminalFrame, taskId: string, sessionId: string): Record<string, unknown> {
    if (frame.type === "output") return { type: "terminal_output", taskId, sessionId, data: frame.data };
    if (frame.type === "exit") return { type: "terminal_exit", taskId, sessionId, code: frame.code };
    return { type: "terminal_ready", taskId, sessionId };
  }

  /** Attach a relayed viewer: PTY frames travel back over the daemon's /worker-ws. */
  function attachRelayTerminal(
    send: (msg: unknown) => void,
    taskId: string,
    sessionId: string,
    cwd: string | undefined,
    terminalId = "default",
    dims?: { cols: number; rows: number },
  ): void {
    const worktree = options.getWorktree(taskId) ?? cwd;
    if (!worktree) {
      send({ type: "terminal_error", taskId, sessionId, message: "no worktree for this task on this worker" });
      return;
    }
    const sink: TerminalSink = {
      send: (frame) => send(relayFrame(frame, taskId, sessionId)),
      close: () => send({ type: "terminal_exit", taskId, sessionId }),
    };
    try {
      terminals.attach(sink, taskId, worktree, sessionId, terminalId, dims);
    } catch (err) {
      const message = err instanceof WorktreeMissingError
        ? "worktree missing on worker"
        : err instanceof Error ? err.message : String(err);
      send({ type: "terminal_error", taskId, sessionId, message });
    }
  }

  /** Handle a direct (same-machine) browser WebSocket on the loopback port. The
   * browser presents a server-minted token; we only attach if the server told us
   * to expect it (terminal_grant), so arbitrary local processes can't connect. */
  function handleDirectTerminal(socket: WsSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const taskId = url.searchParams.get("taskId") ?? "";
    const terminalId = url.searchParams.get("terminalId") || "default";
    const token = url.searchParams.get("token") ?? "";
    pruneGrants();
    const grant = terminalGrants.get(token);
    if (!taskId || !grant || grant.taskId !== taskId || grant.terminalId !== terminalId || grant.exp < Date.now()) {
      socket.close(1008, "unauthorized");
      return;
    }
    const sink: TerminalSink = {
      send: (frame) => { if (socket.readyState === WsSocket.OPEN) socket.send(JSON.stringify(frameToBrowser(frame))); },
      close: (code, reason) => { try { socket.close(code, reason); } catch { /* already closed */ } },
    };
    const worktree = options.getWorktree(taskId);
    if (!worktree) {
      sink.send({ type: "output", data: "\r\nNo worktree for this task on this worker.\r\n" });
      socket.close(1011, "no worktree");
      return;
    }
    const sessionId = randomBytes(8).toString("hex");
    const dims = parseDims(url.searchParams.get("cols"), url.searchParams.get("rows"));
    let cleanup = (): void => {};
    try {
      cleanup = terminals.attach(sink, taskId, worktree, sessionId, terminalId, dims);
    } catch (err) {
      const message = err instanceof WorktreeMissingError ? "worktree missing" : err instanceof Error ? err.message : String(err);
      sink.send({ type: "output", data: `\r\nFailed to start terminal: ${message}\r\n` });
      socket.close(1011, "spawn failed");
      return;
    }
    socket.on("message", (data) => {
      try {
        const m = JSON.parse(String(data)) as { type: string; data?: string; cols?: number; rows?: number };
        if (m.type === "input" && typeof m.data === "string") terminals.input(taskId, { type: "input", data: m.data }, terminalId);
        else if (m.type === "resize" && m.cols && m.rows) terminals.input(taskId, { type: "resize", cols: m.cols, rows: m.rows }, terminalId);
      } catch { /* ignore malformed */ }
    });
    socket.on("close", () => cleanup());
  }

  /** Stand up the loopback WS server for direct terminal access. Idempotent;
   * disabled with MANTA_DIRECT_TERMINAL=0 (set on remote/Daytona workers where the
   * browser is never on the same host). */
  function start(): Promise<number | null> {
    if (terminalPort !== null) return Promise.resolve(terminalPort);
    if (process.env["MANTA_DIRECT_TERMINAL"] === "0") {
      options.log("direct terminal disabled (MANTA_DIRECT_TERMINAL=0) — relay only");
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        // The SPA is https; loopback is exempt from mixed-content blocking, but a
        // Private Network Access preflight may probe over HTTP before the WS upgrade.
        // Answer it so the upgrade isn't blocked. WS upgrades skip this handler.
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.writeHead(req.method === "OPTIONS" ? 204 : 404);
        res.end();
      });
      const wss = new WebSocketServer({ server: httpServer, path: "/terminal" });
      wss.on("connection", handleDirectTerminal);
      httpServer.on("error", (err) => { options.error("direct terminal server failed to start", err); resolve(null); });
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        terminalPort = typeof addr === "object" && addr ? addr.port : null;
        options.log(`direct terminal server listening on 127.0.0.1:${terminalPort}`);
        resolve(terminalPort);
      });
    });
  }

  function handleRelayMessage(msg: Record<string, unknown>, send: (msg: unknown) => void): boolean {
    if (msg["type"] === "terminal_open") {
      attachRelayTerminal(send, String(msg["taskId"]), String(msg["sessionId"]), msg["cwd"] as string | undefined, String(msg["terminalId"] ?? "default"), parseDims(msg["cols"], msg["rows"]));
      return true;
    }
    if (msg["type"] === "terminal_input") {
      if (typeof msg["data"] === "string") terminals.input(String(msg["taskId"]), { type: "input", data: msg["data"] }, String(msg["terminalId"] ?? "default"));
      return true;
    }
    if (msg["type"] === "terminal_resize") {
      terminals.input(String(msg["taskId"]), { type: "resize", cols: Number(msg["cols"]), rows: Number(msg["rows"]) }, String(msg["terminalId"] ?? "default"));
      return true;
    }
    if (msg["type"] === "terminal_close") {
      terminals.detach(String(msg["taskId"]), String(msg["sessionId"]), String(msg["terminalId"] ?? "default"));
      return true;
    }
    if (msg["type"] === "dispose_task") {
      const taskId = String(msg["taskId"] ?? "");
      if (taskId) terminals.killTask(taskId);
      return true;
    }
    if (msg["type"] === "terminal_grant") {
      const token = msg["token"] as string | undefined;
      const taskId = msg["taskId"] as string | undefined;
      const terminalId = String(msg["terminalId"] ?? "default");
      const exp = Number(msg["exp"]);
      if (token && taskId && exp) { terminalGrants.set(token, { taskId, terminalId, exp }); pruneGrants(); }
      return true;
    }
    return false;
  }

  return {
    get port() { return terminalPort; },
    start,
    disposeTask: (taskId: string) => terminals.killTask(taskId),
    attachRelayTerminal,
    handleRelayMessage,
  };
}
