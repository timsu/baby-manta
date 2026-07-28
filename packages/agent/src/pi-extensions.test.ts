import { describe, it, expect } from "vitest";
import { DEFAULT_PI_EXTENSION_SOURCES, PI_EXTENSION_RUNTIME_DEPENDENCIES, parsePinnedSpec, resolveNpmExtensionSpecs } from "./pi-extensions.ts";

describe("default Pi extensions", () => {
  it("includes the compatible automatic reasoning tool", () => {
    expect(DEFAULT_PI_EXTENSION_SOURCES).toContain("npm:@howaboua/pi-auto-reasoning-tool@0.1.11");
  });

  it("pins the Agent extension with foreground lifecycle fixes", () => {
    expect(DEFAULT_PI_EXTENSION_SOURCES).toContain("npm:@tintinweb/pi-subagents@0.14.2");
  });

  it("uses the same current Pi runtime for extension peers", () => {
    expect(PI_EXTENSION_RUNTIME_DEPENDENCIES).toEqual(expect.arrayContaining([
      "@earendil-works/pi-ai@0.81.1",
      "@earendil-works/pi-coding-agent@0.81.1",
      "@earendil-works/pi-tui@0.81.1",
    ]));
  });
});

describe("resolveNpmExtensionSpecs", () => {
  it("lets Manta's later pin replace a stale global package entry", () => {
    expect(resolveNpmExtensionSpecs([
      "npm:@tintinweb/pi-subagents",
      "npm:pi-web-access@0.13.0",
      "npm:@tintinweb/pi-subagents@0.14.2",
    ])).toEqual([
      "npm:@tintinweb/pi-subagents@0.14.2",
      "npm:pi-web-access@0.13.0",
    ]);
  });
});

describe("parsePinnedSpec", () => {
  it("splits a scoped, pinned spec into name + version", () => {
    expect(parsePinnedSpec("@earendil-works/pi-ai@0.79.2")).toEqual({
      name: "@earendil-works/pi-ai",
      version: "0.79.2",
    });
  });

  it("treats a scoped, unpinned spec as version-less", () => {
    expect(parsePinnedSpec("@earendil-works/pi-ai")).toEqual({ name: "@earendil-works/pi-ai", version: null });
  });

  it("handles unscoped pinned and unpinned specs", () => {
    expect(parsePinnedSpec("typebox@1.2.3")).toEqual({ name: "typebox", version: "1.2.3" });
    expect(parsePinnedSpec("typebox")).toEqual({ name: "typebox", version: null });
  });
});
