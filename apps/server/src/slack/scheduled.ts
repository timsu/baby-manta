import { WebClient } from "@slack/web-api";
import { messages, prisma, slack, workspaces } from "@manta/db";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import type { AgentEvent } from "@manta/shared";
import { decrypt } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";
import { brainBackendIdFor } from "../models/service.ts";
import { runWorkerBackgroundTurn } from "../worker/backgroundRuns.ts";
import { getUsHolidayDates } from "./holidays.ts";

const logger = createLogger("Manta:SlackSchedules");

export type ScheduleCadence = "daily" | "weekly";

const SCHEDULE_TOOL_NAMES = new Set([
  "list_tasks",
  "get_task",
  "check_worker",
  "list_linear_teams",
  "list_linear_members",
  "get_linear_issue",
  "list_linear_issues",
  "find_duplicate_linear_issue",
  "answer_question",
]);

const MESSAGE_PROMPT =
  "You write scheduled Slack messages for a workspace. Generate exactly the message that should be posted. " +
  "You may use the available read-only tools to inspect Manta state, Linear state, or ask a read-only repo question before writing. " +
  "For any repo/code/git history investigation, call answer_question immediately; do not try to inspect repositories from the brain, and do not use web search for private repositories. " +
  "Do not create or update cards/issues, do not explain your reasoning, do not mention that this is scheduled, and do not wrap the answer in quotes unless the user explicitly asks for that. " +
  "When ready, write the exact Slack message inside <final_slack_message>...</final_slack_message> tags. Do not put acknowledgements, reasoning, or progress updates inside the tags.";

const FINAL_SLACK_MESSAGE_RE = /<final_slack_message>([\s\S]*?)<\/final_slack_message>/gi;

export function extractScheduledSlackFinalText(text: string): string {
  const matches = [...text.matchAll(FINAL_SLACK_MESSAGE_RE)];
  const tagged = matches.at(-1)?.[1];
  return (tagged ?? text).trim();
}

export function completedScheduledSlackPreviewText(
  task: { createdBy: string | null; backgroundMode: string | null; hidden: boolean; cardStatus: string } | null,
  rows: Array<{ role: string; content: string; meta?: unknown }>,
  userId: string,
): string | null {
  if (!task
    || task.createdBy !== userId
    || task.backgroundMode !== "scheduled_slack"
    || task.hidden
    || task.cardStatus !== "done") return null;
  const previewResult = rows.find((message) => message.role === "system"
    && typeof message.meta === "object"
    && message.meta !== null
    && (message.meta as { kind?: unknown }).kind === "scheduled_slack_preview_result");
  return previewResult?.content.trim() || null;
}

export function scheduledSlackTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => SCHEDULE_TOOL_NAMES.has(tool.name));
}

export function parseTimeOfDayUtc(value: string): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zonedParts(date: Date, timeZone: string): LocalParts {
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
  const weekdayName = get("weekday");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekday < 0 ? date.getUTCDay() : weekday,
  };
}

function assertValidTimeZone(timeZone: string): void {
  try {
    zonedParts(new Date(), timeZone);
  } catch {
    throw new Error("invalid_time_zone");
  }
}

function localDateTimeToUtc(parts: Omit<LocalParts, "weekday">, timeZone: string): Date {
  assertValidTimeZone(timeZone);
  let utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const zoned = zonedParts(new Date(utcMs), timeZone);
    const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0, 0);
    utcMs -= asUtc - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  }
  return new Date(utcMs);
}

function addLocalDays(parts: Omit<LocalParts, "weekday" | "hour" | "minute">, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function localDateKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isSkippedLocalDate(date: Date, timeZone: string, holidays: ReadonlySet<string>): boolean {
  const parts = zonedParts(date, timeZone);
  return parts.weekday === 0 || parts.weekday === 6 || holidays.has(localDateKey(parts));
}

export function nextScheduleRunAt(input: {
  cadence: ScheduleCadence;
  timeOfDayUtc: string;
  dayOfWeekUtc?: number | null;
  daysOfWeek?: number[] | null;
  timeZone?: string | null;
  includeWeekendsAndHolidays?: boolean;
  holidays?: ReadonlySet<string>;
  after?: Date;
}): Date {
  const parsed = parseTimeOfDayUtc(input.timeOfDayUtc);
  if (!parsed) throw new Error("invalid_time_of_day");
  const timeZone = input.timeZone || "UTC";
  assertValidTimeZone(timeZone);
  const after = input.after ?? new Date();
  const holidays = input.holidays ?? getUsHolidayDates();
  const afterLocal = zonedParts(after, timeZone);
  let date = { year: afterLocal.year, month: afterLocal.month, day: afterLocal.day };
  let weeklyDays: ReadonlySet<number> | null = null;

  if (input.cadence === "weekly") {
    const days = input.daysOfWeek?.length ? input.daysOfWeek : input.dayOfWeekUtc === null || input.dayOfWeekUtc === undefined ? [] : [input.dayOfWeekUtc];
    if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error("invalid_days_of_week");
    }
    weeklyDays = new Set(days);
  }

  for (let attempts = 0; attempts < 370; attempts++) {
    const candidate = localDateTimeToUtc({ ...date, hour: parsed.hour, minute: parsed.minute }, timeZone);
    const candidateLocal = zonedParts(candidate, timeZone);
    const wrongLocalTime = candidateLocal.year !== date.year
      || candidateLocal.month !== date.month
      || candidateLocal.day !== date.day
      || candidateLocal.hour !== parsed.hour
      || candidateLocal.minute !== parsed.minute;
    const wrongWeeklyDay = weeklyDays !== null && !weeklyDays.has(candidateLocal.weekday);
    const tooSoon = candidate <= after;
    const skipped = !input.includeWeekendsAndHolidays && isSkippedLocalDate(candidate, timeZone, holidays);
    if (!wrongLocalTime && !wrongWeeklyDay && !tooSoon && !skipped) return candidate;
    date = addLocalDays(date, 1);
  }
  throw new Error("no_valid_schedule_date");
}

export interface ScheduledSlackDeps {
  backend: AgentBackend;
  backendId: string;
  defaultBrainPrompt: string;
  tools: ToolDefinition[];
}

export interface GenerateScheduledSlackMessageInput extends ScheduledSlackDeps {
  workspaceId: string;
  scheduleId?: string;
  createdBy?: string;
  repo?: string | null;
  prompt: string;
  preview?: boolean;
  onTaskCreated?: (taskId: string) => void;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export async function generateScheduledSlackMessage(input: GenerateScheduledSlackMessageInput): Promise<{
  text: string;
  events: AgentEvent[];
  taskId: string;
  terminalReason?: string;
}> {
  const ws = await workspaces.byId(input.workspaceId);
  const backendId = await brainBackendIdFor(input.workspaceId, input.backendId);
  const result = await runWorkerBackgroundTurn({
    workspaceId: input.workspaceId,
    name: input.preview ? "scheduled-slack-preview" : "scheduled-slack-message",
    title: input.preview ? "Scheduled Slack message preview" : "Scheduled Slack message",
    backendId,
    repo: input.repo,
    mode: "scheduled_slack",
    ...(input.preview ? { visible: true } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.onTaskCreated ? { onTaskCreated: input.onTaskCreated } : {}),
    prompt: [
      ws?.brainPrompt?.trim() || input.defaultBrainPrompt,
      ws?.teamMemory?.trim() ? `Team memory:\n${ws.teamMemory.trim()}` : undefined,
      MESSAGE_PROMPT,
      "Return the exact Slack message text to post inside <final_slack_message>...</final_slack_message> tags.",
      "Scheduled Slack prompt:",
      input.prompt,
    ].filter((part): part is string => Boolean(part)).join("\n\n"),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const text = extractScheduledSlackFinalText(result.text);
  if (input.preview && text) {
    await messages.append({ workspaceId: input.workspaceId }, {
      channel: result.taskId,
      role: "system",
      content: text,
      meta: { kind: "scheduled_slack_preview_result" },
    });
  }
  return {
    text,
    events: result.events,
    taskId: result.taskId,
    ...(result.terminalReason ? { terminalReason: result.terminalReason } : {}),
  };
}

export async function sendDueScheduledSlackMessages(deps?: ScheduledSlackDeps): Promise<void> {
  if (!deps) return;
  const now = new Date();
  const due = await prisma.slackMessageSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 25,
  });
  if (!due.length) return;

  for (const schedule of due) {
    // Read straight off the Prisma row here, so decode the JSON-backed list
    // column the same way the db layer's helpers do.
    const daysOfWeek = Array.isArray(schedule.daysOfWeek)
      ? schedule.daysOfWeek.filter((day): day is number => typeof day === "number")
      : [];
    let nextRunAt: Date;
    try {
      nextRunAt = nextScheduleRunAt({
        cadence: schedule.cadence,
        timeOfDayUtc: schedule.timeOfDayUtc,
        dayOfWeekUtc: schedule.dayOfWeekUtc,
        daysOfWeek,
        timeZone: schedule.timeZone,
        includeWeekendsAndHolidays: schedule.includeWeekendsAndHolidays,
        after: now,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_schedule";
      await prisma.slackMessageSchedule.updateMany({
        where: {
          id: schedule.id,
          enabled: true,
          nextRunAt: schedule.nextRunAt,
          cadence: schedule.cadence,
          timeOfDayUtc: schedule.timeOfDayUtc,
          dayOfWeekUtc: schedule.dayOfWeekUtc,
          daysOfWeek: { equals: schedule.daysOfWeek ?? undefined },
          timeZone: schedule.timeZone,
          includeWeekendsAndHolidays: schedule.includeWeekendsAndHolidays,
        },
        data: { enabled: false, lastRunAt: now, lastError: message.slice(0, 1000) },
      }).catch(() => undefined);
      logger.warn("scheduled slack message disabled after invalid next run", { scheduleId: schedule.id, workspaceId: schedule.workspaceId, err });
      continue;
    }

    const claimed = await prisma.slackMessageSchedule.updateMany({
      where: { id: schedule.id, enabled: true, nextRunAt: { lte: now } },
      data: { nextRunAt, lastRunAt: now, lastError: null },
    });
    if (claimed.count === 0) continue;

    try {
      const bot = await slack.getBot(schedule.workspaceId, schedule.slackBotId);
      if (!bot?.enabled) throw new Error("slack_bot_unavailable");
      const { text } = await generateScheduledSlackMessage({
        ...deps,
        workspaceId: schedule.workspaceId,
        scheduleId: schedule.id,
        repo: schedule.repo,
        prompt: schedule.prompt,
      });
      if (!text) throw new Error("empty_ai_message");
      const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
      await client.chat.postMessage({ channel: schedule.channelId, text });
      logger.info("scheduled slack message sent", { scheduleId: schedule.id, workspaceId: schedule.workspaceId, channelId: schedule.channelId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "scheduled_message_failed";
      await prisma.slackMessageSchedule.update({ where: { id: schedule.id }, data: { lastError: message.slice(0, 1000) } }).catch(() => undefined);
      logger.warn("scheduled slack message failed", { scheduleId: schedule.id, workspaceId: schedule.workspaceId, err });
    }
  }
}
