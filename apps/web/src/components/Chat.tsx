import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import type { AgentEvent } from "@manta/shared";
import { api } from "../api.ts";
import { $chat, $repos, $thinking, $workspaceDefaultModel, $workspaceModels, type ChatLine } from "../stores.ts";
import { sendChatWs } from "../ws.ts";
import { clipboardUploadedImageMarkdown, insertIntoValueAtRange } from "../lib/images.ts";
import { $activeWorkspaceId } from "../stores.ts";
import { Logo } from "./ui.tsx";
import { renderLine } from "./TaskDetail.tsx";
import { SlashMenu, getSlashQuery, useSlashCommands } from "./SlashMenu.tsx";
import { defaultRepoChatModelId } from "../lib/modelOptions.ts";

export function Chat() {
  const [mode, setMode] = useState<"brain" | "repo">("brain");
  const workspaceId = useStore($activeWorkspaceId);
  return (
    <div className="chat">
      <div className="chat-head chat-mode-tabs" role="tablist" aria-label="Chat target">
        <button className={mode === "brain" ? "on" : ""} role="tab" aria-selected={mode === "brain"} onClick={() => setMode("brain")}>Brain</button>
        <button className={mode === "repo" ? "on" : ""} role="tab" aria-selected={mode === "repo"} onClick={() => setMode("repo")}>Repo</button>
      </div>
      <p className="chat-mode-description" aria-live="polite">
        {mode === "brain"
          ? "Plan and manage tasks across this board."
          : "Explore a repo checkout and turn findings into cards."}
      </p>
      <div className="chat-pane" hidden={mode !== "brain"}><BrainChat /></div>
      <div className="chat-pane" hidden={mode !== "repo"}><RepoChat key={workspaceId ?? "none"} /></div>
    </div>
  );
}

function BrainChat() {
  const chat = useStore($chat);
  const thinking = useStore($thinking);
  const workspaceId = useStore($activeWorkspaceId);
  const [msg, setMsg] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSelIdx, setSlashSelIdx] = useState(0);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const openingAutoScrollUntil = useRef(Date.now() + 2500);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const slashQuery = slashOpen ? getSlashQuery(msg, cursorPos) : null;
  const slashCommands = useSlashCommands(workspaceId, slashQuery);
  const hasSlashMenu = slashOpen && slashCommands.length > 0;

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
    const timeouts = [250, 600, 1200, 2200].map((delay) => window.setTimeout(() => {
      if (delay === 250 || Date.now() <= openingAutoScrollUntil.current) scrollChatToBottom();
    }, delay));
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      timeouts.forEach((t) => window.clearTimeout(t));
    };
  }, [scrollChatToBottom]);

  useLayoutEffect(() => scheduleChatScrollToBottom(), [scheduleChatScrollToBottom]);

  useEffect(() => {
    openingAutoScrollUntil.current = Date.now() + 2500;
  }, [workspaceId]);

  useEffect(() => {
    const el = chatLogRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (Date.now() <= openingAutoScrollUntil.current || distFromBottom < 120) {
      return scheduleChatScrollToBottom();
    }
  }, [chat, thinking, scheduleChatScrollToBottom]);

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

  const send = () => {
    if (!msg.trim()) return;
    if (sendChatWs(msg.trim())) setMsg("");
    setSlashOpen(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart ?? val.length;
    setMsg(val);
    setCursorPos(pos);
    const query = getSlashQuery(val, pos);
    setSlashOpen(query !== null);
    setSlashSelIdx(0);
  };

  const handleSelect = (command: string) => {
    const before = msg.slice(0, cursorPos);
    const slashIdx = before.lastIndexOf("/");
    if (slashIdx >= 0) {
      const suffix = msg.slice(cursorPos).match(/^[\w-]*/)?.[0] ?? "";
      const tokenEnd = cursorPos + suffix.length;
      const newVal = msg.slice(0, slashIdx) + command + " " + msg.slice(tokenEnd);
      setMsg(newVal);
      const newPos = slashIdx + command.length + 1;
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(newPos, newPos);
        setCursorPos(newPos);
      }, 0);
    }
    setSlashOpen(false);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const start = e.currentTarget.selectionStart ?? msg.length;
    const end = e.currentTarget.selectionEnd ?? start;
    if (!workspaceId) return;
    const markdown = await clipboardUploadedImageMarkdown(workspaceId, e);
    if (!markdown) return;
    let cursor = start;
    setMsg((current) => {
      const next = insertIntoValueAtRange(current, start, end, markdown);
      cursor = next.cursor;
      return next.value;
    });
    setTimeout(() => inputRef.current?.setSelectionRange(cursor, cursor), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hasSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelIdx((i) => (i + 1) % slashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelIdx((i) => (i - 1 + slashCommands.length) % slashCommands.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const cmd = slashCommands[slashSelIdx];
        if (cmd) handleSelect(cmd.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      <div className="chat-log" ref={chatLogRef} onWheel={() => { openingAutoScrollUntil.current = 0; }} onTouchStart={() => { openingAutoScrollUntil.current = 0; }}>
        <div className="chat-log-content" ref={chatContentRef}>
          {chat.length === 0 && <p className="muted">Ask the brain to spin up some work…</p>}
          {chat.map(renderLine)}
          {thinking && <div className="bubble assistant thinking"><Logo /> thinking…</div>}
        </div>
      </div>
      <div className="chat-input" style={{ position: "relative" }}>
        {hasSlashMenu && (
          <SlashMenu
            commands={slashCommands}
            selIdx={slashSelIdx}
            onSelect={handleSelect}
          />
        )}
        <textarea ref={inputRef} value={msg} placeholder={thinking ? "Send a follow-up…" : "Message the brain…"}
                  onChange={handleChange}
                  onPaste={(e) => void handlePaste(e)}
                  onKeyDown={handleKeyDown}
                  onSelect={(e) => setCursorPos(e.currentTarget.selectionStart ?? msg.length)} />
      </div>
    </>
  );
}

function repoChatEventLines(lines: ChatLine[], event: AgentEvent): ChatLine[] {
  const next = [...lines];
  if (event.type === "text") {
    const last = next.at(-1);
    if (last?.role === "assistant") next[next.length - 1] = { ...last, text: last.text + event.text };
    else next.push({ role: "assistant", text: event.text });
  } else if (event.type === "thinking") {
    const last = next.at(-1);
    if (last?.role === "thinking") next[next.length - 1] = { ...last, text: last.text + event.text };
    else next.push({ role: "thinking", text: event.text });
  } else if (event.type === "tool_use") {
    next.push({ role: "tool", text: event.toolName, argsPreview: event.argsPreview });
  } else if (event.type === "tool_result") {
    const preview = event.preview?.trim();
    next.push({ role: "status", text: `Tool result: ${event.ok ? "ok" : "failed"}${preview ? ` — ${preview}` : ""}` });
  } else if (event.type === "error") {
    next.push({ role: "status", text: `⚠️ ${event.message}` });
  }
  return next;
}

function RepoChat() {
  const workspaceId = useStore($activeWorkspaceId);
  const repos = useStore($repos).filter((repo) => repo.enabled);
  const workspaceModels = useStore($workspaceModels);
  const workspaceDefaultModel = useStore($workspaceDefaultModel);
  const storageKey = workspaceId ? `manta:repo-chat:${workspaceId}` : "";
  const [repo, setRepo] = useState(repos[0]?.orgRepo ?? "");
  const [model, setModel] = useState("");
  const [histories, setHistories] = useState<Record<string, ChatLine[]>>(() => {
    if (!storageKey) return {};
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as Record<string, ChatLine[]>; }
    catch { return {}; }
  });
  const [msg, setMsg] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [repoModelIds, setRepoModelIds] = useState<Set<string>>(new Set());
  const [thinking, setThinking] = useState(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const key = `${repo}|${model}`;
  const lines = histories[key] ?? [];
  const models = workspaceModels.filter((item) => repoModelIds.has(item.id));

  useEffect(() => {
    if (!repo || !repos.some((item) => item.orgRepo === repo)) setRepo(repos[0]?.orgRepo ?? "");
  }, [repo, repos]);
  useEffect(() => {
    const next = defaultRepoChatModelId(models, model, workspaceDefaultModel);
    if (next !== model) setModel(next);
  }, [model, models, workspaceDefaultModel]);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const refreshAvailability = () => {
      void api.repoChatStatus(workspaceId)
        .then((result) => {
          if (cancelled) return;
          setAvailable(result.available);
          setRepoModelIds(new Set(result.models.map((item) => item.id)));
        })
        .catch(() => { if (!cancelled) setAvailable(false); });
    };
    setAvailable(null);
    refreshAvailability();
    const interval = window.setInterval(refreshAvailability, 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [workspaceId]);
  useEffect(() => {
    if (!storageKey) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(histories)); } catch { /* ignore storage limits */ }
  }, [histories, storageKey]);
  useLayoutEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, thinking]);

  const updateLines = (targetKey: string, update: (current: ChatLine[]) => ChatLine[]) => {
    setHistories((current) => ({ ...current, [targetKey]: update(current[targetKey] ?? []) }));
  };
  const send = async () => {
    const message = msg.trim();
    if (!workspaceId || !repo || !model || !message || !available || inFlightRef.current) return;
    // React state updates are asynchronous, so `thinking` cannot prevent two
    // Enter/click events in the same tick from dispatching duplicate turns.
    inFlightRef.current = true;
    const targetKey = key;
    const history = lines
      .filter((line): line is ChatLine & { role: "user" | "assistant" } => line.role === "user" || line.role === "assistant")
      .map((line) => ({ role: line.role, text: line.text }));
    updateLines(targetKey, (current) => [...current, { role: "user", text: message }]);
    setMsg("");
    setThinking(true);
    let streamedAnswer = false;
    try {
      await api.runRepoChat(workspaceId, { repo, model, message, history }, (event) => {
        if (event.type === "agent_event") {
          if (event.event.type === "text") streamedAnswer = true;
          updateLines(targetKey, (current) => repoChatEventLines(current, event.event));
        } else if (event.type === "status" && event.message) {
          updateLines(targetKey, (current) => [...current, { role: "status", text: event.message }]);
        } else if (event.type === "complete") {
          if (!streamedAnswer && event.answer) updateLines(targetKey, (current) => [...current, { role: "assistant", text: event.answer }]);
        } else if (event.type === "error") {
          updateLines(targetKey, (current) => [...current, { role: "status", text: `⚠️ ${event.message}` }]);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Repo chat failed";
      updateLines(targetKey, (current) => [...current, { role: "status", text: `⚠️ ${message}` }]);
      if (message === "local_worker_required") setAvailable(false);
    } finally {
      inFlightRef.current = false;
      setThinking(false);
    }
  };

  const disabledReason = available === null
    ? "Checking your local worker…"
    : !available
      ? "Repo chat requires your local worker to be online."
      : repos.length === 0
        ? "Enable a repository to start chatting."
        : models.length === 0
          ? "Connect a model provider to start chatting."
          : null;

  return (
    <>
      <div className="repo-chat-controls">
        <select aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)} disabled={thinking || repos.length === 0}>
          {repos.map((item) => <option key={item.id} value={item.orgRepo}>{item.orgRepo}</option>)}
        </select>
        <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} disabled={thinking || models.length === 0}>
          {models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      <div className="chat-log" ref={chatLogRef}>
        <div className="chat-log-content">
          {lines.length === 0 && <p className="muted">Ask about the selected repo, or delegate work to a new card.</p>}
          {lines.map(renderLine)}
          {thinking && <div className="bubble assistant thinking"><Logo /> working in checkout…</div>}
        </div>
      </div>
      {disabledReason && <div className="chat-worker-notice warn" role="status">{disabledReason}</div>}
      <div className="chat-input">
        <textarea
          value={msg}
          disabled={Boolean(disabledReason)}
          placeholder={disabledReason ?? (thinking ? "Working in checkout…" : `Message ${repo}…`)}
          onChange={(event) => setMsg(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
        />
        <button className="btn primary chat-send-btn" disabled={!msg.trim() || Boolean(disabledReason) || thinking} onClick={() => void send()}>Send</button>
      </div>
    </>
  );
}
