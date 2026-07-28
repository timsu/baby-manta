import { describe, it, expect, beforeAll } from "vitest";

// crypto.ts derives its key lazily from config on first use; set a secret before
// importing so the module under test can read it.
beforeAll(() => {
  process.env["SESSION_SECRET"] = "test-session-secret-for-crypto";
  delete process.env["SECRETS_KEY"];
});

describe("secret crypto", () => {
  it("round-trips an encrypted JSON blob", async () => {
    const { encryptJson, decryptJson } = await import("./crypto.ts");
    const value = { "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } };
    const buf = encryptJson(value);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(decryptJson(buf)).toEqual(value);
  });

  it("produces different ciphertext for the same plaintext (random IV)", async () => {
    const { encrypt } = await import("./crypto.ts");
    expect(encrypt("hello").equals(encrypt("hello"))).toBe(false);
  });

  it("rejects tampered ciphertext (GCM auth tag)", async () => {
    const { encrypt, decrypt } = await import("./crypto.ts");
    const buf = encrypt("secret");
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff; // flip a ciphertext byte
    expect(() => decrypt(buf)).toThrow();
  });
});
