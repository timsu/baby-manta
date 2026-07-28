import { describe, expect, it, vi } from "vitest";
import { forwardTerminalEscape, isTerminalFocused } from "./terminalFocus.ts";

function element(inTerminal: boolean): EventTarget {
  return { closest: (selector: string) => selector === ".xterm" && inTerminal ? {} : null } as unknown as EventTarget;
}

describe("isTerminalFocused", () => {
  it("recognizes an event from the terminal", () => {
    expect(isTerminalFocused(element(true), element(false))).toBe(true);
  });

  it("recognizes terminal focus when an event is retargeted", () => {
    expect(isTerminalFocused(element(false), element(true))).toBe(true);
  });

  it("does not match non-terminal elements", () => {
    expect(isTerminalFocused(element(false), element(false))).toBe(false);
  });
});

describe("forwardTerminalEscape", () => {
  it("sends Escape while preventing it from moving focus out of the terminal", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const sendInput = vi.fn();
    const refocus = vi.fn();
    const event = { type: "keydown", key: "Escape", target: element(false), preventDefault, stopPropagation } as unknown as KeyboardEvent;

    expect(forwardTerminalEscape(event, element(true), sendInput, refocus)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledWith("\x1b");
    expect(refocus).toHaveBeenCalledOnce();
  });

  it("leaves Escape outside the terminal for the card handler", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const sendInput = vi.fn();
    const event = { type: "keydown", key: "Escape", target: element(false), preventDefault, stopPropagation } as unknown as KeyboardEvent;

    expect(forwardTerminalEscape(event, element(false), sendInput)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not consume the terminal keyup event", () => {
    const event = {
      type: "keyup",
      key: "Escape",
      target: element(true),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    const sendInput = vi.fn();
    expect(forwardTerminalEscape(event, element(true), sendInput)).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });
});
