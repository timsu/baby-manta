import { describe, expect, it } from "vitest";
import { collectDescendantPids } from "./terminal-pty.ts";

describe("collectDescendantPids", () => {
  it("returns nested descendants for a PTY root process", () => {
    const psOutput = `
      100     1
      101   100
      102   101
      103   102
      200     1
      201   200
    `;

    expect(collectDescendantPids(psOutput, 100).sort((a, b) => a - b)).toEqual([101, 102, 103]);
  });

  it("ignores malformed rows and unrelated processes", () => {
    const psOutput = `
      PID  PPID
      nope
      300   100
      301   300
      400     1
    `;

    expect(collectDescendantPids(psOutput, 100).sort((a, b) => a - b)).toEqual([300, 301]);
  });
});
