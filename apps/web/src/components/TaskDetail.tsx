import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { type CardStatus } from "@manta/shared";
import { api, type TaskCard, type TaskDetail as TaskDetailData } from "../api.ts";
import { $activeWorkspaceId, $cards, $lastTaskUpdated, $me, $openTaskId, $taskChats, $taskContextUsage, $taskThinkingByCard, addToast, type ChatLine, type ContextUsage } from "../stores.ts";
import { acknowledgeWorkerChat } from "../ws.ts";
import { clipboardUploadedImageMarkdown, uploadImageMarkdown, insertIntoValueAtRange } from "../lib/images.ts";
import { useDebouncedLocalStorageDraft } from "../lib/localStorageDraft.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { FALLBACK_MODEL_OPTIONS, preferredCardModelOptions } from "../lib/modelOptions.ts";
import { shortTaskId } from "../lib/format.ts";
import { inputForMacOptionWordKey } from "../lib/terminalKeys.ts";
import { forwardTerminalEscape } from "../lib/terminalFocus.ts";
import { Logo } from "./ui.tsx";
import { PrBadge } from "./Board.tsx";

export function renderLine(l: ChatLine, i: number) {
  if (l.role === "tool") {
    const truncated = l.argsPreview
      ? l.argsPreview.length > 80
        ? l.argsPreview.slice(0, 80).replace(/\s+/g, " ") + "…"
        : l.argsPreview.replace(/\s+/g, " ")
      : "";
    return (
      <details key={i} className="tool-call">
        <summary>🔧 {l.text}{truncated && <span className="tool-args-inline"> {truncated}</span>}</summary>
        {l.argsPreview && <pre className="tool-args">{l.argsPreview}</pre>}
      </details>
    );
  }
  if (l.role === "thinking") {
    return <div key={i} className="thinking-block">{l.text}</div>;
  }
  if (l.role === "status") {
    return <div key={i} className="status-line">{l.text}</div>;
  }
  if (l.role === "setup") {
    return <div key={i} className="setup-output">{l.text}</div>;
  }
  if (l.role === "assistant" || l.role === "user") {
    // Markdown can contain text sourced from Linear/GitHub/user input, so the
    // rendered HTML must be sanitized before it reaches dangerouslySetInnerHTML.
    const html = renderMarkdown(l.text);
    return <div key={i} className={`bubble ${l.role} markdown`} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div key={i} className={`bubble ${l.role}`}>{l.text}</div>;
}

/** Map a cloud sandbox's venueStatus to a short, human label + tooltip. Returns
 * null for non-cloud or inert states (no badge shown). */
function venueBadge(workerVenue: string, venueStatus: string): { label: string; title: string } | null {
  if (workerVenue !== "daytona") return null;
  switch (venueStatus) {
    case "provisioning": return { label: "Cloud · waking…", title: "Starting a cloud sandbox for this task" };
    case "active": return { label: "Cloud · running", title: "A cloud sandbox is actively working" };
    case "idle": return { label: "Cloud · idle", title: "Cloud sandbox is warm — will sleep soon if no follow-up" };
    case "stopped": return { label: "Cloud · asleep", title: "Cloud sandbox is asleep — send a message to wake it" };
    case "failed": return { label: "Cloud · failed", title: "The cloud sandbox failed to start" };
    default: return null;
  }
}

function setupProgress(card: TaskCard, hasWorkerOutput: boolean, thinking: boolean): { title: string; detail: string } | null {
  if (thinking) return null;
  if (card.cardStatus !== "bot_working" && card.cardStatus !== "interactive") return null;
  if (card.workerStatus === "failed" || card.workerStatus === "stalled") return null;

  if (card.workerVenue === "daytona" && card.venueStatus === "provisioning") {
    return { title: "Starting cloud sandbox…", detail: "Provisioning compute, credentials, and the worker daemon." };
  }
  if (!card.branch) {
    if (card.workerVenue === "daytona") {
      return { title: "Preparing cloud checkout…", detail: "The sandbox is checking out the repo and warming up." };
    }
    if (card.workerVenue === "laptop") {
      return { title: "Preparing local checkout…", detail: "Your worker is cloning or opening the repo worktree." };
    }
    return { title: "Assigning a worker…", detail: "Manta is choosing a local worker or cloud sandbox for this card." };
  }
  if (!hasWorkerOutput) {
    return { title: "Finishing setup…", detail: "The checkout is ready; setup commands may still be running before the agent starts." };
  }
  return null;
}

function chatWorkerNotice(card: TaskCard, localWorkerStatus: TaskCard["localWorkerStatus"]): { text: string; tone: "info" | "warn" } | null {
  if (card.cardStatus === "done" || card.cardStatus === "canceled") return null;
  if (card.workerVenue === "daytona") {
    if (card.venueStatus === "provisioning") return { text: "Cloud sandbox is reconnecting... please give it a moment", tone: "warn" };
    if (card.venueStatus === "active") return { text: "Cloud sandbox connected - messages go to the cloud worker", tone: "info" };
    if (card.venueStatus === "idle") return { text: "Cloud sandbox idle - messages will reuse the warm cloud worker", tone: "info" };
    if (card.venueStatus === "stopped") return { text: "Cloud sandbox is asleep - messaging will wake it", tone: "warn" };
    if (card.venueStatus === "failed") return { text: "Cloud sandbox is unavailable - messaging will try to spin up a cloud worker", tone: "warn" };
    return { text: "Assigning a cloud worker...", tone: "info" };
  }
  if (localWorkerStatus === "online") return { text: "Local worker connected - messages go to your local worker", tone: "info" };
  if (localWorkerStatus === "reconnecting") return { text: "Worker is reconnecting... please give it a moment", tone: "warn" };
  if (localWorkerStatus === "offline") return { text: "No local worker - messaging will spin up a cloud worker", tone: "warn" };
  return { text: "Assigning a worker...", tone: "info" };
}

function SetupProgress({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="setup-progress" role="status" aria-live="polite">
      <span className="setup-spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function ContextUsageBar({ usage }: { usage: ContextUsage }) {
  const percent = Math.max(0, Math.min(100, usage.percent));
  const level = percent >= 80 ? "high" : percent >= 50 ? "medium" : "low";
  const tokens = usage.tokens.toLocaleString();
  const contextWindow = usage.contextWindow.toLocaleString();

  return (
    <span
      className={`context-usage-bar context-usage-${level}`}
      title={`Context: ${usage.percent}% (${tokens}/${contextWindow} tokens)`}
      role="meter"
      aria-label="Context usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${usage.percent}%`}
    >
      <span className="context-usage-label">Context</span>
      <span className="context-usage-track" aria-hidden="true">
        <span className="context-usage-fill" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

const TASK_DETAIL_MOBILE_QUERY = "(max-width: 640px)";
/** Stable empty transcript so a card with no streamed lines yet keeps a constant
 *  array identity across renders. */
const EMPTY_CHAT: ChatLine[] = [];

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

type TerminalStatus = "connecting" | "direct" | "relay" | "offline";

const TERMINAL_STATUS_META: Record<TerminalStatus, { label: string; color: string }> = {
  connecting: { label: "connecting…", color: "#888" },
  direct: { label: "direct", color: "#4ade80" },
  relay: { label: "relay", color: "#fbbf24" },
  offline: { label: "disconnected", color: "#f87171" },
};

type TerminalTab = { id: string; label: string };

const DEFAULT_TERMINAL_TABS: TerminalTab[] = [{ id: "default", label: "Terminal 1" }];

type PersistedTerminalState = { tabs: TerminalTab[]; activeTerminalId: string };

function defaultTerminalState(): PersistedTerminalState {
  return { tabs: [...DEFAULT_TERMINAL_TABS], activeTerminalId: DEFAULT_TERMINAL_TABS[0]!.id };
}

function normalizeTerminalState(value: unknown): PersistedTerminalState {
  if (!value || typeof value !== "object") return defaultTerminalState();
  const maybe = value as { tabs?: unknown; activeTerminalId?: unknown };
  const tabs = Array.isArray(maybe.tabs)
    ? maybe.tabs.filter((tab): tab is TerminalTab => {
      if (!tab || typeof tab !== "object") return false;
      const t = tab as { id?: unknown; label?: unknown };
      return typeof t.id === "string" && t.id !== "" && t.id !== "plan" && typeof t.label === "string" && t.label !== "";
    })
    : [];
  if (tabs.length === 0) return defaultTerminalState();
  const activeTerminalId = typeof maybe.activeTerminalId === "string" && maybe.activeTerminalId !== "plan" && tabs.some((tab) => tab.id === maybe.activeTerminalId)
    ? maybe.activeTerminalId
    : tabs[0]!.id;
  return { tabs, activeTerminalId };
}

// The PTY runs on the worker that holds this task's worktree. We prefer a DIRECT
// loopback connection to that worker (same machine as the browser → no server
// hop); if there's no direct endpoint or it doesn't connect quickly, we fall back
// to the server RELAY. Both speak the same {input|resize}/{output|ready} protocol.
function TerminalPane({ workspaceId, taskId, terminalId, workerVenue }: { workspaceId: string; taskId: string; terminalId: string; workerVenue: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  // Bumped to force a fresh connection attempt (used by the cloud resume flow,
  // which polls until the woken daemon dials back in).
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    // macOptionIsMeta: send ESC-prefixed sequences for Option/Alt chords (Option+f
    // → ESC f → zsh forward-word) instead of composed characters. Without it, word
    // navigation leaks raw escape-sequence tails (e.g. ";3C") into the shell.
    const term = new XTerm({ theme: { background: "#0d0d0d" }, fontSize: 11, fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", cursorBlink: true, macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Defer the initial fit so the browser finishes laying out the panel
    // before xterm measures the container — otherwise the terminal renders
    // with wrong dimensions and only fixes itself on the next resize event.
    requestAnimationFrame(() => {
      if (cancelled) return;
      fit.fit();
      sendToWs({ type: "resize", cols: term.cols, rows: term.rows });
    });

    // The active socket can switch (direct → relay fallback); input/resize always
    // target whichever socket is currently live.
    let activeWs: WebSocket | null = null;
    let pendingWs: WebSocket | null = null;
    const sendToWs = (obj: unknown) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) activeWs.send(JSON.stringify(obj));
    };

    term.attachCustomKeyEventHandler((event) => {
      if (forwardTerminalEscape(event, term.textarea ?? null, (data) => {
        sendToWs({ type: "input", data });
      }, () => {
        requestAnimationFrame(() => { if (!cancelled) term.focus(); });
      })) return false;
      const data = inputForMacOptionWordKey(event);
      if (!data) return true;
      sendToWs({ type: "input", data });
      return false;
    });

    // Measure the laid-out terminal so we can seed the PTY at the right size on
    // connect (the server/worker spawn the shell with these). Falls back to 80×24
    // if the container hasn't been measured yet.
    const currentDims = () => {
      try { fit.fit(); } catch { /* container not laid out yet */ }
      const cols = Number.isFinite(term.cols) && term.cols > 0 ? term.cols : 80;
      const rows = Number.isFinite(term.rows) && term.rows > 0 ? term.rows : 24;
      return { cols, rows };
    };

    const attach = (socket: WebSocket) => {
      activeWs = socket;
      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as { type: string; data?: string };
          if (msg.type === "output" && msg.data) term.write(msg.data);
        } catch { /* ignore */ }
      };
    };

    term.onData((data) => sendToWs({ type: "input", data }));
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendToWs({ type: "resize", cols: term.cols, rows: term.rows });
    });
    ro.observe(el);

    const connectRelay = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const d = currentDims();
      const socket = new WebSocket(`${proto}://${window.location.host}/terminal?workspaceId=${workspaceId}&taskId=${taskId}&terminalId=${encodeURIComponent(terminalId)}&cols=${d.cols}&rows=${d.rows}`);
      pendingWs = socket;
      attach(socket);
      socket.onopen = () => {
        if (!cancelled) {
          setStatus("relay");
          sendToWs({ type: "resize", cols: term.cols, rows: term.rows });
        }
      };
      // Only reflect offline if this socket is still the active one.
      socket.onclose = () => { if (!cancelled && activeWs === socket) setStatus("offline"); };
    };

    void (async () => {
      let direct: { host: string; port: number; token: string } | null = null;
      try {
        ({ direct } = await api.terminalEndpoint(workspaceId, taskId, terminalId));
      } catch { /* fall through to relay */ }
      if (cancelled) return;

      if (!direct) { connectRelay(); return; }

      // Try the worker's loopback port. If it doesn't open within the window
      // (worker is remote, or this browser isn't on that machine), use the relay.
      let socket: WebSocket;
      const d = currentDims();
      try {
        socket = new WebSocket(`ws://${direct.host}:${direct.port}/terminal?taskId=${encodeURIComponent(taskId)}&terminalId=${encodeURIComponent(terminalId)}&token=${direct.token}&cols=${d.cols}&rows=${d.rows}`);
      } catch {
        // Browsers can synchronously reject loopback ws:// from some secure
        // contexts. That should not strand the reconnect flow: use the server
        // relay, which speaks the same terminal protocol.
        connectRelay();
        return;
      }
      pendingWs = socket;
      let settled = false;
      const fallback = () => {
        if (settled || cancelled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        connectRelay();
      };
      const timer = setTimeout(fallback, 1500);
      socket.onopen = () => {
        if (cancelled) { try { socket.close(); } catch { /* ignore */ } return; }
        settled = true;
        clearTimeout(timer);
        setStatus("direct");
        attach(socket);
        sendToWs({ type: "resize", cols: term.cols, rows: term.rows });
      };
      socket.onerror = () => { clearTimeout(timer); fallback(); };
      socket.onclose = () => {
        if (!settled) { clearTimeout(timer); fallback(); }
        // A direct close AFTER fallback already switched to the relay must not
        // flip status to offline — only report it if direct is still active.
        else if (!cancelled && activeWs === socket) setStatus("offline");
      };
    })();

    return () => {
      cancelled = true;
      ro.disconnect();
      try { activeWs?.close(); } catch { /* ignore */ }
      try { pendingWs?.close(); } catch { /* ignore */ }
      term.dispose();
    };
  }, [workspaceId, taskId, terminalId, reconnectNonce]);

  // Cloud resume: once we ask the server to wake the box, the daemon takes ~15-30s
  // to boot and dial back. Re-attempt the connection on a cadence until it's up
  // (status leaves "offline") or we give up after a bounded window.
  useEffect(() => {
    if (!resuming) return;
    if (status === "relay" || status === "direct") { setResuming(false); return; }
    const startedAt = Date.now();
    const t = setInterval(() => {
      if (Date.now() - startedAt > 75_000) { setResuming(false); return; }
      setReconnectNonce((n) => n + 1);
    }, 6000);
    return () => clearInterval(t);
  }, [resuming, status]);

  const resume = async () => {
    setResuming(true);
    setReconnectError(null);
    try { await api.resumeSandbox(taskId, workspaceId); } catch { /* the poll keeps retrying */ }
    setReconnectNonce((n) => n + 1); // kick an immediate attempt
  };

  const reconnect = async () => {
    setResuming(true);
    setReconnectError(null);
    try {
      await api.reconnectTerminal(workspaceId, taskId);
    } catch (err) {
      setResuming(false);
      setReconnectError(err instanceof Error ? err.message : "Failed to reconnect worker");
      return;
    }
    setReconnectNonce((n) => n + 1); // kick an immediate attempt
  };

  const meta = TERMINAL_STATUS_META[status];
  // An offline terminal on a cloud task means the sandbox is asleep (or being
  // woken); on a local task it means this card lost its terminal→worker routing.
  // Offer an explicit reconnect instead of dead-ending on a red status badge.
  const showResume = workerVenue === "daytona" && (status === "offline" || resuming);
  const showReconnect = workerVenue !== "daytona" && (status === "offline" || resuming);
  return (
    <div className="terminal-pane" style={{ position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {showResume && (
        <div className="terminal-resume-overlay">
          <p className="muted">The cloud sandbox is asleep.</p>
          <button className="btn small primary" disabled={resuming} onClick={() => void resume()}>
            {resuming ? "Resuming…" : "Resume sandbox"}
          </button>
        </div>
      )}
      {showReconnect && (
        <div className="terminal-resume-overlay">
          <p className="muted">The worker is disconnected from this card.</p>
          {reconnectError && <p className="muted">Reconnect failed: {reconnectError}</p>}
          <button className="btn small primary" disabled={resuming} onClick={() => void reconnect()}>
            {resuming ? "Reconnecting…" : "Reconnect worker"}
          </button>
        </div>
      )}
      <span
        title={`Terminal transport: ${meta.label}`}
        style={{
          position: "absolute", top: 4, right: 8, fontSize: 9, lineHeight: "12px",
          padding: "1px 5px", borderRadius: 6, pointerEvents: "none",
          color: meta.color, background: "rgba(0,0,0,0.45)", fontFamily: "ui-monospace, monospace",
        }}
      >
        {meta.label}
      </span>
    </div>
  );
}

export function TaskDetail({ card, refreshNonce = 0 }: { card: TaskCard; refreshNonce?: number }) {
  // Read only THIS card's slot from the per-card maps, so another card's live
  // stream can never render here even while it's actively updating.
  const lines = useStore($taskChats)[card.id] ?? EMPTY_CHAT;
  const thinking = useStore($taskThinkingByCard)[card.id] ?? false;
  const taskContextUsage = useStore($taskContextUsage);
  const lastTaskUpdated = useStore($lastTaskUpdated);
  const activeWorkspaceId = useStore($activeWorkspaceId)!;
  const currentUserId = useStore($me)?.id;
  const [msg, setMsg, clearMsgDraft] = useDebouncedLocalStorageDraft(`manta:worker-chat-draft:${activeWorkspaceId}:${card.id}`);
  const [detail, setDetail] = useState<TaskDetailData | null>(null);
  const [termWidthPct, setTermWidthPct] = useState(0.5);
  const [showChecklist, setShowChecklist] = useState(false);
  const [mobilePane, setMobilePane] = useState<string>("worker");
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(() => defaultTerminalState().tabs);
  const [activeTerminalId, setActiveTerminalId] = useState(() => defaultTerminalState().activeTerminalId);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>(FALLBACK_MODEL_OPTIONS);
  const [modelBusy, setModelBusy] = useState(false);
  const isMobile = useMediaQuery(TASK_DETAIL_MOBILE_QUERY);
  const isDragging = useRef(false);
  const shouldScrollChatToBottom = useRef(false);
  const openingAutoScrollUntil = useRef(0);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taskCard = detail ?? card;
  const readOnlySpotCheck = taskCard.backgroundMode === "spot_check";
  const checklist = detail?.checklist ?? [];
  const planDocument = detail?.planDocument?.trim() ?? "";
  const hasPlanDocument = planDocument.length > 0;
  const checkedCount = checklist.filter((i) => i.checked).length;
  const hasTerminalPane = !readOnlySpotCheck && Boolean(taskCard.branch || hasPlanDocument);
  const hasSidePane = hasTerminalPane;
  const visibleMobilePane = hasSidePane ? mobilePane : "worker";
  const mobileBodyPane = visibleMobilePane === "worker" ? "worker" : "terminal";
  const activeTerminal = terminalTabs.find((t) => t.id === activeTerminalId) ?? terminalTabs[0] ?? DEFAULT_TERMINAL_TABS[0]!;
  const headerIsExpanded = !isMobile || headerExpanded;
  const hasWorkerOutput = lines.some((line) => line.role === "assistant" || line.role === "tool" || line.role === "thinking");
  const setup = setupProgress(taskCard, hasWorkerOutput, thinking);
  const contextUsage = taskContextUsage[card.id];
  const workerNotice = detail ? chatWorkerNotice(detail, detail.localWorkerStatus) : null;

  const reloadTask = useCallback((reset = false) => {
    if (reset) {
      setDetail(null);
      setShowChecklist(false);
    }
    api.getTask(activeWorkspaceId, card.id).then((d) => {
      const isMobileAfterLoad = typeof window !== "undefined" && window.matchMedia(TASK_DETAIL_MOBILE_QUERY).matches;
      const shouldAutoShowChecklist = !isMobileAfterLoad && d.checklist.some((item) => !item.checked);
      const savedTerminalState = normalizeTerminalState(d.terminalTabs);
      setDetail(d);
      setTerminalTabs(savedTerminalState.tabs);
      setActiveTerminalId(savedTerminalState.activeTerminalId);
      if (reset) setShowChecklist(shouldAutoShowChecklist);
      else if (shouldAutoShowChecklist) setShowChecklist(true);
    }).catch(() => {});
  }, [activeWorkspaceId, card.id]);

  useEffect(() => {
    reloadTask(true);
  }, [reloadTask]);

  useEffect(() => {
    api.models(activeWorkspaceId).then((v) => setModelOptions(preferredCardModelOptions(v))).catch(() => {});
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (lastTaskUpdated !== card.id) return;
    reloadTask();
  }, [lastTaskUpdated, card.id, reloadTask]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    reloadTask();
  }, [refreshNonce, reloadTask]);

  const prevHasPlanRef = useRef(false);
  useEffect(() => {
    if (hasPlanDocument && !prevHasPlanRef.current) {
      setActiveTerminalId("plan");
    }
    prevHasPlanRef.current = hasPlanDocument;
  }, [hasPlanDocument]);

  const scrollChatToBottom = useCallback(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const scheduleChatScrollToBottom = useCallback(() => {
    scrollChatToBottom();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      scrollChatToBottom();
      raf2 = requestAnimationFrame(scrollChatToBottom);
    });
    const timeout = window.setTimeout(scrollChatToBottom, 250);
    const laterTimeouts = [600, 1200, 2200].map((delay) => window.setTimeout(() => {
      if (Date.now() <= openingAutoScrollUntil.current) scrollChatToBottom();
    }, delay));
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      window.clearTimeout(timeout);
      laterTimeouts.forEach((t) => window.clearTimeout(t));
    };
  }, [scrollChatToBottom]);

  useEffect(() => {
    const initialTerminalState = defaultTerminalState();
    setMobilePane("worker");
    setTerminalTabs(initialTerminalState.tabs);
    setActiveTerminalId(initialTerminalState.activeTerminalId);
    setHeaderExpanded(false);
    shouldScrollChatToBottom.current = true;
    openingAutoScrollUntil.current = Date.now() + 2500;
  }, [card.id]);

  const persistTerminalTabs = (tabs: TerminalTab[], activeId: string) => {
    if (activeId === "plan") return;
    const activeTabId = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id;
    if (!activeTabId) return;
    void api.patchTerminalTabs(activeWorkspaceId, card.id, tabs, activeTabId).catch(() => {});
  };

  const selectTerminal = (id: string) => {
    setActiveTerminalId(id);
    setMobilePane(id);
    persistTerminalTabs(terminalTabs, id);
  };

  const addTerminal = () => {
    setTerminalTabs((tabs) => {
      const idx = tabs.length + 1;
      const tab = { id: `term-${Date.now().toString(36)}-${idx}`, label: `Terminal ${idx}` };
      const nextTabs = [...tabs, tab];
      setActiveTerminalId(tab.id);
      setMobilePane(tab.id);
      persistTerminalTabs(nextTabs, tab.id);
      return nextTabs;
    });
  };

  useLayoutEffect(() => {
    if (visibleMobilePane !== "worker") return;
    shouldScrollChatToBottom.current = true;
    return scheduleChatScrollToBottom();
  }, [card.id, isMobile, visibleMobilePane, scheduleChatScrollToBottom]);

  useEffect(() => {
    const el = chatLogRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (shouldScrollChatToBottom.current || Date.now() <= openingAutoScrollUntil.current || distFromBottom < 120) {
      shouldScrollChatToBottom.current = false;
      return scheduleChatScrollToBottom();
    }
  }, [lines, thinking, setup, scheduleChatScrollToBottom]);

  useEffect(() => {
    const content = chatContentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const el = chatLogRef.current;
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (Date.now() <= openingAutoScrollUntil.current || distFromBottom < 120) {
        scheduleChatScrollToBottom();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleChatScrollToBottom]);

  const [sendingMessage, setSendingMessage] = useState(false);
  const sendingMessageRef = useRef(false);
  const send = async () => {
    if (!msg.trim() || sendingMessageRef.current) return;
    const message = msg.trim();
    sendingMessageRef.current = true;
    setSendingMessage(true);
    try {
      await api.sendTaskMessage(activeWorkspaceId, card.id, message);
      clearMsgDraft();
      acknowledgeWorkerChat(card.id, message);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to send message", "error");
    } finally {
      sendingMessageRef.current = false;
      setSendingMessage(false);
    }
  };

  const insertMessageText = (text: string, start = inputRef.current?.selectionStart ?? msg.length, end = inputRef.current?.selectionEnd ?? start) => {
    let cursor = start;
    setMsg((current) => {
      const next = insertIntoValueAtRange(current, start, end, text);
      cursor = next.cursor;
      return next.value;
    });
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const start = e.currentTarget.selectionStart ?? msg.length;
    const end = e.currentTarget.selectionEnd ?? start;
    const markdown = await clipboardUploadedImageMarkdown(activeWorkspaceId, e);
    if (!markdown) return;
    insertMessageText(markdown, start, end);
  };

  const attachImages = async (files: FileList | null) => {
    const images = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const markdown = (await Promise.all(images.map((file) => uploadImageMarkdown(activeWorkspaceId, file)))).join("\n");
    insertMessageText(markdown);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const toggleChecklistItem = useCallback(async (itemId: string) => {
    if (!detail) return;
    const items = detail.checklist.map((i) => i.id === itemId ? { ...i, checked: !i.checked } : i);
    setDetail({ ...detail, checklist: items });
    await api.patchChecklist(activeWorkspaceId, card.id, items);
  }, [detail, activeWorkspaceId, card.id]);

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !mainAreaRef.current) return;
      const rect = mainAreaRef.current.getBoundingClientRect();
      const pct = (rect.right - ev.clientX) / rect.width;
      setTermWidthPct(Math.max(0.15, Math.min(0.75, pct)));
    };
    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const archiveCard = async () => {
    if (!confirm(`Archive "${card.title}"? It will be removed from the board.`)) return;
    await api.archiveTask(activeWorkspaceId, card.id);
    $openTaskId.set(null);
    api.tasks(activeWorkspaceId).then((r) => $cards.set(r.tasks)).catch(() => {});
  };

  const resurrectCard = async () => {
    const instruction = prompt("Optional instructions for the worker (leave blank to continue from where it left off):");
    if (instruction === null) return; // cancelled
    const updated = await api.resurrectTask(activeWorkspaceId, card.id, instruction || undefined);
    $cards.set($cards.get().map((c) => c.id === card.id ? { ...c, cardStatus: updated.cardStatus as CardStatus } : c));
  };

  const updateModel = async (workerBackend: string) => {
    if (workerBackend === taskCard.workerBackend || modelBusy) return;
    setModelBusy(true);
    try {
      const updated = await api.setTaskModel(activeWorkspaceId, card.id, workerBackend);
      $cards.set($cards.get().map((c) => c.id === card.id ? { ...c, workerBackend: updated.workerBackend } : c));
    } finally {
      setModelBusy(false);
    }
  };

  return (
    <div className="detail">
      <div className={`detail-head ${headerIsExpanded ? "expanded" : ""}`}>
        <div className="detail-head-row">
          <button className="btn ghost" onClick={() => $openTaskId.set(null)}>← Board</button>
          <button className="detail-title-toggle" onClick={() => { if (isMobile) setHeaderExpanded((v) => !v); }} aria-expanded={headerIsExpanded}>
            <strong>{taskCard.title}</strong>
            {isMobile && <span className="detail-title-chevron" aria-hidden="true">{headerExpanded ? "⌃" : "⌄"}</span>}
          </button>
        </div>
        {headerIsExpanded && (
          <div className="detail-head-expanded">
            <div className="detail-meta">
              <span className={`status-badge status-${taskCard.cardStatus}`}>{taskCard.cardStatus.replace(/_/g, " ")}</span>
              {(() => {
                const vb = venueBadge(taskCard.workerVenue, taskCard.venueStatus);
                return vb ? <span className={`venue-badge venue-${taskCard.venueStatus}`} title={vb.title}>{vb.label}</span> : null;
              })()}
              {contextUsage && <ContextUsageBar usage={contextUsage} />}
              <span className="muted small">{taskCard.repo}</span>
              {detail?.createdBy && detail.createdBy !== currentUserId && (
                <span className="muted small">Worker owner: {detail.ownerName || detail.ownerEmail || detail.createdBy}</span>
              )}
              <span className="muted small" title={taskCard.id}>{shortTaskId(taskCard.id)}</span>
              {taskCard.branch && <span className="muted small">{taskCard.branch}</span>}
              {taskCard.linearIssueIdentifier && (taskCard.linearIssueUrl
                ? <a className="linear-badge" href={taskCard.linearIssueUrl} target="_blank" rel="noreferrer">{taskCard.linearIssueIdentifier}</a>
                : <span className="linear-badge">{taskCard.linearIssueIdentifier}</span>
              )}
              {taskCard.prNumber && taskCard.prUrl && (
                <PrBadge card={taskCard} className="pr-badge" />
              )}
            </div>
            <div className="detail-actions">
              {!readOnlySpotCheck && <label className="detail-model-picker">
                <span className="muted small">Model</span>
                <select value={taskCard.workerBackend} disabled={modelBusy} onChange={(e) => void updateModel(e.target.value)}>
                  {!modelOptions.some((m) => m.id === taskCard.workerBackend) && <option value={taskCard.workerBackend}>{taskCard.workerBackend}</option>}
                  {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>}
              {!readOnlySpotCheck && taskCard.cardStatus === "needs_help" && (
                <button className="btn ghost small" onClick={resurrectCard}>Retry Worker</button>
              )}
              {!readOnlySpotCheck && <button className={`btn ghost small ${showChecklist ? "on" : ""}`} onClick={() => setShowChecklist((v) => !v)} title="Toggle checklist">Checklist</button>}
              {!readOnlySpotCheck && <button className="btn ghost small muted" onClick={archiveCard}>Archive</button>}
            </div>
          </div>
        )}
      </div>
      <div className={`detail-body mobile-show-${mobileBodyPane}`} ref={mainAreaRef}>
        {hasSidePane && (
          <div className="detail-mobile-tabs" role="tablist" aria-label="Card detail panes">
            <button className={`detail-mobile-tab ${visibleMobilePane === "worker" ? "on" : ""}`} role="tab" aria-selected={visibleMobilePane === "worker"} onClick={() => setMobilePane("worker")}>Worker</button>
            {hasPlanDocument ? (
              <button className={`detail-mobile-tab ${visibleMobilePane === "plan" ? "on" : ""}`} role="tab" aria-selected={visibleMobilePane === "plan"} onClick={() => setMobilePane("plan")}>Plan</button>
            ) : terminalTabs.map((tab) => (
              <button key={tab.id} className={`detail-mobile-tab ${visibleMobilePane === tab.id ? "on" : ""}`} role="tab" aria-selected={visibleMobilePane === tab.id} onClick={() => selectTerminal(tab.id)}>{tab.label}</button>
            ))}
            {hasTerminalPane && <button className="detail-mobile-tab add" type="button" title="New terminal" aria-label="New terminal" onClick={addTerminal}>+</button>}
          </div>
        )}
        <div className="detail-chat-col">
          <div className="chat-log" ref={chatLogRef} onWheel={() => { openingAutoScrollUntil.current = 0; }} onTouchStart={() => { openingAutoScrollUntil.current = 0; }}>
            <div className="chat-log-content" ref={chatContentRef}>
              {lines.length === 0 && !setup && <p className="muted">No worker activity yet.</p>}
              {lines.map(renderLine)}
              {setup && <SetupProgress title={setup.title} detail={setup.detail} />}
              {thinking && <div className="bubble assistant thinking"><Logo /> working…</div>}
            </div>
          </div>
          {workerNotice && <div className={`chat-worker-notice ${workerNotice.tone}`} role="status" aria-live="polite">{workerNotice.text}</div>}
          {readOnlySpotCheck ? <div className="muted small chat-input">This spot-check run is read-only.</div> : <div className="chat-input">
            <textarea ref={inputRef} value={msg} placeholder={thinking ? "Interrupt the worker…" : "Message the worker…"}
                      onChange={(e) => setMsg(e.target.value)}
                      onPaste={(e) => void handlePaste(e)}
                      disabled={sendingMessage}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <div className="chat-input-actions">
              <input ref={fileInputRef} className="hidden-file-input" type="file" accept="image/*" multiple onChange={(e) => void attachImages(e.currentTarget.files)} />
              <button className="btn ghost icon-btn" type="button" title="Attach image" aria-label="Attach image" onClick={() => fileInputRef.current?.click()}>📎</button>
              <button className="btn primary chat-send-btn" type="button" disabled={!msg.trim() || sendingMessage} onClick={() => void send()}>{sendingMessage ? "Sending…" : "Send"}</button>
            </div>
          </div>}
        </div>
        {hasTerminalPane && (
          <>
            <div className="detail-resize-handle" onMouseDown={onDividerMouseDown} />
            <div className="detail-terminal-col" style={{ width: `${termWidthPct * 100}%` }}>
              <div className="terminal-tabs" role="tablist" aria-label="Terminals">
                {hasPlanDocument && (
                  <button key="plan" className={`terminal-tab ${activeTerminalId === "plan" ? "on" : ""}`} role="tab" aria-selected={activeTerminalId === "plan"} onClick={() => setActiveTerminalId("plan")}>Plan</button>
                )}
                {taskCard.branch && terminalTabs.map((tab) => (
                  <button key={tab.id} className={`terminal-tab ${activeTerminalId === tab.id ? "on" : ""}`} role="tab" aria-selected={activeTerminalId === tab.id} onClick={() => selectTerminal(tab.id)}>{tab.label}</button>
                ))}
                {taskCard.branch && <button className="terminal-tab add" type="button" title="New terminal" aria-label="New terminal" onClick={addTerminal}>+</button>}
              </div>
              {activeTerminalId === "plan"
                ? <div className="detail-plan markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(planDocument) }} />
                : (!isMobile || visibleMobilePane !== "worker") && <TerminalPane key={activeTerminal.id} workspaceId={activeWorkspaceId} taskId={taskCard.id} terminalId={activeTerminal.id} workerVenue={taskCard.workerVenue} />
              }
            </div>
          </>
        )}
        {showChecklist && <div className="detail-checklist-sidebar">
          <div className="checklist-sidebar-head">
            <span className="muted small">Checklist{checklist.length > 0 ? ` (${checkedCount}/${checklist.length})` : ""}</span>
          </div>
          {!detail && <p className="muted" style={{ padding: "8px 12px" }}>Loading…</p>}
          {detail && checklist.length === 0 && <p className="muted small" style={{ padding: "8px 12px" }}>No checklist yet.</p>}
          {checklist.map((item) => (
            <label key={item.id} className={`checklist-item ${item.checked ? "checked" : ""}`}>
              <input type="checkbox" checked={item.checked} onChange={() => void toggleChecklistItem(item.id)} />
              <span>{item.text}</span>
            </label>
          ))}
          {detail?.description && (
            <details className="task-description" open={checklist.length === 0}>
              <summary className="muted small">Description</summary>
              <pre className="description-text">{detail.description}</pre>
            </details>
          )}
        </div>}
      </div>
    </div>
  );
}
