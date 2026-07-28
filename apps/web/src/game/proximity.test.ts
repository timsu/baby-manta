import { describe, expect, it } from "vitest";
import { findNearestInteractable, INTERACT_RANGE } from "./proximity.ts";
import type { Interactable } from "./types.ts";

function it_(id: string, x: number, z: number): Interactable {
  return { id, kind: "card", label: id, x, z };
}

describe("findNearestInteractable", () => {
  it("returns null when nothing is in range", () => {
    expect(findNearestInteractable(0, 0, [it_("far", 100, 100)])).toBeNull();
    expect(findNearestInteractable(0, 0, [])).toBeNull();
  });

  it("returns the nearest of several in-range candidates", () => {
    const list = [it_("close", 1, 0), it_("closer", 0.5, 0), it_("far", 3, 0)];
    expect(findNearestInteractable(0, 0, list)?.id).toBe("closer");
  });

  it("excludes candidates exactly at the range boundary", () => {
    expect(findNearestInteractable(0, 0, [it_("edge", INTERACT_RANGE, 0)])).toBeNull();
    expect(findNearestInteractable(0, 0, [it_("in", INTERACT_RANGE - 0.01, 0)])?.id).toBe("in");
  });

  it("breaks ties deterministically toward the earlier entry", () => {
    const list = [it_("first", 1, 0), it_("second", -1, 0)];
    expect(findNearestInteractable(0, 0, list)?.id).toBe("first");
  });

  it("measures distance in the xz plane", () => {
    expect(findNearestInteractable(10, 10, [it_("near", 11, 11)])?.id).toBe("near");
  });
});
