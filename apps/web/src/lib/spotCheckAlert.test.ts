import { describe, expect, it } from "vitest";
import type { SpotCheckConfig, SpotCheckRunSummary } from "../api.ts";
import { latestRunByCheck, latestSpotCheckAlert } from "./spotCheckAlert.ts";

function check(id: string, overrides: Partial<SpotCheckConfig> = {}): SpotCheckConfig {
  return { id, name: id, instructions: "look", enabled: true, createdAt: "", updatedAt: "", ...overrides };
}

function run(spotCheckId: string, verdict: SpotCheckRunSummary["verdict"], completedAt: string | null): SpotCheckRunSummary {
  const timestamp = completedAt ?? "2026-07-25T06:00:00Z";
  return { id: `${spotCheckId}-${timestamp}`, spotCheckId, spotCheckName: spotCheckId, taskId: null, startedAt: timestamp, completedAt, verdict, summary: "", report: "" };
}

describe("latestRunByCheck", () => {
  it("keeps the newest run per check regardless of list order", () => {
    // A weekly check's run sits far down a list dominated by an hourly one.
    const runs = [
      run("hourly", "pass", "2026-07-24T20:00:00Z"),
      run("hourly", "fail", "2026-07-24T19:00:00Z"),
      run("weekly", "fail", "2026-07-24T04:19:00Z"),
    ];

    const latest = latestRunByCheck(runs);

    expect(latest.get("hourly")?.completedAt).toBe("2026-07-24T20:00:00Z");
    expect(latest.get("weekly")?.verdict).toBe("fail");
    expect(latestRunByCheck(undefined).size).toBe(0);
  });

  it("keeps an in-progress run from replacing the latest grade", () => {
    const latest = latestRunByCheck([
      run("hourly", "unknown", null),
      run("hourly", "pass", "2026-07-24T20:00:00Z"),
    ]);

    expect(latest.get("hourly")?.verdict).toBe("pass");
  });
});

describe("latestSpotCheckAlert", () => {
  it("stays quiet when every check's latest run is green", () => {
    const runs = [run("a", "pass", "2026-07-24T20:00:00Z"), run("a", "fail", "2026-07-23T20:00:00Z")];

    expect(latestSpotCheckAlert([check("a")], runs)).toBeNull();
  });

  it("flags the latest not-green run and prefers red over yellow", () => {
    const runs = [
      run("a", "warn", "2026-07-24T20:00:00Z"),
      run("b", "fail", "2026-07-24T19:00:00Z"),
      run("b", "pass", "2026-07-24T18:00:00Z"),
    ];

    expect(latestSpotCheckAlert([check("a"), check("b")], runs)).toEqual({ verdict: "fail", names: ["b", "a"] });
  });

  it("treats an unparseable verdict as not green", () => {
    expect(latestSpotCheckAlert([check("a")], [run("a", "unknown", "2026-07-24T20:00:00Z")])?.verdict).toBe("warn");
  });

  it("ignores runs from checks that are gone or disabled", () => {
    const runs = [run("a", "fail", "2026-07-24T20:00:00Z"), run("gone", "fail", "2026-07-24T20:00:00Z")];

    expect(latestSpotCheckAlert([check("a", { enabled: false }), check("b")], runs)).toBeNull();
  });
});
