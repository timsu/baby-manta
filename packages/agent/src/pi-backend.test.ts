import { describe, it, expect } from "vitest";
import { jsonSchemaToTypebox, nextOverloadFallback, isOverloadError, isAuthError, expiredCredentialHint, planEmptyTurnFailover, selectSessionManager, usesClaudeBridgeBackend, resetClaudeBridgeRegistration, listAvailableModels, shouldCompactBeforeTurn, authStorageFromBlob } from "./pi-backend.ts";

describe("selectSessionManager", () => {
  const cwd = "/wt/card-c-abc123";
  const factory = (existing: Set<string>) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        open: (p: string, c: string) => { calls.push(`open:${p}:${c}`); return "open" as const; },
        create: (c: string) => { calls.push(`create:${c}`); return "create" as const; },
        continueRecent: (c: string) => { calls.push(`continueRecent:${c}`); return "recent" as const; },
        exists: (p: string) => existing.has(p),
      },
    };
  };

  it("resumes the exact session when resumeFrom exists on this venue", () => {
    const f = factory(new Set(["/sessions/a.jsonl"]));
    const r = selectSessionManager({ cwd, resumeFrom: "/sessions/a.jsonl", resumeRecentForCwd: true }, f.deps);
    expect(r).toEqual({ sessionManager: "open", resuming: true });
    expect(f.calls).toEqual([`open:/sessions/a.jsonl:${cwd}`]);
  });

  it("recovers the most-recent cwd session when the key is lost and recovery is on (the redeploy-fork fix)", () => {
    const f = factory(new Set()); // resumeFrom absent on this venue
    const r = selectSessionManager({ cwd, resumeFrom: "/gone/stale.jsonl", resumeRecentForCwd: true }, f.deps);
    expect(r).toEqual({ sessionManager: "recent", resuming: false });
    expect(f.calls).toEqual([`continueRecent:${cwd}`]);
  });

  it("recovers for a worker even with no key at all", () => {
    const f = factory(new Set());
    const r = selectSessionManager({ cwd, resumeRecentForCwd: true }, f.deps);
    expect(r).toEqual({ sessionManager: "recent", resuming: false });
    expect(f.calls).toEqual([`continueRecent:${cwd}`]);
  });

  it("starts fresh (never cross-resumes) when recovery is off — the brain default", () => {
    const f = factory(new Set());
    const r = selectSessionManager({ cwd }, f.deps);
    expect(r).toEqual({ sessionManager: "create", resuming: false });
    expect(f.calls).toEqual([`create:${cwd}`]);
  });
});

describe("jsonSchemaToTypebox", () => {
  it("preserves nested array/object tool parameters", () => {
    const schema = jsonSchemaToTypebox({
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "checked"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
      },
    });

    expect(schema).toMatchObject({
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "checked"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
      },
    });
  });
});

describe("usesClaudeBridgeBackend", () => {
  it("matches claude-bridge backend ids and not others", () => {
    expect(usesClaudeBridgeBackend("pi-claude-bridge:claude-opus-4-8")).toBe(true);
    expect(usesClaudeBridgeBackend("pi-openai-codex:gpt-5.5")).toBe(false);
  });
});

describe("listAvailableModels", () => {
  it("includes the GPT-5.6 Codex models from the Pi SDK", () => {
    const auth = authStorageFromBlob({ "openai-codex": { type: "oauth", access: "a-tok", refresh: "r-tok", expires: 9999999999 } });
    const ids = listAvailableModels(auth).map((m) => m.id);
    expect(ids).toContain("pi-openai-codex:gpt-5.6-luna");
    expect(ids).toContain("pi-openai-codex:gpt-5.6-sol");
    expect(ids).toContain("pi-openai-codex:gpt-5.6-terra");
    expect(ids).toContain("pi-openai-codex:gpt-5.5");
  });
});

describe("resetClaudeBridgeRegistration", () => {
  it("drops the bridge's active-instance guard so the next extension load re-registers (the sequential cross-card bleed fix)", () => {
    // Same well-known key the bridge uses (Symbol.for → process-wide).
    const key = Symbol.for("claude-bridge:activeStreamSimple");
    const g = globalThis as Record<symbol, unknown>;
    const stale = () => {};
    g[key] = stale; // simulate the immortal first-loaded bridge instance
    resetClaudeBridgeRegistration();
    expect(g[key]).toBeUndefined();
  });
});

describe("nextOverloadFallback", () => {
  it("leads with opus-5 and never routes a fallback to fable-5", () => {
    // opus-5 heads the chain; fable-5 is a premium model and is never a target.
    expect(nextOverloadFallback("pi-claude-bridge:claude-opus-5")).toBe("pi-claude-bridge:claude-opus-4-8");
    expect(nextOverloadFallback("pi-claude-bridge:claude-opus-4-8")).toBe("pi-claude-bridge:claude-opus-4-7");
    // No model falls back to fable-5.
    for (const step of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(nextOverloadFallback(`pi-claude-bridge:${step}`)).not.toBe("pi-claude-bridge:claude-fable-5");
    }
  });

  it("degrades an overloaded fable-5 to the chain head rather than failing", () => {
    expect(nextOverloadFallback("pi-claude-bridge:claude-fable-5")).toBe("pi-claude-bridge:claude-opus-5");
  });

  it("returns null past the last model and for non-bridge backends", () => {
    expect(nextOverloadFallback("pi-claude-bridge:claude-haiku-4-5")).toBeNull();
    expect(nextOverloadFallback("pi-gpt-5.5")).toBeNull();
    expect(nextOverloadFallback("pi-openai-codex:gpt-5.5")).toBeNull();
  });
});

describe("expiredCredentialHint", () => {
  it("names the provider and the fix so an empty turn isn't a silent stall", () => {
    const codex = expiredCredentialHint("pi-openai-codex:gpt-5.5", { elapsedMs: 30_000, hadCredentials: true });
    expect(codex).toContain("ChatGPT Codex");
    expect(codex).toMatch(/re-?login/i);
    expect(expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000, hadCredentials: true })).toContain("Claude Code");
  });

  it("hedges rather than diagnosing, so a healthy credential isn't blamed outright", () => {
    const hint = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000, hadCredentials: true });
    expect(hint).toContain("often");
    expect(hint).toMatch(/worker log/i);
  });

  it("omitting credential presence never blames the subscription", () => {
    // Defaults to "no credential" rather than the expired-subscription wording:
    // when presence is unknown there is no evidence a subscription is at fault,
    // and guessing wrong is what this whole change exists to stop.
    const hint = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000 });
    expect(hint).not.toMatch(/subscription/i);
  });

  it("points a sub-3s turn at the logs, not at re-login — it never reached the model", () => {
    const hint = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 781 });
    expect(hint).toContain("781ms");
    expect(hint).toMatch(/re-?login will not help/i);
    expect(hint).not.toMatch(/subscription/i);
  });

  it("says so when no credential backed the turn", () => {
    const hint = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000, hadCredentials: false });
    expect(hint).toMatch(/no credential/i);
    expect(hint).not.toMatch(/subscription/i);
  });
});

describe("planEmptyTurnFailover", () => {
  it("blacklists and rotates when a slow empty turn burned a pooled credential", () => {
    const plan = planEmptyTurnFailover({ elapsedMs: 30_000, credentialKeys: ["a"], excludedCreds: [] });
    expect(plan).toEqual({ notifyAuthFailure: true, retryWith: ["a"] });
  });

  it("does neither on a sub-3s turn — the regression that burned a whole pool", () => {
    // The production incident: a local startup crash reported auth failure against
    // a healthy credential, and rotation then blacklisted every credential in turn,
    // each failing identically because the credential was never the problem.
    const plan = planEmptyTurnFailover({ elapsedMs: 781, credentialKeys: ["a", "b"], excludedCreds: [] });
    expect(plan).toEqual({ notifyAuthFailure: false, retryWith: [] });
  });

  it("reports the failure but stops rotating once every pooled credential is spent", () => {
    const plan = planEmptyTurnFailover({ elapsedMs: 30_000, credentialKeys: ["a"], excludedCreds: ["a"] });
    expect(plan).toEqual({ notifyAuthFailure: true, retryWith: [] });
  });

  it("stops rotating at the failover cap so a pool of dead subs can't loop forever", () => {
    const plan = planEmptyTurnFailover({ elapsedMs: 30_000, credentialKeys: ["e"], excludedCreds: ["a", "b", "c", "d"] });
    expect(plan).toEqual({ notifyAuthFailure: true, retryWith: [] });
  });

  it("skips the credential path entirely for a worker, which has no pool", () => {
    const plan = planEmptyTurnFailover({ elapsedMs: 30_000, credentialKeys: [], excludedCreds: [] });
    expect(plan).toEqual({ notifyAuthFailure: false, retryWith: [] });
  });
});

describe("isOverloadError", () => {
  it("matches 529 / overloaded and the bridge idle-timeout, not ordinary errors", () => {
    expect(isOverloadError(new Error("529 overloaded_error: Overloaded"))).toBe(true);
    expect(isOverloadError(new Error("Claude Code stream idle timeout after 90s"))).toBe(true);
    expect(isOverloadError(new Error("TypeError: cannot read property 'x'"))).toBe(false);
    expect(isOverloadError(undefined)).toBe(false);
  });
});

describe("isAuthError", () => {
  it("matches dead/unauthorized subscription errors, not ordinary tool errors", () => {
    expect(isAuthError(new Error("401 Unauthorized"))).toBe(true);
    expect(isAuthError(new Error("request failed with status 403"))).toBe(true);
    expect(isAuthError(new Error("invalid_grant: token has expired"))).toBe(true);
    expect(isAuthError(new Error("invalid api key"))).toBe(true);
    expect(isAuthError(new Error("no credentials for provider openai-codex"))).toBe(true);
    // Not auth: ordinary failures must never blacklist a good account.
    expect(isAuthError(new Error("TypeError: cannot read property 'x'"))).toBe(false);
    expect(isAuthError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("shouldCompactBeforeTurn", () => {
  it("compacts once usage reaches the threshold", () => {
    expect(shouldCompactBeforeTurn({ percent: 80 }, 80)).toBe(true);
    expect(shouldCompactBeforeTurn({ percent: 98.7 }, 80)).toBe(true);
    expect(shouldCompactBeforeTurn({ percent: 100 }, 80)).toBe(true);
  });

  it("leaves a session below the threshold alone", () => {
    expect(shouldCompactBeforeTurn({ percent: 79.9 }, 80)).toBe(false);
    expect(shouldCompactBeforeTurn({ percent: 0 }, 80)).toBe(false);
  });

  it("does nothing when usage is unavailable", () => {
    expect(shouldCompactBeforeTurn(undefined, 80)).toBe(false);
    expect(shouldCompactBeforeTurn({ percent: null }, 80)).toBe(false);
  });

  it("is disabled by a non-positive threshold", () => {
    expect(shouldCompactBeforeTurn({ percent: 99 }, 0)).toBe(false);
    expect(shouldCompactBeforeTurn({ percent: 99 }, Number.NaN)).toBe(false);
  });
});
