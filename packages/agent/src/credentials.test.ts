import { describe, it, expect } from "vitest";
import {
  authStorageFromBlob,
  authBlob,
  setRawCredential,
  removeCredential,
  listProviders,
  listAvailableModels,
  pickBrainBackendId,
} from "./index.ts";

const codexCred = { type: "oauth", refresh: "r-tok", access: "a-tok", expires: 9999999999 };
const claudeCred = { type: "oauth", token: "sk-ant-oat01-test" };

describe("workspace credential helpers", () => {
  it("round-trips a credential through a blob", () => {
    const auth = authStorageFromBlob({});
    setRawCredential(auth, "openai-codex", codexCred);
    const blob = authBlob(auth);
    expect(blob["openai-codex"]).toMatchObject({ type: "oauth", access: "a-tok" });

    const reloaded = authStorageFromBlob(blob);
    expect(authBlob(reloaded)["openai-codex"]).toMatchObject({ refresh: "r-tok" });

    removeCredential(reloaded, "openai-codex");
    expect(authBlob(reloaded)["openai-codex"]).toBeUndefined();
  });

  it("reports Codex as configured once its credential is stored", () => {
    const empty = listProviders(authStorageFromBlob({}));
    const codexEmpty = empty.find((p) => p.id === "openai-codex");
    expect(codexEmpty).toBeDefined();
    expect(codexEmpty?.configured).toBe(false);
    expect(codexEmpty?.authKind).toBe("subscription");

    const configured = listProviders(authStorageFromBlob({ "openai-codex": codexCred }));
    expect(configured.find((p) => p.id === "openai-codex")?.configured).toBe(true);
  });

  it("always surfaces the known API-key providers for configuration", () => {
    const ids = listProviders(authStorageFromBlob({})).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["openai-codex", "claude-code", "anthropic", "openai"]));
  });

  it("reports Claude Code as configured and lists Claude bridge models once its token is stored", () => {
    const auth = authStorageFromBlob({ "claude-code": claudeCred });
    const claude = listProviders(auth).find((p) => p.id === "claude-code");
    expect(claude).toMatchObject({ configured: true, authKind: "subscription" });
    expect(claude?.modelCount).toBeGreaterThan(0);
    expect(listAvailableModels(auth).map((m) => m.id)).toContain("pi-claude-bridge:claude-sonnet-4-6");
  });

  it("picks a Codex backend id when Codex is the configured provider", () => {
    const id = pickBrainBackendId(authStorageFromBlob({ "openai-codex": codexCred }));
    expect(id).toMatch(/^pi-openai-codex:/);
  });

  it("picks a Claude bridge backend id when only Claude Code OAuth is configured", () => {
    const id = pickBrainBackendId(authStorageFromBlob({ "claude-code": claudeCred }));
    expect(id).toMatch(/^pi-claude-bridge:/);
  });
});
