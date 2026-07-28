import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:USHolidays");
const NAGER_DATE_BASE = "https://date.nager.at/api/v3/PublicHolidays";

let usHolidayDates = fallbackUsHolidayDates(yearsToLoad(new Date()));

export function getUsHolidayDates(): ReadonlySet<string> {
  return usHolidayDates;
}

export function setUsHolidayDatesForTest(dates: Iterable<string>): void {
  usHolidayDates = new Set(dates);
}

export async function loadUsHolidays(years = yearsToLoad(new Date())): Promise<ReadonlySet<string>> {
  const fallback = fallbackUsHolidayDates(years);
  const dates = new Set<string>(fallback);
  let fetchedAny = false;
  for (const year of years) {
    try {
      const res = await fetch(`${NAGER_DATE_BASE}/${year}/US`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`holiday fetch failed: ${res.status}`);
      const body = await res.json().catch(() => []) as Array<{ date?: unknown }>;
      for (const holiday of body) {
        if (typeof holiday.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(holiday.date)) dates.add(holiday.date);
      }
      fetchedAny = true;
    } catch (err) {
      logger.warn("US holiday fetch failed; using built-in fallback dates", { year, err });
    }
  }
  usHolidayDates = dates;
  logger.info("US holidays loaded", { count: usHolidayDates.size, years, source: fetchedAny ? "remote+fallback" : "fallback" });
  return usHolidayDates;
}

function yearsToLoad(now: Date): number[] {
  const year = now.getUTCFullYear();
  return [year, year + 1];
}

function fallbackUsHolidayDates(years: number[]): Set<string> {
  const dates = new Set<string>();
  for (const year of years) {
    addObserved(dates, year, 1, 1); // New Year's Day
    addNthWeekday(dates, year, 1, 1, 3); // Martin Luther King Jr. Day
    addNthWeekday(dates, year, 2, 1, 3); // Washington's Birthday / Presidents Day
    addLastWeekday(dates, year, 5, 1); // Memorial Day
    addObserved(dates, year, 6, 19); // Juneteenth
    addObserved(dates, year, 7, 4); // Independence Day
    addNthWeekday(dates, year, 9, 1, 1); // Labor Day
    addNthWeekday(dates, year, 10, 1, 2); // Columbus Day / Indigenous Peoples' Day
    addObserved(dates, year, 11, 11); // Veterans Day
    addNthWeekday(dates, year, 11, 4, 4); // Thanksgiving
    addObserved(dates, year, 12, 25); // Christmas Day
  }
  return dates;
}

function addObserved(out: Set<string>, year: number, month: number, day: number): void {
  const actual = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = actual.getUTCDay();
  const observed = new Date(actual);
  if (weekday === 0) observed.setUTCDate(observed.getUTCDate() + 1);
  else if (weekday === 6) observed.setUTCDate(observed.getUTCDate() - 1);
  out.add(dateKey(observed));
}

function addNthWeekday(out: Set<string>, year: number, month: number, weekday: number, nth: number): void {
  const date = new Date(Date.UTC(year, month - 1, 1, 12));
  const delta = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + delta + (nth - 1) * 7);
  out.add(dateKey(date));
}

function addLastWeekday(out: Set<string>, year: number, month: number, weekday: number): void {
  const date = new Date(Date.UTC(year, month, 0, 12));
  const delta = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
  out.add(dateKey(date));
}

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
