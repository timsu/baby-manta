// HUD overlay: brand strip, pipeline summary, interaction prompt, carry
// banner, controls legend, exit. Pure DOM over the canvas — styled in
// styles.css (game section). All world UI (action rings, carried card) is 3D.

import { useState } from "react";
import type { BoardMode } from "../stores.ts";
import { statusColorCss } from "./palette.ts";
import { GameFocusPanel } from "./GameFocusPanel.tsx";
import type { Interactable, ZoneDef } from "./types.ts";

const BOARD_MODE_LABEL: Record<BoardMode, string> = {
  me: "Mine",
  team: "All team",
  automated: "Automated",
};

export function GameHud({
  focus,
  carrying,
  wheelOpen,
  workspaceName,
  boardMode,
  zones,
  onExit,
}: {
  focus: Interactable | null;
  carrying: { title: string; status: string } | null;
  wheelOpen: boolean;
  workspaceName: string;
  boardMode: BoardMode;
  zones: ZoneDef[];
  onExit: () => void;
}) {
  const [showHelp, setShowHelp] = useState(true);
  const activeZones = zones.filter((z) => z.count > 0);
  return (
    <div className="game-hud">
      <div className="game-hud-top">
        <div className="game-hud-brand">
          <span className="game-hud-logo">🐶</span>
          <div>
            <div className="game-hud-title">DOG MODE</div>
            <div className="game-hud-sub">{workspaceName || "Manta"} · {BOARD_MODE_LABEL[boardMode]}</div>
          </div>
        </div>
        <div className="game-hud-topright">
          {activeZones.length > 0 && (
            <div className="game-hud-pipeline" aria-label="Cards per column">
              {activeZones.map((z) => (
                <span key={z.status} className="game-hud-pill" style={{ borderColor: statusColorCss(z.status) }} title={z.title}>
                  <i style={{ background: statusColorCss(z.status) }} />
                  {z.count}
                </span>
              ))}
            </div>
          )}
          <button className="game-hud-exit" onClick={onExit}>EXIT</button>
        </div>
      </div>
      <div className="game-hud-bottom">
        <div className={`game-hud-help ${showHelp ? "" : "collapsed"}`} onClick={() => setShowHelp((v) => !v)}>
          {showHelp ? (
            <>
              <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> run · <kbd>⇧</kbd> sprint</span>
              <span><kbd>E</kbd> interact · hold for actions</span>
              <span><kbd>F</kbd> carry a card</span>
              <span><kbd>/</kbd> find · <kbd>B</kbd> bark</span>
              <span className="game-hud-help-hint">scroll zoom · click map to travel</span>
            </>
          ) : (
            <span className="game-hud-help-hint">controls</span>
          )}
        </div>
        {carrying ? (
          <div className="game-hud-prompt game-hud-carry" data-testid="game-carry-banner">
            <span className="game-hud-carry-icon">🦴</span>
            <span>carrying "{carrying.title}" — run to a district, <kbd>F</kbd> or <kbd>E</kbd> drop · <kbd>esc</kbd> put back</span>
          </div>
        ) : focus && !wheelOpen ? (
          <div className="game-hud-prompt" data-testid="game-prompt">
            <kbd className="game-hud-keycap">E</kbd>
            <span>
              {focus.kind === "card"
                ? <>open "{focus.label}" · hold <kbd>E</kbd> actions · <kbd>F</kbd> carry</>
                : focus.label}
            </span>
          </div>
        ) : null}
        <div className="game-hud-spacer" />
      </div>
      {!wheelOpen && <GameFocusPanel focus={focus} />}
    </div>
  );
}
