import { describe, expect, it } from "vitest";
import { inputForMacOptionWordKey } from "./terminalKeys.ts";

function key(overrides: Partial<KeyboardEvent> & { code?: string }): KeyboardEvent {
  return {
    type: "keydown",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    key: "",
    ...overrides,
  } as KeyboardEvent;
}

describe("inputForMacOptionWordKey", () => {
  it("maps Option+F/B to readline Meta-f/Meta-b", () => {
    expect(inputForMacOptionWordKey(key({ code: "KeyF", key: "ƒ" }))).toBe("\x1bf");
    expect(inputForMacOptionWordKey(key({ code: "KeyB", key: "∫" }))).toBe("\x1bb");
  });

  it("maps Option+arrow word navigation to readline Meta-f/Meta-b", () => {
    expect(inputForMacOptionWordKey(key({ key: "ArrowRight" }))).toBe("\x1bf");
    expect(inputForMacOptionWordKey(key({ key: "ArrowLeft" }))).toBe("\x1bb");
  });

  it("does not intercept non-Option or non-keydown events", () => {
    expect(inputForMacOptionWordKey(key({ altKey: false, code: "KeyF", key: "f" }))).toBeNull();
    expect(inputForMacOptionWordKey(key({ type: "keyup", code: "KeyF", key: "f" }))).toBeNull();
    expect(inputForMacOptionWordKey(key({ ctrlKey: true, code: "KeyF", key: "f" }))).toBeNull();
  });
});
