// Pure nearest-interactable selection for the E-key prompt.

import type { Interactable } from "./types.ts";

/** How close (world units) the dog must be for E to reach something. */
export const INTERACT_RANGE = 3.2;

export function distance2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Nearest interactable within `range` of (x, z), or null. Ties break toward
 *  the earlier entry so results are deterministic. */
export function findNearestInteractable(
  x: number,
  z: number,
  interactables: readonly Interactable[],
  range: number = INTERACT_RANGE,
): Interactable | null {
  let best: Interactable | null = null;
  let bestD = range * range;
  for (const it of interactables) {
    const d = distance2(x, z, it.x, it.z);
    if (d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}
