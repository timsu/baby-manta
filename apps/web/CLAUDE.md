# apps/web

React/Vite frontend.

## Principles

- **No giant files.** Keep modules small and single-purpose. One component (or a
  tightly related cluster) per file; shared helpers go in `lib/`, data actions in
  `actions.ts`, settings panels under `settings/`. `main.tsx` stays a thin Vite
  entry that just renders `<App />`. If a file is growing past a few hundred lines
  or mixing unrelated concerns, split it.

## Dog mode (`src/game/`)

Optional 3D board view: a dog character (three.js) runs around a compact ring-city
world derived from the same nanostores the 2D board reads; interactions
dispatch the same callbacks/api calls the 2D UI uses. Card interactions are
in-world: tap E opens/uses, hold E opens a radial wheel around the character
(card ops near a card, the global operation wheel elsewhere — builders in
`wheelItems.ts`, executors in `cardOps.ts`), F carries a card to another
district (status transition, drag-parity). Labels LOD by distance; a minimap
sits bottom-right. Full design +
product-category → world mapping + prod-data proxy instructions:
`docs/GAME_MODE.md`.

- Toggle: user-menu item, `?game=1`/`?game=0` param, or `localStorage manta:gameMode`
  (`$gameMode` in `game/gameStore.ts`). Off by default; the module is `React.lazy`-loaded
  from `Shell.tsx` so three.js stays out of the main bundle.
- Pure logic (`layout.ts`, `proximity.ts`, `input.ts`, `gameActions.ts`) is
  unit-tested with vitest; rendering lives in `scene.ts`/`dogController.ts`;
  React glue in `GameBoard.tsx`/`GameCanvas.tsx`/`GameHud.tsx`.
- Rigged FBX + animation clips are optional and not bundled in this repo; the
  controller falls back to a placeholder box-dog when they are absent or fail to
  load, and `?gameassets=0` skips loading entirely (used by e2e). To use a real
  model, drop the clips named in `dogController.ts` into `public/models/corgi/`.
- E2E: `pnpm test:e2e` (Playwright, `e2e/`). Hermetic — all `/api` calls are
  mocked in `e2e/mockApi.ts`, no server/DB/OAuth needed. The canvas exposes a
  `window.__mantaGame` hook for deterministic dog teleporting in tests.
