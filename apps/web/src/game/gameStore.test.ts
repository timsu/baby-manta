import { describe, expect, it } from "vitest";
import { $gameMode, toggleGameMode } from "./gameStore.ts";

describe("$gameMode", () => {
  it("defaults to off outside a browser (no localStorage / URL)", () => {
    expect($gameMode.get()).toBe(false);
  });

  it("toggles", () => {
    const before = $gameMode.get();
    toggleGameMode();
    expect($gameMode.get()).toBe(!before);
    toggleGameMode();
    expect($gameMode.get()).toBe(before);
  });
});
