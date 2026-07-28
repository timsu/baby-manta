# Dog Mode — 3D game view of Manta

Dog mode renders the whole app as a night-time campus you explore as a corgi.
It is a *view*, not a fork: every object is derived from the same nanostores the
2D board reads, and every interaction dispatches the same callbacks/api calls
the 2D UI uses.

## Product categories → world mapping

The world is **THE BOARDWALK**: one street running west→east with the nine
status districts as plots along both sides in board order — the kanban flow
made spatial. Intake (PR wharf, Linear yard, workspace portals) sits at the
west end; work travels east toward Done, so carrying a card east = progress.
Operations are not world objects; they live in the hold-E wheel.

| Category | Product surface | 3D representation | Interaction |
|---|---|---|---|
| **Pipeline** | Kanban columns, cards, PR state, checks, worker activity | Status **district discs** on the outer ring behind lit gate arches; cards are **holo-kiosks** with distance LOD: full card face near (title, repo, status, PR/checks, assignee, live-worker pulse), mini id-plate at mid range, lit geometry far | **Tap E** opens the card. **Hold E** opens the radial wheel around the character (Open, Carry, Reassign submenu, Auto-merge, Link PR, Fix conflicts/checks). **F** carries — the holo-card floats over the dog; drop in another district to fire the same status transition as 2D drag (`isUserDragAllowed` validated; Esc puts it back) |
| **Creation** | New card modal, track GitHub PR, start Linear ticket | **Intake yards** at the west end: PR wharf (crate stack + count badge) and Linear yard (crystals), each with sample **item kiosks carrying full detail faces** (PR #, title, repo, branch, author / identifier, priority, state) under the same LOD as cards | Item E = track/start; depot E = browse wheel (up to 8) |
| **Agents / Oversight / Governance / Ops** | Workers, spot checks, settings, debug, refresh, board scope | **No world objects** — these are operations, not work, so they live in the hold-E global wheel | Hold E anywhere → wheel |
| **Intelligence** | Brain chat, pending user questions | Chat lives in the global wheel; unanswered worker questions spawn **"?" beacons** beside their card kiosk | Beacons open the task |
| **Places** | Workspaces | **Portal arches** on the west arc | `selectWorkspace` |

## UI & interaction considerations (and what was done)

- **Readability at a glance** — card kiosks carry the same info hierarchy as 2D
  cards (emoji + id, 2-line title, repo, status pill, PR/checks pill, assignee
  initials, live-worker dot), rendered at 2× DPR so text stays crisp.
- **Wayfinding** — one district per column in board order behind lit gates with
  emoji, title, and live count; paths lead to a central plaza; buildings are
  silhouette-distinct so you learn the map once.
- **Interaction affordance** — nearest interactable gets a pulsing ground ring,
  brightened trim, and a bottom-center prompt with a keycap glyph. Range ~3 world
  units; deterministic nearest-selection (unit-tested).
- **Input discipline** — game keys are suppressed while typing, while any modal
  or the quick-menu is open, and outside the board view. Esc closes panels the
  same way it does in 2D. Shell's own shortcuts (`c`, arrows) are disabled only
  while dog mode owns the board.
- **Depth & atmosphere** — night gradient sky dome, stars, distance fog, radial
  ground falloff, warm lamp glows, ACES tone mapping. The palette extends the
  app's `#131417` theme rather than fighting it.
- **Feedback** — dust puffs while sprinting, camera lag/lead, wheel zoom,
  errors surface through the app's existing toasts.
- **Performance** — one draw call per prop type where possible, capped pixel
  ratio, no per-frame allocations in the tick loop, three.js lazy-loaded only
  when dog mode is entered.
- **Testability** — pure layout/proximity/menu logic is unit-tested; Playwright
  drives the world via the `window.__mantaGame` hook with hermetic API mocks;
  `?gameassets=0` swaps the rigged FBX for a placeholder so CI never downloads
  models. (No model assets ship in this repo; the placeholder is the default.)

## Interaction model (game-standard)

- **Tap E** — default action on the nearest target (open card / use building).
- **Hold E (~¼s)** — radial wheel around the character, GTA-style. Near a card
  it's the card wheel; anywhere else it's the **global wheel** (New card,
  Refresh, Board scope, Workers, Spot checks, Settings, Server logs, Brain
  chat) — every app operation without running to its building. A/D or hover
  selects, release E / click confirms, Esc backs out of a submenu.
- **F** — carry a card between districts (status move).
- **Label LOD** — full holo-faces render only near the dog (or on the current
  target, <~7u); mid-range kiosks (<~13u) show a small id plate; far kiosks are
  lit geometry. Structure nameplates appear only when targeted or nearly
  touching. Keeps production-sized boards readable.
- **Aggregation** — districts cap at 8 freshest kiosks (a "+N more" totem
  covers the rest; the gate banner shows the true count); PRs/tickets collapse
  into depots instead of one object per item.
- **Focus inspector** — the pattern dense 3D games use: one fixed HUD panel
  (top-right) with crisp DOM details for whatever is nearest — full title,
  repo, PR/checks, assignee for cards; number/branch/author for PRs;
  identifier/priority/state for tickets. World labels stay LOD'd; the
  inspector is always legible.
- **Minimap** — bottom-right: the street with district plots in board order —
  a literal mini kanban — plus intake dots and the dog.

## Seeing real (production) data locally

Local dev uses your local Postgres, which usually has few or no cards. To run
dog mode against your real board, proxy the local web app at production:

1. Log in at manta.example.com, copy the `manta_session` cookie value
   (devtools → Application → Cookies).
2. `MANTA_PROD_PROXY=1 MANTA_PROD_COOKIE="manta_session=<value>" pnpm --filter @manta/web dev`
3. Open http://localhost:5173/?game=1

All `/api` + websocket traffic goes to production with your session —
**writes (card moves, new cards) are real**.

## Module map (`apps/web/src/game/`)

- `layout.ts` — pure world layout (districts, kiosk grid, beacons, buildings)
- `proximity.ts` / `input.ts` — pure interaction + movement math
- `gameActions.ts` — interactable → app-operation dispatch
- `palette.ts` — night-campus color system + status colors
- `labels.ts` — hi-DPI canvas billboard textures (card faces, gate banners)
- `worldObjects.ts` — procedural meshes (kiosks, gates, buildings, beacons)
- `props.ts` — environment (sky, stars, ground, paths, lamps, trees, dust)
- `scene.ts` — renderer/camera/lighting composition + world sync + label LOD
- `dogController.ts` — optional FBX rig + animation state machine + movement
- `cardOps.ts` — card operation executors (Board ··· parity, no DOM)
- `wheelItems.ts` — pure builders for the hold-E radial wheel
- `GameWheel.tsx` / `GameMinimap.tsx` — radial wheel overlay + minimap
- `GameCanvas.tsx` / `GameHud.tsx` / `GameBoard.tsx` — React glue + HUD
