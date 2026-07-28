import { describe, expect, it } from "vitest";
import { completedScheduledSlackPreviewText, extractScheduledSlackFinalText, nextScheduleRunAt, parseTimeOfDayUtc, scheduledSlackTools } from "./scheduled.ts";

describe("scheduled Slack messages", () => {
  it("parses valid local times only", () => {
    expect(parseTimeOfDayUtc("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDayUtc("24:00")).toBeNull();
    expect(parseTimeOfDayUtc("9:00")).toBeNull();
  });

  it("schedules daily runs in the requested timezone", () => {
    expect(nextScheduleRunAt({ cadence: "daily", timeOfDayUtc: "10:00", timeZone: "America/Los_Angeles", after: new Date("2026-06-22T16:00:00.000Z") }).toISOString())
      .toBe("2026-06-22T17:00:00.000Z");
    expect(nextScheduleRunAt({ cadence: "daily", timeOfDayUtc: "10:00", timeZone: "America/Los_Angeles", after: new Date("2026-06-22T17:00:00.000Z") }).toISOString())
      .toBe("2026-06-23T17:00:00.000Z");
  });

  it("skips weekends and US holidays unless explicitly included", () => {
    const holidays = new Set(["2026-07-03"]);
    expect(nextScheduleRunAt({ cadence: "daily", timeOfDayUtc: "09:00", timeZone: "America/New_York", holidays, after: new Date("2026-07-02T14:00:00.000Z") }).toISOString())
      .toBe("2026-07-06T13:00:00.000Z");
    expect(nextScheduleRunAt({ cadence: "daily", timeOfDayUtc: "09:00", timeZone: "America/New_York", holidays, includeWeekendsAndHolidays: true, after: new Date("2026-07-02T14:00:00.000Z") }).toISOString())
      .toBe("2026-07-03T13:00:00.000Z");
  });

  it("does not run at the wrong local time during DST gaps", () => {
    expect(nextScheduleRunAt({
      cadence: "daily",
      timeOfDayUtc: "02:30",
      timeZone: "America/New_York",
      includeWeekendsAndHolidays: true,
      after: new Date("2026-03-07T08:00:00.000Z"),
    }).toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("schedules weekly runs on the selected local weekday", () => {
    expect(nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", timeZone: "America/New_York", daysOfWeek: [1], after: new Date("2026-06-22T12:00:00.000Z") }).toISOString())
      .toBe("2026-06-22T13:00:00.000Z");
    expect(nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", timeZone: "America/New_York", daysOfWeek: [1], after: new Date("2026-06-22T13:00:00.000Z") }).toISOString())
      .toBe("2026-06-29T13:00:00.000Z");
    expect(() => nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", daysOfWeek: [7] })).toThrow("invalid_days_of_week");
    expect(nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", timeZone: "America/New_York", dayOfWeekUtc: 1, daysOfWeek: [], after: new Date("2026-06-22T12:00:00.000Z") }).toISOString())
      .toBe("2026-06-22T13:00:00.000Z");
  });

  it("schedules weekly runs on the next of multiple selected weekdays", () => {
    expect(nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", timeZone: "America/New_York", daysOfWeek: [2, 3, 4], after: new Date("2026-06-23T14:00:00.000Z") }).toISOString())
      .toBe("2026-06-24T13:00:00.000Z");
    expect(nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", timeZone: "America/New_York", daysOfWeek: [2, 3, 4], after: new Date("2026-06-25T14:00:00.000Z") }).toISOString())
      .toBe("2026-06-30T13:00:00.000Z");
    expect(() => nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", daysOfWeek: [] })).toThrow("invalid_days_of_week");
    expect(() => nextScheduleRunAt({ cadence: "weekly", timeOfDayUtc: "09:00", daysOfWeek: [0, 6] })).toThrow("no_valid_schedule_date");
  });

  it("allows only read-oriented tools for scheduled prompts", () => {
    const tools = ["create_task", "answer_question", "list_tasks", "append_team_memory"].map((name) => ({ name }) as never);
    expect(scheduledSlackTools(tools).map((tool) => tool.name)).toEqual(["answer_question", "list_tasks"]);
  });

  it("posts only the tagged final scheduled Slack message", () => {
    expect(extractScheduledSlackFinalText([
      "I’ll check the current state and draft the alert.",
      "<final_slack_message>",
      "Today's summary:\n- One task shipped",
      "</final_slack_message>",
    ].join("\n"))).toBe("Today's summary:\n- One task shipped");
  });

  it("uses the last tagged final message when earlier text is present", () => {
    expect(extractScheduledSlackFinalText([
      "<final_slack_message>draft</final_slack_message>",
      "After checking one more source:",
      "<final_slack_message>final alert</final_slack_message>",
    ].join("\n"))).toBe("final alert");
  });

  it("resolves the exact final text only from the member's completed visible preview", () => {
    const task = { createdBy: "user-1", backgroundMode: "scheduled_slack", hidden: false, cardStatus: "done" };
    const rows = [
      { role: "assistant", content: "<final_slack_message>earlier</final_slack_message>" },
      { role: "system", content: "Post this exact message", meta: { kind: "scheduled_slack_preview_result" } },
      { role: "assistant", content: "A later follow-up must not replace the preview" },
    ];

    expect(completedScheduledSlackPreviewText(task, rows, "user-1")).toBe("Post this exact message");
    expect(completedScheduledSlackPreviewText(task, rows, "user-2")).toBeNull();
    expect(completedScheduledSlackPreviewText({ ...task, hidden: true }, rows, "user-1")).toBeNull();
    expect(completedScheduledSlackPreviewText({ ...task, cardStatus: "canceled" }, rows, "user-1")).toBeNull();
    expect(completedScheduledSlackPreviewText({ ...task, backgroundMode: "readonly" }, rows, "user-1")).toBeNull();
  });
});
