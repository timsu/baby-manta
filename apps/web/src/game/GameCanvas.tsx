// Mounts the three.js world, runs the game loop, and routes interactions to
// the same operations the 2D UI uses. Interaction model (game-standard):
//   tap E  — default action on the nearest target (open card / use building)
//   hold E — radial wheel around the character: card ops near a card,
//            the global operation wheel anywhere else
//   F      — carry a card between districts (status move)
// No DOM popovers besides the wheel; labels LOD with distance in scene.ts.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useStore } from "@nanostores/react";
import {
  $activeWorkspaceId,
  $boardMode,
  $cards,
  $githubPrs,
  $linearTickets,
  $me,
  $members,
  $pendingUserQuestions,
  addToast,
} from "../stores.ts";
import { isUserDragAllowed, STATUS_LABELS } from "@manta/shared";
import type { TaskCard } from "../api.ts";
import { buildWorldLayout, findWorldMatch, STREET_START_X, zoneAt } from "./layout.ts";
import { findNearestInteractable } from "./proximity.ts";
import { actionForInteractable, dispatchGameAction, type GameHandlers } from "./gameActions.ts";
import { carryTargets as carryTargetsFor, doAutoMerge, doFix, doLinkPr, doReassign, doTransition } from "./cardOps.ts";
import { buildCardWheel, buildGlobalWheel, buildLinearDepotWheel, buildPrDepotWheel, type WheelItem, type WheelSpec } from "./wheelItems.ts";
import { createGameScene, type GameScene } from "./scene.ts";
import { createDogController, type DogController } from "./dogController.ts";
import { GameHud } from "./GameHud.tsx";
import { GameWheel } from "./GameWheel.tsx";
import { GameMinimap } from "./GameMinimap.tsx";
import { GameSearch } from "./GameSearch.tsx";
import { toggleGameMode } from "./gameStore.ts";
import type { Interactable, WorldLayout } from "./types.ts";

/** e2e/debug hook installed on window while the canvas is mounted. */
export interface MantaGameTestApi {
  getState(): {
    dog: { x: number; z: number };
    /** True once the corgi FBX replaced the placeholder box-dog. */
    modelLoaded: boolean;
    nearestId: string | null;
    carrying: string | null;
    wheel: { title: string; labels: string[]; selected: number } | null;
    linearFilter: string | null;
    zones: { status: string; x: number; z: number; halfW: number; halfD: number }[];
    interactables: { id: string; kind: string; label: string; x: number; z: number }[];
  };
  setDogPosition(x: number, z: number): void;
  pressInteract(): void;
}

declare global {
  interface Window {
    __mantaGame?: MantaGameTestApi;
  }
}

interface WheelState extends WheelSpec {
  selected: number;
  /** The card the wheel was opened on (undefined for the global wheel). */
  card?: TaskCard;
  parent?: WheelState;
  /** Screen anchor (% of container) — the dog's projected position. */
  center: { xPct: number; yPct: number };
}

const HOLD_MS = 260;

function assetsEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("gameassets") === "0") return false;
    return localStorage.getItem("manta:gameAssets") !== "off";
  } catch {
    return true;
  }
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
}

export function GameCanvas({ active, handlers }: { active: boolean; handlers: GameHandlers }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<Interactable | null>(null);
  const [carrying, setCarrying] = useState<TaskCard | null>(null);
  const [wheel, setWheel] = useState<WheelState | null>(null);
  const [linearFilter, setLinearFilterState] = useState<string | null>(() => {
    try { return localStorage.getItem("manta:gameLinearFilter"); } catch { return null; }
  });
  const setLinearFilter = (v: string) => {
    setLinearFilterState(v);
    try { localStorage.setItem("manta:gameLinearFilter", v); } catch { /* ignore */ }
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [offscreen, setOffscreen] = useState<{ id: string; xPct: number; yPct: number; deg: number }[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const me = useStore($me);
  const cards = useStore($cards);
  const githubPrs = useStore($githubPrs);
  const linearTickets = useStore($linearTickets);
  const boardMode = useStore($boardMode);
  const activeWorkspaceId = useStore($activeWorkspaceId);
  const members = useStore($members);
  const pendingQuestions = useStore($pendingUserQuestions);

  // Refs so the rAF loop and key handlers see fresh values without rebinding.
  const layoutRef = useRef<WorldLayout>({ zones: [], interactables: [], bounds: 30 });
  const nearestRef = useRef<Interactable | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const activeRef = useRef(active);
  activeRef.current = active;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const membersRef = useRef(members);
  membersRef.current = members;
  const boardModeRef = useRef(boardMode);
  boardModeRef.current = boardMode;
  const workspaceRef = useRef(activeWorkspaceId);
  workspaceRef.current = activeWorkspaceId;
  const carryingRef = useRef<TaskCard | null>(null);
  const linearFilterRef = useRef(linearFilter);
  linearFilterRef.current = linearFilter;
  const wheelRef = useRef<WheelState | null>(null);
  /** Mouse path into the effect-scoped wheel executor. */
  const wheelApiRef = useRef<{ select(i: number): void; confirm(i: number): void }>({ select: () => {}, confirm: () => {} });
  const sceneRef = useRef<GameScene | null>(null);
  const dogRef = useRef<DogController | null>(null);
  const whistleRef = useRef<(q: string) => void>(() => {});
  const travelRef = useRef<(x: number, z: number) => void>(() => {});
  const fontsReadyRef = useRef(false);

  const layout = (() => {
    if (!me) return { zones: [], interactables: [], bounds: 30 } satisfies WorldLayout;
    return buildWorldLayout({
      cards,
      githubPrs,
      linearTickets,
      memberships: me.memberships,
      activeWorkspaceId,
      members,
      pendingQuestionTaskIds: pendingQuestions.map((q) => q.taskId),
      linearYardStateType: linearFilter ?? undefined,
      now: Date.now(),
      boardMode,
      meId: me.id,
    });
  })();

  // Keep the ref + scene in sync with the derived layout. A serialized layout
  // is the cheapest correct dependency: rebuild only when the world changed.
  const layoutKey = JSON.stringify(layout);
  useEffect(() => {
    layoutRef.current = layout;
    if (fontsReadyRef.current) sceneRef.current?.syncWorld(layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scene: GameScene;
    try {
      scene = createGameScene(container);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : "WebGL unavailable");
      return;
    }
    sceneRef.current = scene;
    try {
      const storedZoom = Number(localStorage.getItem("manta:gameZoom"));
      if (Number.isFinite(storedZoom) && storedZoom > 0) scene.setZoom(storedZoom);
    } catch { /* ignore */ }

    // Billboard text uses Chakra Petch; build the world after fonts settle so
    // canvas labels don't rasterize with a fallback face. `fonts.ready` also
    // resolves when the font never loads, so this can't wedge the world.
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (disposed) return;
      fontsReadyRef.current = true;
      scene.syncWorld(layoutRef.current);
    });

    const dog = createDogController(scene.scene, { loadAssets: assetsEnabled() });
    dogRef.current = dog;
    dog.setPosition(STREET_START_X - 4, 0); // west end of the street, facing the flow

    const keys = new Set<string>();
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let eDown = false;
    let suppressNextEUp = false;

    const updateWheel = (next: WheelState | null) => {
      wheelRef.current = next;
      setWheel(next);
    };

    const nearestCard = (): TaskCard | null => {
      const nearest = nearestRef.current;
      if (nearest?.kind !== "card") return null;
      return cardsRef.current.find((c) => c.id === nearest.data?.taskId) ?? null;
    };

    const startCarry = (card: TaskCard) => {
      const face = layoutRef.current.interactables.find((i) => i.id === `card:${card.id}`)?.data?.face;
      if (!face) return;
      carryingRef.current = card;
      setCarrying(card);
      scene.setCarried(face);
      scene.setCarryTargets(new Set(carryTargetsFor(card)));
    };

    const endCarry = () => {
      carryingRef.current = null;
      setCarrying(null);
      scene.setCarried(null);
      scene.setCarryTargets(null);
    };

    const dropCarry = () => {
      const card = carryingRef.current;
      const ws = workspaceRef.current;
      if (!card || !ws) return;
      const zone = zoneAt(dog.rig.position.x, dog.rig.position.z, layoutRef.current.zones);
      if (!zone) {
        addToast("Carry the card into a district to drop it.", "info");
        return;
      }
      if (zone.status === card.cardStatus) {
        endCarry();
        addToast("Card put back.", "info");
        return;
      }
      if (!isUserDragAllowed(card.cardStatus, zone.status, { hasPr: card.prNumber !== null, isPrOnly: false, isPrDraft: false })) {
        addToast(`Can't move ${STATUS_LABELS[card.cardStatus]} → ${STATUS_LABELS[zone.status]}.`, "error");
        return;
      }
      endCarry();
      void doTransition(ws, card, zone.status);
    };

    const runWheelItem = (item: WheelItem) => {
      const state = wheelRef.current;
      const ws = workspaceRef.current;
      const card = state?.card;
      switch (item.action.type) {
        case "submenu":
          updateWheel({
            title: item.action.title,
            items: item.action.items,
            selected: 0,
            card,
            parent: state ?? undefined,
            center: state?.center ?? { xPct: 50, yPct: 55 },
          });
          return;
        case "open-card":
          updateWheel(null);
          if (card) handlersRef.current.openTask(card.id);
          return;
        case "carry":
          updateWheel(null);
          if (card) startCarry(card);
          return;
        case "reassign": {
          const userId = item.action.userId;
          updateWheel(null);
          const member = membersRef.current.find((m) => m.userId === userId);
          if (ws && card && member) void doReassign(ws, card, member);
          return;
        }
        case "auto-merge":
          updateWheel(null);
          if (ws && card) void doAutoMerge(ws, card);
          return;
        case "link-pr":
          updateWheel(null);
          if (ws && card) void doLinkPr(ws, card);
          return;
        case "fix-conflicts":
          updateWheel(null);
          if (ws && card) void doFix(ws, card, "conflicts");
          return;
        case "fix-checks":
          updateWheel(null);
          if (ws && card) void doFix(ws, card, "checks");
          return;
        case "board-mode":
          updateWheel(null);
          $boardMode.set(item.action.mode);
          return;
        case "global": {
          const op = item.action.op;
          updateWheel(null);
          const h = handlersRef.current;
          if (op === "new-card") h.openNewCard();
          else if (op === "refresh") h.refresh();
          else if (op === "workers") h.openWorkers();
          else if (op === "spot-checks") h.toggleSpotChecks();
          else if (op === "settings") h.openSettings();
          else if (op === "debug") h.openDebug();
          else if (op === "chat") h.toggleChat();
          return;
        }
        case "track-pr": {
          const pr = item.action.pr;
          updateWheel(null);
          handlersRef.current.trackPr(pr);
          return;
        }
        case "start-linear": {
          const { identifier, repo } = item.action;
          updateWheel(null);
          handlersRef.current.openNewCard({
            prompt: `Work on ${identifier}`,
            repo,
            linearIssueIdentifier: identifier,
          });
          return;
        }
        case "linear-filter": {
          const stateName = item.action.stateName;
          updateWheel(null);
          setLinearFilter(stateName);
          addToast(`Linear yard now showing "${stateName}" tickets.`, "info");
          return;
        }
      }
    };

    const confirmWheel = () => {
      const state = wheelRef.current;
      if (!state) return;
      const item = state.items[state.selected];
      if (item) runWheelItem(item);
    };

    const cycleWheel = (delta: number) => {
      const state = wheelRef.current;
      if (!state || state.items.length === 0) return;
      updateWheel({ ...state, selected: (state.selected + delta + state.items.length) % state.items.length });
    };

    /** Project the dog onto the screen so the wheel opens around the character. */
    const dogScreenCenter = (): { xPct: number; yPct: number } => {
      const v = dog.rig.position.clone();
      v.y += 1.2;
      v.project(scene.camera);
      return {
        xPct: Math.min(78, Math.max(22, ((v.x + 1) / 2) * 100)),
        yPct: Math.min(72, Math.max(28, ((1 - v.y) / 2) * 100)),
      };
    };

    const openWheel = () => {
      const nearest = nearestRef.current;
      const card = nearestCard();
      let spec: WheelSpec;
      if (card) spec = buildCardWheel(card, membersRef.current);
      else if (nearest?.kind === "pr-depot" && nearest.data?.prs?.length) spec = buildPrDepotWheel(nearest.data.prs);
      else if (nearest?.kind === "linear-depot" && nearest.data)
        spec = buildLinearDepotWheel(nearest.data.tickets ?? [], nearest.data.ticketFilters ?? [], nearest.data.ticketFilter ?? linearFilterRef.current ?? "");
      else spec = buildGlobalWheel(boardModeRef.current);
      updateWheel({ ...spec, selected: 0, card: card ?? undefined, center: dogScreenCenter() });
    };

    wheelApiRef.current = {
      select: (i) => {
        const state = wheelRef.current;
        if (state) updateWheel({ ...state, selected: i });
      },
      confirm: (i) => {
        const state = wheelRef.current;
        if (!state) return;
        const item = state.items[i];
        if (item) {
          updateWheel({ ...state, selected: i });
          runWheelItem(item);
        }
      },
    };

    const interact = () => {
      const nearest = nearestRef.current;
      if (!nearest) return;
      if (nearest.kind === "card") {
        const card = nearestCard();
        if (card) handlersRef.current.openTask(card.id);
        return;
      }
      if (nearest.kind === "pr-depot" || nearest.kind === "linear-depot") {
        // Browsing (and, for the yard, switching status) is the default action.
        openWheel();
        return;
      }
      const action = actionForInteractable(nearest);
      if (action) dispatchGameAction(action, handlersRef.current);
    };

    let beaconAt: { x: number; z: number } | null = null;
    const travelTo = (x: number, z: number) => {
      beaconAt = { x, z };
      scene.setBeacon(beaconAt);
      dog.setAutoTarget({ x, z });
    };
    whistleRef.current = (query: string) => {
      const match = findWorldMatch(query, layoutRef.current.interactables);
      if (!match) {
        addToast(`Nothing on the board matches "${query}".`, "info");
        return;
      }
      travelTo(match.x, match.z);
    };
    travelRef.current = travelTo;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current || isInputFocused() || e.metaKey || e.ctrlKey || e.altKey) return;

      if (wheelRef.current) {
        e.preventDefault();
        if (e.repeat) return;
        if (e.code === "KeyA" || e.code === "ArrowLeft") cycleWheel(-1);
        else if (e.code === "KeyD" || e.code === "ArrowRight") cycleWheel(1);
        else if (e.code === "Enter") confirmWheel();
        else if (e.code === "KeyE" && !eDown) confirmWheel(); // fresh tap in browse mode
        else if (e.code === "Escape") {
          const parent = wheelRef.current.parent;
          updateWheel(parent ?? null);
          if (eDown) suppressNextEUp = true;
        }
        return;
      }

      if (e.code === "KeyE") {
        e.preventDefault();
        if (e.repeat || eDown) return;
        eDown = true;
        suppressNextEUp = false;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          openWheel();
        }, HOLD_MS);
        return;
      }

      if (carryingRef.current) {
        if (e.code === "KeyF") {
          e.preventDefault();
          dropCarry();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          endCarry();
          addToast("Card put back.", "info");
          return;
        }
        keys.add(e.code);
        return;
      }

      if (e.code === "KeyF") {
        const card = nearestCard();
        if (card) {
          e.preventDefault();
          startCarry(card);
        }
        return;
      }
      if (e.code === "KeyB") {
        e.preventDefault();
        dog.bark();
        scene.pulseLabels(dog.rig.position.x, dog.rig.position.z);
        return;
      }
      if (e.code === "Slash") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      keys.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyE") {
        const wasDown = eDown;
        eDown = false;
        if (!wasDown) return;
        if (holdTimer) {
          // Released before the hold threshold — it's a tap.
          clearTimeout(holdTimer);
          holdTimer = null;
          if (!activeRef.current || isInputFocused()) return;
          if (carryingRef.current) dropCarry();
          else interact();
          return;
        }
        // Released after the wheel opened — confirm unless Esc canceled.
        if (wheelRef.current && !suppressNextEUp) confirmWheel();
        suppressNextEUp = false;
        return;
      }
      keys.delete(e.code);
    };
    const onBlur = () => {
      keys.clear();
      eDown = false;
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const onWheelScroll = (e: WheelEvent) => {
      e.preventDefault();
      scene.zoomBy(e.deltaY * 0.012);
      try { localStorage.setItem("manta:gameZoom", String(scene.getZoom())); } catch { /* ignore */ }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    container.addEventListener("wheel", onWheelScroll, { passive: false });

    const resize = () => scene.resize(container.clientWidth, container.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    window.__mantaGame = {
      getState: () => ({
        dog: { x: dog.rig.position.x, z: dog.rig.position.z },
        modelLoaded: !dog.rig.getObjectByName("placeholder-corgi"),
        nearestId: nearestRef.current?.id ?? null,
        carrying: carryingRef.current?.id ?? null,
        wheel: wheelRef.current
          ? { title: wheelRef.current.title, labels: wheelRef.current.items.map((i) => i.label), selected: wheelRef.current.selected }
          : null,
        linearFilter:
          layoutRef.current.interactables.find((i) => i.kind === "linear-depot")?.data?.ticketFilter ??
          linearFilterRef.current,
        zones: layoutRef.current.zones.map(({ status, x, z, halfW, halfD }) => ({ status, x, z, halfW, halfD })),
        interactables: layoutRef.current.interactables.map(({ id, kind, label, x, z }) => ({ id, kind, label, x, z })),
      }),
      setDogPosition: (x, z) => dog.setPosition(x, z),
      pressInteract: interact,
    };

    // Off-screen "❓" edge markers — a needy worker should never be missed.
    const markerInterval = setInterval(() => {
      const container2 = containerRef.current;
      if (!container2) return;
      const markers: { id: string; xPct: number; yPct: number; deg: number }[] = [];
      const v = new THREE.Vector3();
      for (const it of layoutRef.current.interactables) {
        if (it.kind !== "question") continue;
        v.set(it.x, 1.2, it.z).project(scene.camera);
        const behind = v.z > 1;
        const off = behind || Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
        if (!off) continue;
        let nx = behind ? -v.x : v.x;
        let ny = behind ? -v.y : v.y;
        const mag = Math.max(Math.abs(nx), Math.abs(ny), 0.0001);
        nx /= mag;
        ny /= mag;
        markers.push({
          id: it.id,
          xPct: Math.min(95, Math.max(5, ((nx + 1) / 2) * 100)),
          yPct: Math.min(92, Math.max(8, ((1 - ny) / 2) * 100)),
          deg: (Math.atan2(-ny, nx) * 180) / Math.PI + 90,
        });
      }
      setOffscreen((prev) => (JSON.stringify(prev) === JSON.stringify(markers) ? prev : markers));
    }, 180);

    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    let lastPromptId: string | null = "";
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Clamp at 100ms so a slow frame (or headless CI renderer) degrades to
      // slow-motion instead of teleporting, without freezing sim time.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      elapsed += dt;

      const inputLive = activeRef.current && !wheelRef.current;
      if (!inputLive) keys.clear();
      dog.update(dt, keys, layoutRef.current.bounds);

      const nearest = findNearestInteractable(dog.rig.position.x, dog.rig.position.z, layoutRef.current.interactables);
      nearestRef.current = nearest;
      if ((nearest?.id ?? null) !== lastPromptId) {
        lastPromptId = nearest?.id ?? null;
        setFocus(nearest);
      }
      // Clear the whistle beacon once the dog reaches it (or travel is canceled).
      if (beaconAt && Math.hypot(dog.rig.position.x - beaconAt.x, dog.rig.position.z - beaconAt.z) < 2) {
        beaconAt = null;
        scene.setBeacon(null);
      }
      scene.highlight(nearest, elapsed);
      scene.tick(dt, elapsed, dog.rig, dog.speedFraction());
      scene.render();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      clearInterval(markerInterval);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      container.removeEventListener("wheel", onWheelScroll);
      if (holdTimer) clearTimeout(holdTimer);
      delete window.__mantaGame;
      dog.dispose();
      scene.dispose();
      sceneRef.current = null;
      dogRef.current = null;
    };
    // Mount-once: stores feed in through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (bootError) {
    return (
      <div className="game-boot-error" data-testid="game-boot-error">
        Dog mode needs WebGL: {bootError}
        <button className="btn" onClick={toggleGameMode}>Back to the board</button>
      </div>
    );
  }

  return (
    <div className="game-canvas" data-testid="game-canvas" ref={containerRef}>
      <GameHud
        focus={wheel ? null : focus}
        carrying={carrying ? { title: carrying.title, status: STATUS_LABELS[carrying.cardStatus] } : null}
        wheelOpen={wheel !== null}
        workspaceName={me?.memberships.find((m) => m.workspaceId === activeWorkspaceId)?.name ?? ""}
        boardMode={boardMode}
        zones={layout.zones}
        onExit={toggleGameMode}
      />
      <GameMinimap
        layout={layout}
        getDog={() => dogRef.current ? { x: dogRef.current.rig.position.x, z: dogRef.current.rig.position.z } : null}
        onTravel={(x, z) => travelRef.current(x, z)}
      />
      {searchOpen && (
        <GameSearch
          onSearch={(q) => whistleRef.current(q)}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {offscreen.map((m) => (
        <div key={m.id} className="game-offscreen-marker" style={{ left: `${m.xPct}%`, top: `${m.yPct}%` }}>
          <span className="game-offscreen-arrow" style={{ transform: `rotate(${m.deg}deg)` }}>➤</span>
          <span>❓</span>
        </div>
      ))}
      {wheel && (
        <GameWheel
          title={wheel.title}
          items={wheel.items}
          selected={wheel.selected}
          center={wheel.center}
          onSelect={(i) => wheelApiRef.current.select(i)}
          onConfirm={(i) => wheelApiRef.current.confirm(i)}
        />
      )}
    </div>
  );
}
