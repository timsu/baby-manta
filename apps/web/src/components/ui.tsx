import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useStore } from "@nanostores/react";
import { $mantaHidden, $me } from "../stores.ts";
import { $gameMode } from "../game/gameStore.ts";

export function Logo() {
  return <img className="logo" src="/favicon.svg" alt="Manta" />;
}

export function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6.25" y1="2.75" x2="6.25" y2="13.25" stroke="currentColor" strokeWidth="1.4" />
      {open && <rect x="2.75" y="3.75" width="2.5" height="8.5" rx="1" fill="currentColor" opacity="0.5" />}
    </svg>
  );
}

export function UserMenu({
  email,
  onOpenWorkspaceSettings,
  onOpenDebug,
}: {
  email: string;
  onOpenWorkspaceSettings?: () => void;
  onOpenDebug?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const mantaHidden = useStore($mantaHidden);
  const gameMode = useStore($gameMode);
  // Fetch the server build hash once when the menu first opens.
  useEffect(() => {
    if (!open || version) return;
    void api.version().then((v) => setVersion(v.gitHash)).catch(() => {});
  }, [open, version]);
  return (
    <div className="usermenu">
      <button className="btn ghost user-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="user-trigger-email">{email}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu">
            <div className="menu-email">{email}</div>
            {onOpenWorkspaceSettings && (
              <button className="menu-item" onClick={() => { setOpen(false); onOpenWorkspaceSettings(); }}>
                Workspace settings
              </button>
            )}
            <button className="menu-item" onClick={() => $mantaHidden.set(!mantaHidden)}>
              {mantaHidden ? "Show Black Manta" : "Hide Black Manta"}
            </button>
            <button className="menu-item" data-testid="game-mode-toggle" onClick={() => { setOpen(false); $gameMode.set(!gameMode); }}>
              {gameMode ? "Exit dog mode 🐶" : "Enter dog mode 🐶"}
            </button>
            {onOpenDebug && (
              <button className="menu-item" onClick={() => { setOpen(false); onOpenDebug(); }}>
                Debugging / server logs
              </button>
            )}
            <button className="menu-item" onClick={async () => { setOpen(false); await api.logout(); $me.set(null); }}>
              Sign out
            </button>
            {version && <div className="menu-version">version {version}</div>}
          </div>
        </>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 9.5a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M7.5 1.5v1M7.5 12.5v1M1.5 7.5h1M12.5 7.5h1M3.4 3.4l.7.7M10.9 10.9l.7.7M10.9 4.1l-.7.7M4.1 10.9l-.7.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}
