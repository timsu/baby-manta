import { describe, expect, it } from "vitest";
import { clampFloatingChatPosition } from "./FloatingChat.tsx";

describe("clampFloatingChatPosition", () => {
  it("keeps a dragged chat window inside the viewport", () => {
    expect(clampFloatingChatPosition(
      { left: -40, top: 900 },
      { width: 400, height: 500 },
      { width: 1200, height: 800 },
    )).toEqual({ left: 12, top: 288 });
  });

  it("uses the viewport margin when the window is larger than the viewport", () => {
    expect(clampFloatingChatPosition(
      { left: 200, top: 100 },
      { width: 700, height: 900 },
      { width: 600, height: 700 },
    )).toEqual({ left: 12, top: 12 });
  });
});
