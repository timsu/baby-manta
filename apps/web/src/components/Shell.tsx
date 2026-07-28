import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import { COLUMNS, type CardStatus } from "@manta/shared";
import { api, type GithubPr, type LinearTicket, type TaskCard } from "../api.ts";
import { $activeWorkspaceId, $cards, $me, $openTaskId, addToast } from "../stores.ts";
import { newWorkspace, refreshMembers, refreshRepos, refreshTasks, selectWorkspace } from "../actions.ts";
import { $gameMode } from "../game/gameStore.ts";
import { openTask } from "../ws.ts";
import { isTerminalFocused } from "../lib/terminalFocus.ts";
import { latestSpotCheckAlert } from "../lib/spotCheckAlert.ts";
import { Logo, UserMenu } from "./ui.tsx";
import { FloatingChat } from "./FloatingChat.tsx";
import { Board, BoardModeToggle } from "./Board.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import { NewCardModal } from "./NewCardModal.tsx";
import { WorkersModal } from "./WorkersModal.tsx";
import { SettingsView, type SettingsTab } from "../settings/SettingsView.tsx";
import { DashboardOnboarding } from "./DashboardOnboarding.tsx";
import { CredentialReauthPrompt } from "./CredentialReauthPrompt.tsx";
import { UserQuestionMenus } from "./UserQuestionMenus.tsx";
import { DebugView } from "./DebugView.tsx";
import { SpotChecksPanel } from "./SpotChecksPanel.tsx";

// Lazy so three.js and the game module stay out of the main bundle unless
// dog mode is actually entered.
const GameBoard = lazy(() => import("../game/GameBoard.tsx"));

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const VERSION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LAST_USED_REPO_KEY_PREFIX = "manta:last-used-repo";

type ShellHistoryState = {
  mantaView?: "board" | "task" | "settings" | "debug" | "spotchecks";
  taskId?: string | null;
};

const STATUS_NOTIFICATIONS: Array<{ status: CardStatus; label: string; className: string }> = [
  { status: "needs_help", label: "Needs help", className: "needs-help" },
  { status: "ready_to_test", label: "Ready to test", className: "ready-test" },
  { status: "pr_review", label: "Ready to merge", className: "ready-merge" },
  { status: "investigation_complete", label: "Investigation complete", className: "investigation-complete" },
];

function isInputFocused() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
}

function shellHistoryState(): ShellHistoryState {
  return window.history.state && typeof window.history.state === "object" ? window.history.state as ShellHistoryState : {};
}

function viewHash(view: "task" | "settings" | "debug" | "spotchecks", taskId?: string | null) {
  if (view === "debug") return "#debug";
  if (view === "spotchecks") return "#spot-checks";
  if (view === "settings") return "#settings";
  return `#task-${encodeURIComponent(taskId ?? "")}`;
}

function WorkerHeaderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.6 6.4L6.6 8l-2 1.6M8.2 9.6h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpotCheckHeaderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14M4.8 7l1.4 1.4L9.4 5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell() {
  const me = useStore($me)!;
  const activeId = useStore($activeWorkspaceId);
  const active = me.memberships.find((m) => m.workspaceId === activeId);
  const openTaskId = useStore($openTaskId);
  const openTaskIdRef = useRef(openTaskId);
  const cards = useStore($cards);
  const [modal, setModal] = useState<null | "card" | "workers">(null);
  const [newCardInitial, setNewCardInitial] = useState<null | { prompt: string; repo?: string | null; linearIssueIdentifier?: string | null }>(null);
  const [lastUsedRepo, setLastUsedRepo] = useState<string | null>(() => {
    if (!activeId) return null;
    try { return localStorage.getItem(`${LAST_USED_REPO_KEY_PREFIX}:${activeId}`); }
    catch { return null; }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSpotChecks, setShowSpotChecks] = useState(false);
  const [spotCheckCount, setSpotCheckCount] = useState(0);
  const [spotCheckAlert, setSpotCheckAlert] = useState<null | { verdict: "warn" | "fail"; names: string[] }>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [workerCount, setWorkerCount] = useState(0);
  const [workerEverConnected, setWorkerEverConnected] = useState(me.workerEverConnected);
  const [localWorkerOnboardingDismissed, setLocalWorkerOnboardingDismissed] = useState(me.localWorkerOnboardingDismissed);
  const [refreshing, setRefreshing] = useState(false);
  const [detailRefreshNonce, setDetailRefreshNonce] = useState(0);
  const [openStatusMenu, setOpenStatusMenu] = useState<CardStatus | null>(null);
  const ignoreNextBoardHistoryRef = useRef(false);
  const gameMode = useStore($gameMode);

  useEffect(() => {
    setWorkerEverConnected(me.workerEverConnected);
    setLocalWorkerOnboardingDismissed(me.localWorkerOnboardingDismissed);
  }, [me.id, me.localWorkerOnboardingDismissed, me.workerEverConnected]);

  const dismissLocalWorkerOnboarding = async () => {
    setLocalWorkerOnboardingDismissed(true);
    try {
      await api.updateMePreferences({ localWorkerOnboardingDismissed: true });
    } catch (err) {
      setLocalWorkerOnboardingDismissed(false);
      addToast(err instanceof Error ? err.message : "Failed to save preference", "error");
    }
  };

  const updateSpotCheckCount = useCallback((count: number) => {
    setSpotCheckCount(count);
  }, []);

  useEffect(() => {
    openTaskIdRef.current = openTaskId;
  }, [openTaskId]);

  useEffect(() => {
    if (!shellHistoryState().mantaView) {
      window.history.replaceState({ ...shellHistoryState(), mantaView: "board", taskId: null }, "", window.location.href);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (showSettings || showDebug || showSpotChecks || openTaskIdRef.current) {
        ignoreNextBoardHistoryRef.current = true;
        setShowSettings(false);
        setShowDebug(false);
        setShowSpotChecks(false);
        $openTaskId.set(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showDebug, showSettings, showSpotChecks]);

  useEffect(() => {
    const nextView = showDebug ? "debug" : showSettings ? "settings" : openTaskId ? "task" : showSpotChecks ? "spotchecks" : "board";
    const state = shellHistoryState();

    if (nextView === "board") {
      if (ignoreNextBoardHistoryRef.current) {
        ignoreNextBoardHistoryRef.current = false;
        return;
      }
      if (state.mantaView === "task" || state.mantaView === "settings" || state.mantaView === "debug" || state.mantaView === "spotchecks") {
        window.history.back();
      }
      return;
    }

    if (state.mantaView === nextView && (nextView !== "task" || state.taskId === openTaskId)) return;
    const nextState = { ...state, mantaView: nextView, taskId: openTaskId };
    const nextUrl = viewHash(nextView, openTaskId);
    if (state.mantaView === "task" || state.mantaView === "settings" || state.mantaView === "debug" || state.mantaView === "spotchecks") window.history.replaceState(nextState, "", nextUrl);
    else window.history.pushState(nextState, "", nextUrl);
  }, [openTaskId, showDebug, showSettings, showSpotChecks]);

  useEffect(() => {
    let cancelled = false;
    let knownVersion: string | null | undefined;
    const checkVersion = async () => {
      try {
        const { gitHash } = await api.version();
        if (cancelled) return;
        if (knownVersion === undefined) {
          knownVersion = gitHash;
          return;
        }
        if (gitHash !== knownVersion) {
          if (!openTaskIdRef.current && !isInputFocused()) window.location.reload();
          return;
        }
        knownVersion = gitHash;
      } catch {
        // Ignore transient version check failures; the next interval will try again.
      }
    };
    void checkVersion();
    const interval = window.setInterval(() => void checkVersion(), VERSION_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const openWorkspaceSettings = () => {
    setNewCardInitial(null);
    setShowDebug(false);
    setShowSpotChecks(false);
    setSettingsTab("general");
    setShowSettings(true);
    $openTaskId.set(null);
  };

  const openDebug = () => {
    setNewCardInitial(null);
    setShowSettings(false);
    setShowSpotChecks(false);
    setShowDebug(true);
    $openTaskId.set(null);
  };

  const refreshVisibleData = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (activeId) await api.refreshGithubStatuses(activeId);
      await Promise.all([refreshTasks(), refreshRepos(), refreshMembers()]);
      setDetailRefreshNonce((n) => n + 1);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Refresh failed", "error");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await api.listWorkers();
        const liveWorkers = r.workers.filter((w) => w.live);
        setWorkerCount(liveWorkers.length);
        if (liveWorkers.length > 0) setWorkerEverConnected(true);
      } catch { /* ignore */ }
    };
    void poll();
    const t = setInterval(() => void poll(), 10_000);
    return () => clearInterval(t);
  }, []);

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e as BeforeInstallPromptEvent); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  useEffect(() => {
    if (!installPrompt || showSettings || openTaskId) return;
    if (localStorage.getItem("manta:pwa-nudge")) return;
    localStorage.setItem("manta:pwa-nudge", "1");
    addToast(
      "Install Manta as an app for quick access.",
      "info",
      { label: "Install", onClick: () => { void installPrompt.prompt(); setInstallPrompt(null); } },
      12000,
    );
  }, [installPrompt, showSettings, openTaskId]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const toggleChat = () => setChatOpen((value) => !value);
  const visibleCards = useMemo(() => cards.filter((c) => !c.hidden), [cards]);
  const boardColumns = useMemo(
    () => COLUMNS.map((col) => visibleCards.filter((c) => c.cardStatus === col.status)).filter((colCards) => colCards.length > 0),
    [visibleCards],
  );
  const statusNotifications = useMemo(
    () => STATUS_NOTIFICATIONS.map((n) => ({ ...n, cards: visibleCards.filter((c) => c.createdBy === me.id && c.cardStatus === n.status) })).filter((n) => n.cards.length > 0),
    [visibleCards, me.id],
  );
  useEffect(() => {
    if (modal || showSettings || showDebug || openTaskId) setOpenStatusMenu(null);
  }, [modal, openTaskId, showDebug, showSettings]);
  useEffect(() => {
    if (openStatusMenu && !statusNotifications.some((n) => n.status === openStatusMenu)) setOpenStatusMenu(null);
  }, [openStatusMenu, statusNotifications]);
  const notificationCount = statusNotifications.reduce((sum, n) => sum + n.cards.length, 0);
  useEffect(() => {
    const badgeApi = navigator as Navigator & { setAppBadge?: (contents?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!badgeApi.setAppBadge || !badgeApi.clearAppBadge) return;
    void (notificationCount > 0 ? badgeApi.setAppBadge(notificationCount) : badgeApi.clearAppBadge()).catch(() => {});
    return () => { void badgeApi.clearAppBadge?.().catch(() => {}); };
  }, [notificationCount]);
  useEffect(() => {
    document.title = notificationCount > 0 ? `(${notificationCount}) Manta` : "Manta";
    return () => { document.title = "Manta"; };
  }, [notificationCount]);
  const openStatusCard = (card: TaskCard) => {
    setOpenStatusMenu(null);
    setShowSettings(false);
    setShowDebug(false);
    setShowSpotChecks(false);
    setSelectedCardId(card.id);
    openTask(card.id);
  };
  const openTaskFromSettings = (taskId: string) => {
    setShowSettings(false);
    setShowDebug(false);
    setShowSpotChecks(false);
    setSelectedCardId(taskId);
    openTask(taskId);
  };
  const openCard: TaskCard | null = openTaskId
    ? cards.find((c) => c.id === openTaskId) ??
      { id: openTaskId, title: openTaskId, cardType: "bot", cardStatus: "bot_working", doneReason: null, hidden: false, backgroundMode: null, repo: "", prUrl: null, prNumber: null, prState: null, prTitle: null, checksStatus: "unknown", checks: [], reviewDecision: null, mergeable: "UNKNOWN", autoMergeEnabled: false, workerStatus: "pending", workerActive: false, workerVenue: "none", venueStatus: "none", branch: null, characterEmoji: null, updatedAt: "", createdAt: "", taskNumber: null, linearIssueIdentifier: null, linearIssueUrl: null, createdBy: null, workerBackend: "", localWorkerStatus: "offline" }
    : null;

  useEffect(() => {
    setShowSpotChecks(false);
    if (!activeId) { setSpotCheckCount(0); setSpotCheckAlert(null); return; }
    let cancelled = false;
    api.spotChecks(activeId)
      .then((res) => {
        if (cancelled) return;
        setSpotCheckCount(res.spotChecks.length);
        setSpotCheckAlert(latestSpotCheckAlert(res.spotChecks, res.runs));
      })
      .catch(() => { if (!cancelled) { setSpotCheckCount(0); setSpotCheckAlert(null); } });
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    if (showSettings || showDebug || openTaskId) setShowSpotChecks(false);
  }, [openTaskId, showDebug, showSettings]);

  useEffect(() => {
    if (!activeId) { setLastUsedRepo(null); return; }
    try { setLastUsedRepo(localStorage.getItem(`${LAST_USED_REPO_KEY_PREFIX}:${activeId}`)); }
    catch { setLastUsedRepo(null); }
  }, [activeId]);

  const rememberUsedRepo = useCallback((repo: string) => {
    if (!activeId || !repo) return;
    setLastUsedRepo(repo);
    try { localStorage.setItem(`${LAST_USED_REPO_KEY_PREFIX}:${activeId}`, repo); }
    catch { /* ignore */ }
  }, [activeId]);

  const openNewCard = useCallback((initial: { prompt?: string; repo?: string | null; linearIssueIdentifier?: string | null } = {}) => {
    setShowDebug(false);
    setShowSpotChecks(false);
    setNewCardInitial({
      prompt: initial.prompt ?? "",
      repo: "repo" in initial ? initial.repo : lastUsedRepo,
      linearIssueIdentifier: initial.linearIssueIdentifier,
    });
    setModal("card");
  }, [lastUsedRepo]);

  useEffect(() => {
    if (cards.length === 0) setSelectedCardId(null);
    else if (!selectedCardId || !cards.some((c) => c.id === selectedCardId)) setSelectedCardId(boardColumns[0]?.[0]?.id ?? null);
  }, [cards, boardColumns, selectedCardId]);

  useEffect(() => {
    if (!openTaskId) document.querySelector(".card.task.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [openTaskId, selectedCardId]);

  useEffect(() => {
    const isInteractiveTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true']"));
    };
    const selectedPosition = () => {
      for (let col = 0; col < boardColumns.length; col++) {
        const colCards = boardColumns[col];
        if (!colCards) continue;
        const row = colCards.findIndex((card) => card.id === selectedCardId);
        if (row >= 0) return { col, row };
      }
      return boardColumns[0]?.length ? { col: 0, row: 0 } : null;
    };
    const moveSelection = (direction: "up" | "down" | "left" | "right") => {
      const pos = selectedPosition();
      if (!pos) return;
      let { col, row } = pos;
      const currentColumn = boardColumns[col];
      if (!currentColumn) return;
      if (direction === "up") row = Math.max(0, row - 1);
      if (direction === "down") row = Math.min(currentColumn.length - 1, row + 1);
      if (direction === "left") col = Math.max(0, col - 1);
      if (direction === "right") col = Math.min(boardColumns.length - 1, col + 1);
      const targetColumn = boardColumns[col];
      if (!targetColumn) return;
      row = Math.min(row, targetColumn.length - 1);
      const targetCard = targetColumn[row];
      if (targetCard) setSelectedCardId(targetCard.id);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (modal || showSettings || showDebug || isInteractiveTarget(e.target)) return;
      if (openTaskId && e.key === "Escape") {
        if (isTerminalFocused(e.target, document.activeElement)) return;
        e.preventDefault();
        $openTaskId.set(null);
        return;
      }
      // Dog mode owns board-level keys (WASD/arrows/E); only Escape above applies.
      if (gameMode) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        openNewCard();
        return;
      }
      if (openTaskId) return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        moveSelection(e.key.replace("Arrow", "").toLowerCase() as "up" | "down" | "left" | "right");
      } else if (e.key === "Enter") {
        const cardId = selectedCardId ?? boardColumns[0]?.[0]?.id;
        if (cardId) {
          e.preventDefault();
          openTask(cardId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [boardColumns, gameMode, modal, openNewCard, openTaskId, selectedCardId, showDebug, showSettings]);

  const trackPrFromGame = useCallback(async (pr: Pick<GithubPr, "repo" | "number" | "title" | "url" | "branch" | "state">) => {
    if (!activeId) return;
    try {
      const result = await api.createCardFromPr(activeId, pr);
      await refreshTasks();
      setSelectedCardId(result.id);
      openTask(result.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to track PR", "error");
    }
  }, [activeId]);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand"><Logo /> Manta</span>
        <nav className="ws-tabs">
          {me.memberships.map((m) => (
            <button key={m.workspaceId}
                    className={`ws-tab ${m.workspaceId === activeId ? "on" : ""} ${m.workspaceId === activeId && showSettings ? "settings-active" : ""}`}
                    onClick={() => {
                      if (m.workspaceId === activeId) {
                        if (window.matchMedia("(max-width: 640px)").matches) return;
                        setSettingsTab("general");
                        setShowDebug(false);
                        setShowSpotChecks(false);
                        setShowSettings((v) => !v);
                        $openTaskId.set(null);
                      } else {
                        setShowDebug(false);
                        setShowSpotChecks(false);
                        void selectWorkspace(m.workspaceId);
                      }
                    }}>
              {m.name}
            </button>
          ))}
          <button className="ws-tab add" title="New workspace" aria-label="New workspace"
                  onClick={() => { const name = prompt("New workspace name:"); if (name?.trim()) void newWorkspace(name.trim()); }}>
            +
          </button>
        </nav>
        <span className="spacer" />
        {!showSettings && !showDebug && <>
          {statusNotifications.length > 0 && (
            <div className="status-notifs" aria-label="Your card notifications">
              {statusNotifications.map((n) => (
                <div key={n.status} className="status-notif-wrap">
                  <button
                    className={`status-notif ${n.className}`}
                    title={`${n.cards.length} of your ${n.label.toLowerCase()} card${n.cards.length === 1 ? "" : "s"}`}
                    aria-label={`${n.cards.length} of your ${n.label.toLowerCase()} card${n.cards.length === 1 ? "" : "s"}`}
                    aria-haspopup="menu"
                    aria-expanded={openStatusMenu === n.status}
                    onClick={() => setOpenStatusMenu((status) => status === n.status ? null : n.status)}
                  >
                    {n.cards.length > 99 ? "99+" : n.cards.length}
                  </button>
                  {openStatusMenu === n.status && (
                    <>
                      <div className="menu-backdrop" onClick={() => setOpenStatusMenu(null)} />
                      <div className="menu status-notif-menu" role="menu" aria-label={`${n.label} cards`}>
                        <div className="menu-label">{n.label}</div>
                        {n.cards.map((card) => (
                          <button key={card.id} className="menu-item status-notif-menu-item" role="menuitem" onClick={() => openStatusCard(card)}>
                            <span className="status-notif-card-title">{card.title}</span>
                            <span className="status-notif-card-meta">
                              {card.taskNumber ? `#${card.taskNumber}` : card.repo || "Card"}{card.repo && card.taskNumber ? ` · ${card.repo}` : ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <button className="btn worker-btn" onClick={() => setModal("workers")} title="Connected workers" aria-label={`Connected workers: ${workerCount}`}>
            <span className={`worker-indicator ${workerCount > 0 ? "connected" : "none"}`} />
            <span className="header-control-icon"><WorkerHeaderIcon /></span>
            <span className="header-control-label">Workers{workerCount > 0 ? ` (${workerCount})` : ""}</span>
            {workerCount > 0 && <span className="spotchecks-count worker-mobile-count">{workerCount}</span>}
          </button>
          {activeId && !openTaskId && (
            <button
              className={`btn spotchecks-toggle ${showSpotChecks ? "on" : ""} ${spotCheckAlert ? `alert-${spotCheckAlert.verdict}` : ""}`}
              title={spotCheckAlert
                ? `Last run ${spotCheckAlert.verdict === "fail" ? "red" : "yellow"}: ${spotCheckAlert.names.join(", ")}`
                : `${spotCheckCount} configured spot check${spotCheckCount === 1 ? "" : "s"}`}
              aria-label={spotCheckAlert
                ? `Spot checks: ${spotCheckCount} configured; last run ${spotCheckAlert.verdict === "fail" ? "red" : "yellow"}: ${spotCheckAlert.names.join(", ")}`
                : `Spot checks: ${spotCheckCount} configured`}
              aria-expanded={showSpotChecks}
              onClick={() => setShowSpotChecks((v) => !v)}
            >
              <span className="header-control-icon"><SpotCheckHeaderIcon /></span>
              <span className="header-control-label">Spot checks</span>
              <span className="spotchecks-count">{spotCheckCount}</span>
              {spotCheckAlert && <span className={`spotchecks-alert ${spotCheckAlert.verdict}`} aria-label={`${spotCheckAlert.names.length} spot check${spotCheckAlert.names.length === 1 ? "" : "s"} not green`} />}
            </button>
          )}
          <button className="btn primary topbar-new-card" onClick={() => openNewCard()}>+ New <u>c</u>ard</button>
          <button
            className={`btn icon-btn refresh-btn ${refreshing ? "refreshing" : ""}`}
            title={refreshing ? "Refreshing…" : "Refresh"}
            aria-label={refreshing ? "Refreshing" : "Refresh"}
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void refreshVisibleData()}
          >
            <span className="refresh-icon" aria-hidden="true">↻</span>
          </button>
        </>}
        <UserMenu email={me.email} onOpenWorkspaceSettings={activeId ? openWorkspaceSettings : undefined} onOpenDebug={openDebug} />
      </header>
      <div className="main">
        <main className="content">
          {showDebug ? (
            <DebugView onClose={() => setShowDebug(false)} />
          ) : showSettings ? (
            <SettingsView workspaceId={activeId!} initialTab={settingsTab} onClose={() => setShowSettings(false)} onOpenTask={openTaskFromSettings} />
          ) : openCard ? (
            <TaskDetail card={openCard} refreshNonce={detailRefreshNonce} />
          ) : (
            <div className="dashboard-layout">
              <div className="board-wrap">
                <div className="board-titlebar">
                  <h3 className="board-title">{active?.name ?? "Board"}</h3>
                  <BoardModeToggle />
                </div>
                {gameMode ? (
                  <Suspense fallback={<div className="center muted">Loading dog mode…</div>}>
                    <GameBoard
                      active={!modal && !chatOpen}
                      handlers={{
                        openTask: (taskId: string) => { setSelectedCardId(taskId); openTask(taskId); },
                        openNewCard,
                        openWorkers: () => setModal("workers"),
                        openSettings: openWorkspaceSettings,
                        openDebug,
                        toggleSpotChecks: () => setShowSpotChecks((v) => !v),
                        refresh: () => void refreshVisibleData(),
                        toggleChat,
                        switchWorkspace: (workspaceId: string) => { setShowDebug(false); setShowSpotChecks(false); void selectWorkspace(workspaceId); },
                        trackPr: (pr) => void trackPrFromGame(pr),
                      }}
                    />
                  </Suspense>
                ) : (
                  <Board
                    selectedCardId={selectedCardId}
                    onSelectCard={setSelectedCardId}
                    onNewCardForRepo={(repo: string) => openNewCard({ repo })}
                    onStartLinearTicket={(ticket: LinearTicket) => {
                      openNewCard({
                        prompt: `Work on ${ticket.identifier}`,
                        repo: ticket.repo,
                        linearIssueIdentifier: ticket.identifier,
                      });
                    }}
                  />
                )}
              </div>
              {activeId && (
                // Always mounted so the re-login prompt can detect an expired
                // credential even with no cards/spot-checks; an empty panel
                // collapses via `.dashboard-side:empty`.
                <div className="dashboard-side">
                  <CredentialReauthPrompt
                    onReconnect={() => { setShowDebug(false); setSettingsTab("account"); setShowSettings(true); }}
                  />
                  {showSpotChecks && (
                    <SpotChecksPanel
                      workspaceId={activeId}
                      onClose={() => setShowSpotChecks(false)}
                      onCountChange={updateSpotCheckCount}
                      onOpenTask={(taskId) => {
                        setShowSpotChecks(false);
                        setSelectedCardId(taskId);
                        openTask(taskId);
                      }}
                    />
                  )}
                  {cards.length > 0 && (
                    <DashboardOnboarding
                      workspaceId={activeId}
                      userId={me.id}
                      githubLogin={me.githubLogin}
                      githubNeedsRelink={me.githubNeedsRelink}
                      workerCount={workerCount}
                      workerEverConnected={workerEverConnected}
                      localWorkerOnboardingDismissed={localWorkerOnboardingDismissed}
                      onOpenWorkers={() => setModal("workers")}
                      onDismissLocalWorker={() => void dismissLocalWorkerOnboarding()}
                      onOpenAccount={() => { setShowDebug(false); setSettingsTab("account"); setShowSettings(true); }}
                      onOpenModels={() => { setShowDebug(false); setSettingsTab("models"); setShowSettings(true); }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      {!modal && !showSettings && !showDebug && !openTaskId && (
        <>
          <FloatingChat open={chatOpen} onOpenChange={setChatOpen} />
          <button className="new-card-fab" aria-label="New card" onClick={() => openNewCard()}>+</button>
        </>
      )}
      {modal === "card" && (
        <NewCardModal
          initialPrompt={newCardInitial?.prompt}
          initialRepo={newCardInitial?.repo}
          initialLinearIssueIdentifier={newCardInitial?.linearIssueIdentifier}
          onRepoUsed={rememberUsedRepo}
          onClose={() => { setModal(null); setNewCardInitial(null); }}
        />
      )}
      {modal === "workers" && <WorkersModal onClose={() => setModal(null)} />}
      <UserQuestionMenus />
    </div>
  );
}
