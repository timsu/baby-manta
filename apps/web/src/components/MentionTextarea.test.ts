import { describe, expect, it } from "vitest";
import { mentionFileMatches } from "./MentionTextarea.tsx";

describe("mentionFileMatches", () => {
  const files = [
    "apps/web/src/components/NewCardModal.tsx",
    "apps/web/src/components/MentionTextarea.tsx",
    "apps/server/src/workspaces/routes.ts",
    "packages/shared/src/modelProviders.ts",
  ];

  it("matches characters in order across the full filepath", () => {
    expect(mentionFileMatches(files, "ncm")[0]).toBe("apps/web/src/components/NewCardModal.tsx");
    expect(mentionFileMatches(files, "asw")).toContain("apps/server/src/workspaces/routes.ts");
  });

  it("keeps matching case-insensitive and non-contiguous", () => {
    expect(mentionFileMatches(files, "MDP")).toEqual(["packages/shared/src/modelProviders.ts"]);
  });

  it("does not match characters that appear out of order", () => {
    expect(mentionFileMatches(["src/components/NewCardModal.tsx"], "xdt")).toEqual([]);
  });
});
