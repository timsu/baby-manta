import { describe, expect, it } from "vitest";
import { isVisibleSandbox } from "./sandboxes.ts";

describe("isVisibleSandbox", () => {
  it.each([undefined, "started", "stopped", "starting"])("keeps controllable state %s", (state) => {
    expect(isVisibleSandbox({ state })).toBe(true);
  });

  it("hides archived provider records regardless of casing", () => {
    expect(isVisibleSandbox({ state: "archived" })).toBe(false);
    expect(isVisibleSandbox({ state: "ARCHIVED" })).toBe(false);
  });
});
