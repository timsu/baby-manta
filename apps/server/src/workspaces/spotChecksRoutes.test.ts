import { describe, expect, it } from "vitest";
import { expiredCredentialHint } from "@manta/agent";
import { clearCredentialReauth, credentialNeedsReauth, reportBackgroundRunAuthFailure } from "../models/service.ts";
import { isExpiredCredentialResponse, nextSpotCheckRunAt, normalizeSpotChecks, parseSpotCheckReport, spotCheckHistoryPrompt, spotCheckRunPrompt } from "./spotChecksRoutes.ts";

describe("normalizeSpotChecks", () => {
  it("generates stable fallback ids for persisted checks without ids", () => {
    const stored = [{ name: "CI health", instructions: "Check failing builds", repo: "acme/manta" }];

    const first = normalizeSpotChecks(stored);
    const second = normalizeSpotChecks(stored);

    expect(first[0]?.id).toMatch(/^sc-[a-f0-9]{12}$/);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it("keeps fallback ids distinct for repeated checks in one list", () => {
    const stored = [
      { name: "CI health", instructions: "Check failing builds" },
      { name: "CI health", instructions: "Check failing builds" },
    ];

    const normalized = normalizeSpotChecks(stored);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.id).not.toBe(normalized[1]?.id);
  });

  it("migrates minute schedules to an hourly cadence", () => {
    const normalized = normalizeSpotChecks([{ name: "Sentry", instructions: "Check new issues", schedule: { enabled: true, timeZone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00", intervalMinutes: 30 } }]);

    expect(normalized[0]?.schedule).toMatchObject({ enabled: true, cadence: "hourly", timeZone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00" });
  });
});

describe("parseSpotCheckReport", () => {
  it("accepts color grade aliases", () => {
    expect(parseSpotCheckReport("GRADE: Red\nSUMMARY: Two actionable issues")).toEqual({ verdict: "fail", summary: "Two actionable issues" });
    expect(parseSpotCheckReport("VERDICT: yellow\nSUMMARY: Needs attention").verdict).toBe("warn");
  });

  it("accepts markdown labels and emoji grades", () => {
    expect(parseSpotCheckReport("**GRADE:** 🔴 Red\n**SUMMARY:** Two actionable issues")).toEqual({ verdict: "fail", summary: "Two actionable issues" });
    expect(parseSpotCheckReport("- Verdict / grade: ⚠️ needs attention\nSUMMARY: Needs triage").verdict).toBe("warn");
  });

  it("infers a grade when the worker omits the required label", () => {
    expect(parseSpotCheckReport("No genuinely new actionable Sentry issues; current candidates are already reported, ticketed, archived, or part of prior follow-up.").verdict).toBe("pass");
    expect(parseSpotCheckReport("No genuinely new actionable >5/day Sentry issues; active candidates are already prior-reported, resolved, or archived.").verdict).toBe("pass");
    expect(parseSpotCheckReport("Sentry spot check could not run because this worker lacks usable Sentry credentials.").verdict).toBe("warn");
    expect(parseSpotCheckReport("One new actionable web-research Hatchet timeout burst needs Linear triage.").verdict).toBe("fail");
  });

  it("reads the verdict when narration runs into the required label", () => {
    // Real report (2026-07-24): the worker's opening narration and its final
    // answer arrived as one unbroken chunk, so `VERDICT:` was mid-line. The
    // anchored match missed it and inference graded a blocked run green.
    const glued = "I’ll perform a read-only Sentry scan, retrying via `.env.shared` if needed.VERDICT: warn\nSUMMARY: Live Sentry scan remains blocked by environment decryption failure.\n\n## Result\n- Sentry credentials could not decrypt (`WRONG_PRIVATE_KEY`).\n- No live Sentry issues could be reviewed; no new actionable findings or follow-up requests created.";

    expect(parseSpotCheckReport(glued)).toEqual({
      verdict: "warn",
      summary: "Live Sentry scan remains blocked by environment decryption failure.",
    });
  });

  it("grades a blocked run yellow even when it reports no actionable findings", () => {
    // A check that never reached the service found nothing because it looked at
    // nothing — grading that green hid a week of dead Sentry scans.
    const blocked = "Live Sentry scan remains blocked by environment decryption failure.\nSentry credentials could not decrypt (WRONG_PRIVATE_KEY).\nNo live Sentry issues could be reviewed; no new actionable findings or follow-up requests created.";

    expect(parseSpotCheckReport(blocked).verdict).toBe("warn");
    expect(parseSpotCheckReport("Environment validation failed because PLATFORM_DATABASE_URL is missing; no new actionable issues were reviewed.").verdict).toBe("warn");
  });

  // These build their input with the agent's own `expiredCredentialHint` rather
  // than a copied string literal. The two live in different packages, so a
  // wording change on the agent side would otherwise pass both packages' tests
  // while silently breaking the match here — the failure mode the "kept in sync"
  // comments on both functions warn about.
  it("recognizes the standard expired-subscription response", () => {
    const response = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000, hadCredentials: true });

    expect(isExpiredCredentialResponse(response)).toBe(true);
    expect(parseSpotCheckReport(response).verdict).toBe("warn");
    expect(isExpiredCredentialResponse("Sentry could not run because its credentials are missing.")).toBe(false);
  });

  it("does not flag the credential for an empty turn that failed before reaching the model", () => {
    // A local startup crash implicates no subscription — flagging one here is
    // what sent a user through five pointless re-logins.
    const setupFailure = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 781, hadCredentials: true });

    expect(isExpiredCredentialResponse(setupFailure)).toBe(false);
    expect(parseSpotCheckReport(setupFailure).verdict).toBe("warn");
  });

  it("does not flag the credential when no credential backed the turn", () => {
    const noCredential = expiredCredentialHint("pi-claude-bridge:claude-opus-4-8", { elapsedMs: 30_000, hadCredentials: false });

    expect(isExpiredCredentialResponse(noCredential)).toBe(false);
  });
});

describe("background-run credential failures", () => {
  it("marks only the worker owner's failed provider as needing re-login", () => {
    reportBackgroundRunAuthFailure("workspace-1", "user-1", "pi-claude-bridge:claude-sonnet-4-6");

    expect(credentialNeedsReauth("user-1", "claude-code")).toBe(true);
    expect(credentialNeedsReauth("user-1", "openai-codex")).toBe(false);

    clearCredentialReauth("user-1", "claude-code");
  });
});

describe("spotCheckHistoryPrompt", () => {
  it("summarizes prior runs and instructs workers not to duplicate follow-up tickets", () => {
    const prompt = spotCheckHistoryPrompt([{
      id: "run-1",
      workspaceId: "workspace-1",
      spotCheckId: "check-1",
      spotCheckName: "Sentry",
      taskId: null,
      verdict: "fail",
      summary: "ENG-6277 already filed",
      report: "VERDICT: fail\nSUMMARY: ENG-6277 already filed\nExisting Linear: ENG-6277",
      startedAt: new Date("2026-07-07T10:00:00.000Z"),
      completedAt: new Date("2026-07-07T10:02:00.000Z"),
      createdAt: new Date("2026-07-07T10:02:00.000Z"),
    }]);

    expect(prompt).toContain("Past runs for this exact spot check");
    expect(prompt).toContain("ENG-6277 already filed");
    expect(prompt).toContain("do not call message_brain for that duplicate");
  });

  it("omits history instructions when there are no prior runs", () => {
    expect(spotCheckHistoryPrompt([])).toBeUndefined();
  });
});

describe("spotCheckRunPrompt", () => {
  it("uses sandbox-scoped service credentials and preserves follow-up without Linear", () => {
    const prompt = spotCheckRunPrompt({
      id: "check-1",
      name: "Sentry",
      instructions: "Run the observability CLI",
      repo: "acme/platform",
      enabled: true,
    }, "engineer@example.com");

    expect(prompt).toContain("dotenvx run -f .env.shared -- <command>");
    // Cloud boxes hold the shared bootstrap key and a read-only replica, and
    // nothing else — so the prompt must say repo CLIs do work under that file,
    // and that a development-credential error is not grounds for "blocked".
    expect(prompt).toContain("READ-ONLY production database replica");
    expect(prompt).toContain("never attempt a write");
    expect(prompt).toContain("WRONG_PRIVATE_KEY");
    expect(prompt).toContain("standalone Manta investigation card if Linear issue creation is unavailable or fails");
  });
});

describe("nextSpotCheckRunAt", () => {
  it("returns the next interval in the configured local weekday window", () => {
    const next = nextSpotCheckRunAt({ enabled: true, cadence: "hourly", timeZone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00" }, new Date("2026-07-01T15:05:00.000Z"));

    expect(next.toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });

  it("skips to Monday after the weekday window", () => {
    const next = nextSpotCheckRunAt({ enabled: true, cadence: "hourly", timeZone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00" }, new Date("2026-07-04T01:30:00.000Z"));

    expect(next.toISOString()).toBe("2026-07-06T15:00:00.000Z");
  });

  it("runs daily at the configured local time", () => {
    const next = nextSpotCheckRunAt({ enabled: true, cadence: "daily", timeZone: "America/Los_Angeles", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "09:00", endTime: "18:00" }, new Date("2026-07-01T17:00:00.000Z"));

    expect(next.toISOString()).toBe("2026-07-02T16:00:00.000Z");
  });

  it("runs weekly on the configured local weekday", () => {
    const next = nextSpotCheckRunAt({ enabled: true, cadence: "weekly", timeZone: "America/Los_Angeles", daysOfWeek: [1], startTime: "09:00", endTime: "18:00" }, new Date("2026-07-01T17:00:00.000Z"));

    expect(next.toISOString()).toBe("2026-07-06T16:00:00.000Z");
  });
});
