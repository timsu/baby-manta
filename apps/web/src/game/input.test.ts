import { describe, expect, it } from "vitest";
import { clampToBounds, moveVectorFromKeys, wrapAngle, yawForMove } from "./input.ts";

describe("moveVectorFromKeys", () => {
  it("maps WASD to the four directions", () => {
    expect(moveVectorFromKeys(new Set(["KeyW"]))).toEqual({ dx: 0, dz: -1, moving: true });
    expect(moveVectorFromKeys(new Set(["KeyS"]))).toEqual({ dx: 0, dz: 1, moving: true });
    expect(moveVectorFromKeys(new Set(["KeyA"]))).toEqual({ dx: -1, dz: 0, moving: true });
    expect(moveVectorFromKeys(new Set(["KeyD"]))).toEqual({ dx: 1, dz: 0, moving: true });
  });

  it("supports arrow keys and diagonals", () => {
    expect(moveVectorFromKeys(new Set(["ArrowUp", "ArrowRight"]))).toEqual({ dx: 1, dz: -1, moving: true });
  });

  it("cancels opposing keys and reports not moving", () => {
    expect(moveVectorFromKeys(new Set(["KeyW", "KeyS"]))).toEqual({ dx: 0, dz: 0, moving: false });
    expect(moveVectorFromKeys(new Set())).toEqual({ dx: 0, dz: 0, moving: false });
  });

  it("ignores unrelated keys", () => {
    expect(moveVectorFromKeys(new Set(["KeyE", "Space"])).moving).toBe(false);
  });
});

describe("yawForMove", () => {
  it("faces -z (up the board) for forward", () => {
    expect(yawForMove(0, -1)).toBeCloseTo(0);
  });
  it("faces +z for backward and ±π/2 for strafing", () => {
    expect(Math.abs(yawForMove(0, 1))).toBeCloseTo(Math.PI);
    expect(yawForMove(1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(yawForMove(-1, 0)).toBeCloseTo(Math.PI / 2);
  });
});

describe("wrapAngle", () => {
  it("wraps deltas to a magnitude of at most π", () => {
    expect(Math.abs(wrapAngle(3 * Math.PI))).toBeCloseTo(Math.PI);
    expect(Math.abs(wrapAngle(-3 * Math.PI))).toBeCloseTo(Math.PI);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5);
    expect(wrapAngle(2 * Math.PI + 0.3)).toBeCloseTo(0.3);
  });
});

describe("clampToBounds", () => {
  it("clamps symmetrically", () => {
    expect(clampToBounds(100, 30)).toBe(30);
    expect(clampToBounds(-100, 30)).toBe(-30);
    expect(clampToBounds(5, 30)).toBe(5);
  });
});
