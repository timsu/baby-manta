import { describe, expect, it } from "vitest";
import { MantaAuthStorage } from "./auth-storage.ts";

const oauth = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 };

function bumpExpiry(current: Awaited<ReturnType<MantaAuthStorage["read"]>>) {
  if (current?.type !== "oauth") throw new Error("expected OAuth credential");
  return { ...current, expires: current.expires + 1 };
}

describe("MantaAuthStorage", () => {
  it("serializes concurrent credential refreshes per provider", async () => {
    const storage = MantaAuthStorage.inMemory({ codex: oauth });
    await Promise.all([
      storage.modify("codex", async (current) => {
        await Promise.resolve();
        return bumpExpiry(current);
      }),
      storage.modify("codex", async (current) => bumpExpiry(current)),
    ]);

    expect(await storage.read("codex")).toMatchObject({ expires: 3 });
  });

  it("leaves the current credential unchanged when modify returns undefined", async () => {
    const storage = MantaAuthStorage.inMemory({ codex: oauth });
    await storage.modify("codex", async () => undefined);
    expect(await storage.read("codex")).toEqual(oauth);
  });
});
