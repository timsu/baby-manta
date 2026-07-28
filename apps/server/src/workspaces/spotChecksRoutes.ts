import { createHash } from "node:crypto";
import { Hono } from "hono";
import { prisma, spotCheckRuns, workspaces } from "@manta/db";
import type { SpotCheckVerdict } from "@manta/db";
import { runWorkerBackgroundTurn } from "../worker/backgroundRuns.ts";
import { pickBackgroundRunOwner, reportBackgroundRunAuthFailure } from "../models/service.ts";
import type { AuthVars } from "../auth/routes.ts";
import { createLogger } from "../logger.ts";

export interface SpotCheckRoutesDeps {
  brainBackendId: string;
  defaultBrainPrompt: string;
}

type SpotCheckConfig = NonNullable<Awaited<ReturnType<typeof workspaces.getSettings>>["spotChecks"]>[number];
type SpotCheckSchedule = NonNullable<SpotCheckConfig["schedule"]>;

const logger = createLogger("Manta:SpotChecks");
const DEFAULT_SPOT_CHECK_SCHEDULE = {
  enabled: false,
  cadence: "hourly",
  timeZone: "UTC",
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "08:00",
  endTime: "18:00",
} satisfies Required<Pick<SpotCheckSchedule, "enabled" | "cadence" | "timeZone" | "daysOfWeek" | "startTime" | "endTime">>;

interface SpotCheckRunSummary {
  id: string;
  spotCheckId: string;
  spotCheckName: string;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  verdict: SpotCheckVerdict;
  summary: string;
  report: string;
}

function fallbackSpotCheckId(index: number, name: string, instructions: string, repo: string): string {
  const digest = createHash("sha256")
    .update(String(index))
    .update("\0")
    .update(name)
    .update("\0")
    .update(instructions)
    .update("\0")
    .update(repo)
    .digest("hex")
    .slice(0, 12);
  return `sc-${digest}`;
}

function parseLocalTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: weekday < 0 ? date.getUTCDay() : weekday };
}

function assertValidTimeZone(timeZone: string): void {
  try {
    zonedParts(new Date(), timeZone);
  } catch {
    throw new Error("invalid_time_zone");
  }
}

function localDateTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date {
  assertValidTimeZone(timeZone);
  let utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const zoned = zonedParts(new Date(utcMs), timeZone);
    const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0, 0);
    utcMs -= asUtc - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  }
  return new Date(utcMs);
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function normalizeSpotCheckSchedule(input: unknown): SpotCheckSchedule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const item = input as Partial<SpotCheckSchedule>;
  const timeZone = typeof item.timeZone === "string" && item.timeZone.trim() ? item.timeZone.trim().slice(0, 100) : DEFAULT_SPOT_CHECK_SCHEDULE.timeZone;
  try {
    assertValidTimeZone(timeZone);
  } catch {
    return undefined;
  }
  let daysOfWeek = Array.isArray(item.daysOfWeek)
    ? [...new Set(item.daysOfWeek.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
    : DEFAULT_SPOT_CHECK_SCHEDULE.daysOfWeek;
  const startTime = parseLocalTime(item.startTime) ? item.startTime! : DEFAULT_SPOT_CHECK_SCHEDULE.startTime;
  const endTime = parseLocalTime(item.endTime) ? item.endTime! : DEFAULT_SPOT_CHECK_SCHEDULE.endTime;
  const cadence = item.cadence === "hourly" || item.cadence === "daily" || item.cadence === "weekly"
    ? item.cadence
    : Number.isInteger(item.intervalMinutes) && item.intervalMinutes! >= 24 * 60 ? "daily" : DEFAULT_SPOT_CHECK_SCHEDULE.cadence;
  if (!daysOfWeek.length) return undefined;
  if (cadence === "weekly") daysOfWeek = [daysOfWeek[0] ?? 1];
  if (cadence === "hourly" && startTime >= endTime) return undefined;
  return {
    enabled: item.enabled === true,
    cadence,
    timeZone,
    daysOfWeek,
    startTime,
    endTime,
    ...(typeof item.nextRunAt === "string" ? { nextRunAt: item.nextRunAt } : {}),
    ...(typeof item.lastRunAt === "string" ? { lastRunAt: item.lastRunAt } : {}),
    ...(typeof item.lastError === "string" || item.lastError === null ? { lastError: item.lastError } : {}),
  };
}

export function nextSpotCheckRunAt(schedule: SpotCheckSchedule, after = new Date()): Date {
  const cadence = schedule.cadence ?? (schedule.intervalMinutes && schedule.intervalMinutes >= 24 * 60 ? "daily" : DEFAULT_SPOT_CHECK_SCHEDULE.cadence);
  const startTime = schedule.startTime || DEFAULT_SPOT_CHECK_SCHEDULE.startTime;
  const endTime = schedule.endTime || DEFAULT_SPOT_CHECK_SCHEDULE.endTime;
  const start = parseLocalTime(startTime);
  const end = parseLocalTime(endTime);
  if (!start || !end || (cadence === "hourly" && startTime >= endTime)) throw new Error("invalid_time_window");
  const timeZone = schedule.timeZone || DEFAULT_SPOT_CHECK_SCHEDULE.timeZone;
  assertValidTimeZone(timeZone);
  const days = new Set(schedule.daysOfWeek?.length ? schedule.daysOfWeek : DEFAULT_SPOT_CHECK_SCHEDULE.daysOfWeek);
  const afterLocal = zonedParts(after, timeZone);
  const afterMs = after.getTime() + 1;

  for (let offset = 0; offset < 370; offset++) {
    const date = addLocalDays({ year: afterLocal.year, month: afterLocal.month, day: afterLocal.day }, offset);
    const dayStart = localDateTimeToUtc({ ...date, hour: start.hour, minute: start.minute }, timeZone);
    const dayEnd = localDateTimeToUtc({ ...date, hour: end.hour, minute: end.minute }, timeZone);
    const weekday = zonedParts(dayStart, timeZone).weekday;
    if (!days.has(weekday)) continue;
    if (cadence === "hourly" && dayEnd <= after) continue;
    if (cadence !== "hourly") {
      if (dayStart.getTime() >= afterMs) return dayStart;
      continue;
    }
    const elapsed = Math.max(0, afterMs - dayStart.getTime());
    const steps = Math.ceil(elapsed / 3_600_000);
    const candidate = new Date(dayStart.getTime() + steps * 3_600_000);
    if (candidate < dayEnd) return candidate;
  }
  throw new Error("no_valid_schedule_date");
}

export function normalizeSpotChecks(input: unknown): SpotCheckConfig[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<SpotCheckConfig>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
    const instructions = typeof item.instructions === "string" ? item.instructions.trim().slice(0, 8000) : "";
    const repo = typeof item.repo === "string" ? item.repo.trim().slice(0, 200) : "";
    if (!name || !instructions) return [];
    const schedule = normalizeSpotCheckSchedule(item.schedule);
    return [{
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : fallbackSpotCheckId(index, name, instructions, repo),
      name,
      instructions,
      ...(repo ? { repo } : {}),
      enabled: item.enabled !== false,
      ...(schedule ? { schedule } : {}),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
    }];
  }).slice(0, 20);
}

function spotCheckRunView(run: Awaited<ReturnType<typeof spotCheckRuns.listRecent>>[number]): SpotCheckRunSummary {
  const parsed = run.verdict === "unknown" ? parseSpotCheckReport(run.report) : undefined;
  return {
    id: run.id,
    spotCheckId: run.spotCheckId,
    spotCheckName: run.spotCheckName,
    taskId: run.taskId,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    verdict: parsed?.verdict && parsed.verdict !== "unknown" ? parsed.verdict : run.verdict,
    summary: run.summary,
    report: run.report,
  };
}

type SpotCheckRunRecord = Awaited<ReturnType<typeof spotCheckRuns.listRecentForCheck>>[number];

export function spotCheckHistoryPrompt(runs: SpotCheckRunRecord[]): string | undefined {
  const completedRuns = runs.filter((run) => run.completedAt);
  if (!completedRuns.length) return undefined;
  const lines = completedRuns.slice(0, 10).map((run, index) => {
    const report = run.report.trim().replace(/\s+/g, " ").slice(0, 800);
    return [
      `${index + 1}. ${run.completedAt!.toISOString()} — ${run.verdict.toUpperCase()} — ${run.summary}`,
      report ? `   Prior report excerpt: ${report}` : undefined,
    ].filter((part): part is string => Boolean(part)).join("\n");
  });
  return `Past runs for this exact spot check (newest first):\n${lines.join("\n")}\n\nUse this history to avoid duplicate follow-up tickets. If a finding matches a prior reported issue, existing Linear ticket/card, or the same evidence in a prior report, mention it as already reported in your final report and do not call message_brain for that duplicate. Only request follow-up orchestration for genuinely new actionable findings.`;
}

function parseSpotCheckVerdict(raw: string | undefined): SpotCheckVerdict {
  const value = raw?.toLowerCase() ?? "";
  const word = value.match(/\b(pass|warn|warning|fail|green|yellow|red)\b/)?.[1];
  if (word === "pass" || word === "green") return "pass";
  if (word === "warn" || word === "warning" || word === "yellow") return "warn";
  if (word === "fail" || word === "red") return "fail";
  if (/[🟢✅]/u.test(value)) return "pass";
  if (/[🟡⚠️]/u.test(value)) return "warn";
  if (/[🔴❌]/u.test(value)) return "fail";
  return "unknown";
}

/** A check that never reached the thing it was asked to inspect is inconclusive,
 * not clean. Blocked reports routinely also say "no new actionable findings"
 * (true — nothing was looked at), so this must be decided before the pass
 * heuristic or a wall of green hides a check that has not run for days. */
function inferBlockedVerdict(value: string): SpotCheckVerdict | undefined {
  if (/\b(?:could not run|unable to run|returned no response|no response|timed out|expired)\b/.test(value)) return "warn";
  if (/\black(?:s|ed|ing)?\b.{0,80}\bcredentials?\b/.test(value)) return "warn";
  if (/\b(?:could not|cannot|can't|unable to|failed to)\b.{0,40}\b(?:decrypt|authenticate|access|reach|query|review|scan)\b/.test(value)) return "warn";
  if (/\b(?:wrong_private_key|missing_private_key|decryption failure|decryption failed)\b/.test(value)) return "warn";
  if (/\b(?:validation failed|missing required)\b/.test(value)) return "warn";
  if (/\b[a-z_]+_(?:url|token|key|secret)\b.{0,20}\b(?:is |are |was )?(?:not set|missing|unavailable)\b/.test(value)) return "warn";
  if (/\b(?:is |remains |was )?blocked\b/.test(value)) return "warn";
  if (/\b(?:inconclusive|could not be (?:reviewed|verified|completed))\b/.test(value)) return "warn";
  return undefined;
}

function inferSpotCheckVerdict(report: string): SpotCheckVerdict {
  const value = report.toLowerCase().replace(/\s+/g, " ");
  const blocked = inferBlockedVerdict(value);
  if (blocked) return blocked;
  if (/\bno (?:genuinely )?(?:new )?actionable(?: [^.;,]{1,80})? (?:issues|findings)\b/.test(value) || /\b(?:no issues found|all clear)\b/.test(value)) return "pass";
  if (/\b(?:new actionable|actionable (?:issue|issues|finding|findings)|needs? follow-?up|requires? follow-?up)\b/.test(value)) return "fail";
  return "unknown";
}

/** Workers sometimes emit their opening narration and their final report as one
 * unbroken chunk ("I'll scan Sentry…VERDICT: warn"), so the required label is
 * mid-line rather than at the start of one. Prefer a real line start, then fall
 * back to the label wherever it appears. */
function labeledLine(report: string, label: string): string | undefined {
  const body = `(?:\\s*\\*\\*)?\\s*[:：\\-–]\\s*(?:\\*\\*)?\\s*(.+)`;
  const anchored = report.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:\\*\\*)?\\s*${label}${body}$`, "im"));
  if (anchored?.[1]) return anchored[1].trim();
  return report.match(new RegExp(`${label}${body}$`, "im"))?.[1]?.trim();
}

export function parseSpotCheckReport(report: string): Pick<SpotCheckRunSummary, "verdict" | "summary"> {
  const verdictRaw = labeledLine(report, "(?:VERDICT\\s*(?:/|or)\\s*GRADE|GRADE\\s*(?:/|or)\\s*VERDICT|VERDICT|GRADE)");
  const summary = labeledLine(report, "SUMMARY") || report.trim().split("\n").find((line) => line.trim())?.trim() || "Spot check completed";
  const verdict = parseSpotCheckVerdict(verdictRaw);
  if (verdict !== "unknown") return { verdict, summary: summary.slice(0, 280) };
  const inferredVerdict = inferSpotCheckVerdict(`${summary}\n${report}`);
  return { verdict: inferredVerdict, summary: summary.slice(0, 280) };
}

/** True only for the empty-turn notice that actually implicates a credential.
 * The sibling notices (a turn that died during local startup, or one with no
 * credential attached) deliberately do not match — flagging the user's
 * subscription for re-login there sends them to fix something that isn't broken.
 * Kept in sync with `expiredCredentialHint` in @manta/agent. */
export function isExpiredCredentialResponse(report: string): boolean {
  return /^\s*⚠️\s+.+ returned no response\.\s*This is often an expired subscription that could not refresh\b/i.test(report);
}

async function startSpotCheckRun(workspaceId: string, check: SpotCheckConfig, startedAt: string, taskId: string): Promise<SpotCheckRunSummary> {
  const run = await spotCheckRuns.create({ workspaceId }, {
    spotCheckId: check.id,
    spotCheckName: check.name,
    taskId,
    verdict: "unknown",
    summary: "In progress",
    report: "",
    startedAt: new Date(startedAt),
  });
  return spotCheckRunView(run);
}

async function completeSpotCheckRun(workspaceId: string, runId: string, report: string): Promise<SpotCheckRunSummary> {
  const parsed = parseSpotCheckReport(report);
  const run = await spotCheckRuns.complete({ workspaceId }, runId, {
    verdict: parsed.verdict,
    summary: parsed.summary.slice(0, 280),
    report: report.slice(0, 20_000),
  });
  return spotCheckRunView(run);
}

async function failSpotCheckRun(workspaceId: string, runId: string): Promise<SpotCheckRunSummary> {
  const run = await spotCheckRuns.complete({ workspaceId }, runId, {
    verdict: "unknown",
    summary: "Run failed",
    report: "The spot check did not complete. Open the run task for details.",
  });
  return spotCheckRunView(run);
}

export function spotCheckRunPrompt(check: SpotCheckConfig, runnerEmail: string | undefined): string {
  return `Run this workspace spot check now.\n\nSpot check: ${check.name}\nRequested by: ${runnerEmail ?? "a Manta user"}\n\nNatural-language instructions:\n${check.instructions}\n\nUse the worker's repository checkout, environment, and available tools to inspect code, Manta context, GitHub, Linear, and workspace state as needed. If you need Slack scans, Linear scans unavailable from worker tools, or follow-up card creation/assignment, call message_brain with a concise request and continue with the evidence you have.\n\nSERVICE CREDENTIALS:\nCloud workers receive one scoped credential: the bootstrap key for a repo's encrypted \`.env.shared\` file. That file carries the shared service tokens and a READ-ONLY production database replica. Workers do NOT receive development credentials or a development dotenvx key, and no retry will produce them.\n\nRun repo tooling under \`dotenvx run -f .env.shared -- <command>\` so those values are present — repo CLIs (for example a repo's own observability CLI) then work, and read-only database queries are available. You may also call a service's HTTP API directly with the token that file provides. Never print decrypted values, and never attempt a write: the connection is a read-only replica and writes are rejected.\n\nDo not treat missing development-only variables as a blocked check. If a command fails naming a development dotenvx key or WRONG_PRIVATE_KEY, you invoked something that wants credentials this sandbox deliberately lacks — rerun it under \`.env.shared\`, or use the service's HTTP API, before concluding the check cannot run.\n\nFINAL RESPONSE FORMAT — REQUIRED:\nYour final answer MUST begin with exactly these two lines, before any other text:\nVERDICT: <pass|warn|fail>\nSUMMARY: <one short sentence for the past-runs table>\n\nUse VERDICT: pass when the check completed and found no genuinely new actionable issues.\nUse VERDICT: warn when the check could not complete, credentials are missing/expired, or results are inconclusive.\nUse VERDICT: fail when the check found genuinely new actionable issues.\nAfter those two lines, include the markdown report with findings, evidence links, recommended owners, and follow-up actions.\n\nBefore sending your final answer, verify it starts with VERDICT: and SUMMARY:. If it does not, rewrite it into the required format instead of sending the unformatted response.\n\nIf there are actionable issues, request follow-up orchestration with message_brain once per issue or as a concise batch. Include evidence links and whether each follow-up should be a backlog card or autonomous bot card. Ask orchestration to create a standalone Manta investigation card if Linear issue creation is unavailable or fails, so the finding is never dropped. If there are no issues, do not request follow-up cards.`;
}

function spotCheckWorkerPrompt(check: SpotCheckConfig, runnerEmail: string | undefined, ws: Awaited<ReturnType<typeof workspaces.byId>> | null, defaultBrainPrompt: string, historyPrompt?: string): string {
  return [
    ws?.brainPrompt?.trim() || defaultBrainPrompt,
    ws?.teamMemory?.trim() ? `Team memory:\n${ws.teamMemory.trim()}` : undefined,
    historyPrompt,
    spotCheckRunPrompt(check, runnerEmail),
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

async function runSpotCheckOnce(workspaceId: string, check: SpotCheckConfig, runnerEmail: string | undefined, defaultBrainPrompt: string, defaultBackendId: string): Promise<{ text: string; events: Awaited<ReturnType<typeof runWorkerBackgroundTurn>>["events"]; terminalReason?: string; run: SpotCheckRunSummary }> {
  const [ws, settings, history] = await Promise.all([workspaces.byId(workspaceId), workspaces.getSettings(workspaceId), spotCheckRuns.listRecentForCheck({ workspaceId }, check.id, 10)]);
  const { createdBy, backendId } = await pickBackgroundRunOwner(workspaceId, settings.defaultModel || defaultBackendId);
  const startedAt = new Date().toISOString();
  let pendingRun: SpotCheckRunSummary | undefined;
  try {
    const result = await runWorkerBackgroundTurn({
      workspaceId,
      title: `Spot check: ${check.name}`,
      backendId,
      ...(createdBy ? { createdBy } : {}),
      repo: check.repo,
      mode: "spot_check",
      prompt: spotCheckWorkerPrompt(check, runnerEmail, ws, defaultBrainPrompt, spotCheckHistoryPrompt(history)),
      onTaskCreated: async (taskId) => { pendingRun = await startSpotCheckRun(workspaceId, check, startedAt, taskId); },
    });
    if (result.ownerUserId && isExpiredCredentialResponse(result.text)) {
      reportBackgroundRunAuthFailure(workspaceId, result.ownerUserId, backendId);
    }
    if (!pendingRun) throw new Error("spot_check_run_not_recorded");
    const run = await completeSpotCheckRun(workspaceId, pendingRun.id, result.text);
    return { text: result.text, events: result.events, ...(result.terminalReason ? { terminalReason: result.terminalReason } : {}), run };
  } catch (err) {
    if (pendingRun) await failSpotCheckRun(workspaceId, pendingRun.id).catch(() => undefined);
    throw err;
  }
}

async function updateSpotCheckSchedule(workspaceId: string, checkId: string, schedule: SpotCheckSchedule): Promise<void> {
  const settings = await workspaces.getSettings(workspaceId);
  const spotChecks = normalizeSpotChecks(settings.spotChecks).map((item) => item.id === checkId ? { ...item, schedule, updatedAt: new Date().toISOString() } : item);
  await workspaces.updateSettings(workspaceId, { spotChecks });
}

export async function sendDueSpotChecks(deps?: SpotCheckRoutesDeps): Promise<void> {
  if (!deps) return;
  const now = new Date();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.workspace.findMany({
      select: { id: true, settings: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) return;
    cursor = rows.at(-1)?.id;

    for (const row of rows) {
      const settings = (row.settings as Awaited<ReturnType<typeof workspaces.getSettings>> | null) ?? {};
      const checks = normalizeSpotChecks(settings.spotChecks);
      for (const check of checks) {
        if (check.enabled === false || !check.schedule?.enabled) continue;
        let dueAt = check.schedule.nextRunAt ? new Date(check.schedule.nextRunAt) : null;
        if (!dueAt || Number.isNaN(dueAt.getTime())) dueAt = nextSpotCheckRunAt(check.schedule, now);
        if (dueAt > now) continue;
        let nextRunAt: Date;
        try {
          nextRunAt = nextSpotCheckRunAt(check.schedule, now);
        } catch (err) {
          const message = err instanceof Error ? err.message : "invalid_schedule";
          await updateSpotCheckSchedule(row.id, check.id, { ...check.schedule, enabled: false, lastRunAt: now.toISOString(), lastError: message.slice(0, 1000) }).catch(() => undefined);
          logger.warn("spot check schedule disabled after invalid next run", { workspaceId: row.id, checkId: check.id, err });
          continue;
        }

        await updateSpotCheckSchedule(row.id, check.id, { ...check.schedule, nextRunAt: nextRunAt.toISOString(), lastRunAt: now.toISOString(), lastError: null });
        try {
          await runSpotCheckOnce(row.id, check, undefined, deps.defaultBrainPrompt, deps.brainBackendId);
          logger.info("scheduled spot check completed", { workspaceId: row.id, checkId: check.id });
        } catch (err) {
          const message = err instanceof Error ? err.message : "spot_check_failed";
          await updateSpotCheckSchedule(row.id, check.id, { ...check.schedule, nextRunAt: nextRunAt.toISOString(), lastRunAt: now.toISOString(), lastError: message.slice(0, 1000) }).catch(() => undefined);
          logger.warn("scheduled spot check failed", { workspaceId: row.id, checkId: check.id, err });
        }
      }
    }
  }
}

function ssePayload(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSpotCheckRoutes(deps: SpotCheckRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  app.get("/:id/spot-checks", async (c) => {
    const workspaceId = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), workspaceId))) return c.json({ error: "not_a_member" }, 403);
    await spotCheckRuns.failStale({ workspaceId }, new Date(Date.now() - 20 * 60 * 1000));
    const [settings, runs] = await Promise.all([
      workspaces.getSettings(workspaceId),
      spotCheckRuns.listRecent({ workspaceId }, 50),
    ]);
    return c.json({ spotChecks: normalizeSpotChecks(settings.spotChecks), runs: runs.map(spotCheckRunView) });
  });

  app.put("/:id/spot-checks", async (c) => {
    const workspaceId = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { spotChecks?: unknown };
    if (!Array.isArray(body.spotChecks)) return c.json({ error: "spotChecks must be an array" }, 400);
    const now = new Date().toISOString();
    const current = normalizeSpotChecks((await workspaces.getSettings(workspaceId)).spotChecks);
    const byId = new Map(current.map((check) => [check.id, check]));
    const spotChecks = normalizeSpotChecks(body.spotChecks).map((check) => {
      const schedule = check.schedule?.enabled && !check.schedule.nextRunAt
        ? { ...check.schedule, nextRunAt: nextSpotCheckRunAt(check.schedule).toISOString(), lastError: null }
        : check.schedule;
      return {
        ...check,
        ...(schedule ? { schedule } : {}),
        createdAt: byId.get(check.id)?.createdAt ?? check.createdAt ?? now,
        updatedAt: now,
      };
    });
    const updated = await workspaces.updateSettings(workspaceId, { spotChecks });
    return c.json({ spotChecks: normalizeSpotChecks(updated.spotChecks) });
  });

  app.post("/:id/spot-checks/:checkId/run", async (c) => {
    const workspaceId = c.req.param("id");
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const checkId = c.req.param("checkId");
    const settings = await workspaces.getSettings(workspaceId);
    const check = normalizeSpotChecks(settings.spotChecks).find((item) => item.id === checkId);
    if (!check) return c.json({ error: "spot_check_not_found" }, 404);
    if (check.enabled === false) return c.json({ error: "spot_check_disabled" }, 400);

    const result = await runSpotCheckOnce(workspaceId, check, c.get("email"), deps.defaultBrainPrompt, deps.brainBackendId);

    return c.json({
      assistantText: result.text,
      toolsUsed: result.events.filter((e) => e.type === "tool_use").map((e) => (e.type === "tool_use" ? e.toolName : "")),
      terminalReason: result.terminalReason,
      run: result.run,
    });
  });

  app.post("/:id/spot-checks/:checkId/run-stream", async (c) => {
    const workspaceId = c.req.param("id");
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const checkId = c.req.param("checkId");
    const settings = await workspaces.getSettings(workspaceId);
    const check = normalizeSpotChecks(settings.spotChecks).find((item) => item.id === checkId);
    if (!check) return c.json({ error: "spot_check_not_found" }, 404);
    if (check.enabled === false) return c.json({ error: "spot_check_disabled" }, 400);

    const [ws, history] = await Promise.all([workspaces.byId(workspaceId), spotCheckRuns.listRecentForCheck({ workspaceId }, check.id, 10)]);
    const { createdBy, backendId } = await pickBackgroundRunOwner(workspaceId, settings.defaultModel || deps.brainBackendId);
    const startedAt = new Date().toISOString();
    const encoder = new TextEncoder();
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(ssePayload(event, data)));
        let pendingRun: SpotCheckRunSummary | undefined;
        let runCompleted = false;
        try {
          const result = await runWorkerBackgroundTurn({
            workspaceId,
            title: `Spot check: ${check.name}`,
            backendId,
            ...(createdBy ? { createdBy } : {}),
            repo: check.repo,
            mode: "spot_check",
            prompt: spotCheckWorkerPrompt(check, c.get("email"), ws, deps.defaultBrainPrompt, spotCheckHistoryPrompt(history)),
            signal: abort.signal,
            onTaskCreated: async (taskId) => {
              pendingRun = await startSpotCheckRun(workspaceId, check, startedAt, taskId);
              send("started", { run: pendingRun });
            },
          });
          if (result.ownerUserId && isExpiredCredentialResponse(result.text)) {
            reportBackgroundRunAuthFailure(workspaceId, result.ownerUserId, backendId);
          }
          if (!pendingRun) throw new Error("spot_check_run_not_recorded");
          const run = await completeSpotCheckRun(workspaceId, pendingRun.id, result.text);
          runCompleted = true;
          send("complete", {
            assistantText: result.text,
            toolsUsed: result.events.filter((e) => e.type === "tool_use").map((e) => (e.type === "tool_use" ? e.toolName : "")),
            terminalReason: result.terminalReason,
            run,
          });
        } catch (err) {
          const failedRun = pendingRun && !runCompleted
            ? await failSpotCheckRun(workspaceId, pendingRun.id).catch(() => undefined)
            : undefined;
          if (!abort.signal.aborted) send("error", { message: err instanceof Error ? err.message : String(err), ...(failedRun ? { run: failedRun } : {}) });
        } finally {
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
