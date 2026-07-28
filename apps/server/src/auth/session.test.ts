import { describe, it, expect } from "vitest";
import { createSessions } from "./session.ts";

describe("createSessions", () => {
  const secret = "test-secret-please-ignore";

  it("issues a token that verifies back to the same user", async () => {
    const s = createSessions(secret);
    const token = await s.issue({ userId: "u1", email: "a@b.com" });
    const claims = await s.verify(token);
    expect(claims?.sub).toBe("u1");
    expect(claims?.email).toBe("a@b.com");
  });

  it("rejects a tampered token", async () => {
    const s = createSessions(secret);
    const token = await s.issue({ userId: "u1", email: "a@b.com" });
    expect(await s.verify(token + "x")).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const a = createSessions("secret-a");
    const b = createSessions("secret-b");
    const token = await a.issue({ userId: "u1", email: "a@b.com" });
    expect(await b.verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const past = () => new Date("2000-01-01T00:00:00Z");
    const s = createSessions(secret, past);
    const token = await s.issue({ userId: "u1", email: "a@b.com" });
    // verify uses real time internally (hono checks exp); a 2000-dated exp is past.
    expect(await s.verify(token)).toBeNull();
  });
});
