import { describe, expect, it } from "vitest";
import { resolveCanonicalRepo } from "./canonical.ts";

const repos = [{ orgRepo: "acme/manta" }, { orgRepo: "acme/platform" }];

describe("resolveCanonicalRepo", () => {
  it("keeps exact configured repos", () => {
    expect(resolveCanonicalRepo("acme/manta", repos)).toBe("acme/manta");
  });

  it("matches configured repos case-insensitively", () => {
    expect(resolveCanonicalRepo("Acme/Manta", repos)).toBe("acme/manta");
  });

  it("repairs a wrong-owner slug when the repo name is unique", () => {
    expect(resolveCanonicalRepo("wrong-org/manta", repos)).toBe("acme/manta");
  });

  it("repairs a bare unique repo name", () => {
    expect(resolveCanonicalRepo("manta", repos)).toBe("acme/manta");
  });

  it("does not guess when the repo name is ambiguous", () => {
    expect(resolveCanonicalRepo("api", [{ orgRepo: "acme/api" }, { orgRepo: "other/api" }])).toBe("api");
    expect(resolveCanonicalRepo("wrong/api", [{ orgRepo: "acme/api" }, { orgRepo: "other/api" }])).toBe("wrong/api");
  });
});
