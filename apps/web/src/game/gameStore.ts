// Dog-mode toggle. Persisted like $mantaHidden / $boardMode in ../stores.ts.
// A `?game=1` / `?game=0` query param overrides and persists, so e2e tests and
// shared links can force the mode without touching the menu.

import { atom } from "nanostores";

const STORAGE_KEY = "manta:gameMode";

function initialGameMode(): boolean {
  let fromParam: boolean | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("game");
    if (raw !== null) fromParam = raw === "1" || raw === "true";
  } catch { /* non-browser env */ }
  if (fromParam !== null) {
    try { localStorage.setItem(STORAGE_KEY, fromParam ? "true" : "false"); } catch { /* ignore */ }
    return fromParam;
  }
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

export const $gameMode = atom<boolean>(initialGameMode());
$gameMode.listen((on) => {
  try { localStorage.setItem(STORAGE_KEY, on ? "true" : "false"); } catch { /* ignore */ }
});

export function toggleGameMode() {
  $gameMode.set(!$gameMode.get());
}
