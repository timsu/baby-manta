import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import type { CardStatus } from "@manta/shared";
import { api } from "../api.ts";
import { $activeWorkspaceId, $cards, $linearTickets, $mantaHidden, $openTaskId, $toasts } from "../stores.ts";
import { randomBlackMantaQuote } from "../lib/blackMantaQuotes.ts";

const MANTA_IMAGE = "/black-manta.png";
const LAST_BLURB_KEY = "manta:blackMantaLastBlurbAt";
const BLURB_TEXT_KEY = "manta:blackMantaBlurb";
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const QUOTE_MS = 5000;

const ACTIVE_CARD_STATUSES = new Set<CardStatus>([
  "bot_working",
  "needs_help",
  "ready_to_test",
  "interactive",
  "pr_review",
  "investigation_complete",
]);

const FALLBACK_BLURBS = [
  "Multiple fronts. Maximum pressure. Aquaman could never sustain this kind of operational tempo.",
  "The board is alive with motion. More velocity, more damage, more everything. I respect it.",
  "This level of output would alarm Atlantis. Keep going.",
];

function fallbackBlurb(): string {
  return FALLBACK_BLURBS[Math.floor(Math.random() * FALLBACK_BLURBS.length)] ?? FALLBACK_BLURBS[0]!;
}

function readLastBlurbAt() {
  try { return Number(localStorage.getItem(LAST_BLURB_KEY) ?? "0") || 0; } catch { return 0; }
}

function writeLastBlurbAt(value: number) {
  try { localStorage.setItem(LAST_BLURB_KEY, String(value)); } catch { /* ignore */ }
}

function readCachedBlurb() {
  try { return localStorage.getItem(BLURB_TEXT_KEY) ?? ""; } catch { return ""; }
}

function writeCachedBlurb(text: string) {
  try { localStorage.setItem(BLURB_TEXT_KEY, text); } catch { /* ignore */ }
}

function clearCachedBlurb() {
  try { localStorage.removeItem(BLURB_TEXT_KEY); } catch { /* ignore */ }
}

function initialBlurb() {
  const cached = readCachedBlurb();
  const age = Date.now() - readLastBlurbAt();
  // Only reuse a still-fresh cached blurb; otherwise start empty and let the
  // effect fetch a new one.
  return cached && age < FOUR_HOURS ? cached : "";
}

export function BlackMantaCommentator() {
  const hidden = useStore($mantaHidden);
  const openTaskId = useStore($openTaskId);
  const workspaceId = useStore($activeWorkspaceId);
  const cards = useStore($cards);
  const linearTickets = useStore($linearTickets);
  const toasts = useStore($toasts);
  const latestToast = toasts[toasts.length - 1];
  const [blurb, setBlurb] = useState(initialBlurb);
  const [quote, setQuote] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const quoteTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const hasActiveTasks = useMemo(
    () => cards.some((c) => ACTIVE_CARD_STATUSES.has(c.cardStatus)),
    [cards],
  );

  const taskDigest = useMemo(() => ({
    cards: cards.slice(0, 40).map((c) => ({
      title: c.title,
      status: c.cardStatus,
      repo: c.repo,
      pr: c.prNumber ? `#${c.prNumber}` : null,
      linear: c.linearIssueIdentifier,
    })),
    linearTickets: linearTickets.slice(0, 40).map((t) => ({
      identifier: t.identifier,
      title: t.title,
      state: t.state.name,
      repo: t.repo,
      priority: t.priority,
    })),
  }), [cards, linearTickets]);

  useEffect(() => () => {
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
  }, []);

  useEffect(() => {
    if (hidden || openTaskId || !workspaceId || !hasActiveTasks) return;
    const maybeGenerate = async () => {
      if (inFlight.current || !document.hasFocus()) return;
      const now = Date.now();
      if (now - readLastBlurbAt() < FOUR_HOURS) return;
      inFlight.current = true;
      setThinking(true);
      try {
        const result = await api.blackMantaCommentary(workspaceId, taskDigest);
        const text = result.text.trim() || fallbackBlurb();
        setBlurb(text);
        writeCachedBlurb(text);
        writeLastBlurbAt(now);
      } catch {
        setBlurb(fallbackBlurb());
      } finally {
        inFlight.current = false;
        setThinking(false);
      }
    };
    void maybeGenerate();
    const interval = window.setInterval(() => void maybeGenerate(), 60 * 1000);
    window.addEventListener("focus", maybeGenerate);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", maybeGenerate);
    };
  }, [hidden, openTaskId, workspaceId, hasActiveTasks, taskDigest]);

  if (hidden || openTaskId || !hasActiveTasks) return null;

  const showingGeneratedBlurb = !quote && !latestToast && !thinking && Boolean(blurb);
  const text = quote ?? latestToast?.msg ?? (thinking ? "Consulting the abyss about your priorities…" : blurb);

  if (!text) return null;

  const handleSpriteClick = () => {
    if (collapsed) {
      setCollapsed(false);
      return;
    }
    if (showingGeneratedBlurb) {
      setBlurb("");
      clearCachedBlurb();
    }
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    setQuote(randomBlackMantaQuote());
    quoteTimer.current = window.setTimeout(() => {
      setQuote(null);
      setCollapsed(true);
    }, QUOTE_MS);
  };

  return (
    <div className="black-manta" aria-live="polite">
      {!collapsed && text && (
        <div className={`black-manta-bubble ${latestToast?.type === "error" ? "danger" : ""}`}>
          <div className="black-manta-name">Black Manta</div>
          <div className="black-manta-text">{text}</div>
          {latestToast?.action && !quote && (
            <button className="black-manta-action" onClick={latestToast.action.onClick}>{latestToast.action.label}</button>
          )}
        </div>
      )}
      <button className="black-manta-sprite" onClick={handleSpriteClick} title="Black Manta" aria-label="Black Manta">
        <img src={MANTA_IMAGE} alt="Black Manta" />
      </button>
    </div>
  );
}
