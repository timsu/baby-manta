import type { SpotCheckConfig, SpotCheckRunSummary } from "../api.ts";

export interface SpotCheckAlert {
  /** Worst grade among the latest runs — red wins over yellow. */
  verdict: "warn" | "fail";
  /** Names of the checks whose latest run is not green, worst first. */
  names: string[];
}

/** Each check's most recent run, keyed by spot check id. The runs list is a flat
 * newest-first stream across every check, so an hourly check buries a weekly
 * one — this is what lets both the board badge and the panel answer "how did
 * *this* check last do?" without scrolling. */
export function latestRunByCheck(runs: SpotCheckRunSummary[] | undefined): Map<string, SpotCheckRunSummary> {
  const latest = new Map<string, SpotCheckRunSummary>();
  for (const run of runs ?? []) {
    if (!run.completedAt) continue;
    const seen = latest.get(run.spotCheckId);
    if (!seen || run.completedAt > seen.completedAt!) latest.set(run.spotCheckId, run);
  }
  return latest;
}

/** Surface a not-green result on the board without making the user open the
 * panel. Only each check's *latest* run counts: an old failure that has since
 * gone green is history, not a live problem. An unparseable verdict is treated
 * as yellow — "we could not tell" is not the same as "clean". */
export function latestSpotCheckAlert(
  checks: SpotCheckConfig[],
  runs: SpotCheckRunSummary[] | undefined,
): SpotCheckAlert | null {
  if (!runs?.length) return null;
  const configured = new Set(checks.filter((check) => check.enabled !== false).map((check) => check.id));
  const latest = latestRunByCheck(runs);
  const notGreen = [...latest.entries()]
    .filter(([id]) => configured.has(id))
    .map(([, run]) => run)
    .filter((run) => run.verdict !== "pass");
  if (!notGreen.length) return null;
  notGreen.sort((a, b) => Number(b.verdict === "fail") - Number(a.verdict === "fail"));
  return {
    verdict: notGreen.some((run) => run.verdict === "fail") ? "fail" : "warn",
    names: notGreen.map((run) => run.spotCheckName),
  };
}
