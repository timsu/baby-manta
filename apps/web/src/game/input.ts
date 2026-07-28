// Pure keyboard → movement mapping for the dog. The three.js layer owns the
// event listeners; this module owns the math so it's testable in node.

export interface MoveVector {
  /** -1 | 0 | 1 east-west. */
  dx: number;
  /** -1 | 0 | 1 north-south (negative z = "up" the board toward the cards). */
  dz: number;
  moving: boolean;
}

const FORWARD = ["KeyW", "ArrowUp"];
const BACK = ["KeyS", "ArrowDown"];
const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];

export function moveVectorFromKeys(keys: ReadonlySet<string>): MoveVector {
  const fwd = FORWARD.some((k) => keys.has(k)) ? 1 : 0;
  const back = BACK.some((k) => keys.has(k)) ? 1 : 0;
  const left = LEFT.some((k) => keys.has(k)) ? 1 : 0;
  const right = RIGHT.some((k) => keys.has(k)) ? 1 : 0;
  const dx = right - left;
  const dz = back - fwd;
  return { dx, dz, moving: dx !== 0 || dz !== 0 };
}

/** Yaw (radians) the dog should face for a movement vector. Matches the
 *  original corgi game's convention: -z is forward at yaw 0. */
export function yawForMove(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Shortest-arc wrap of a yaw delta into (-π, π]. */
export function wrapAngle(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Clamp a position to the walkable square. */
export function clampToBounds(v: number, bounds: number): number {
  return Math.max(-bounds, Math.min(bounds, v));
}
