import { describe, expect, it } from "vitest";
import { getUsHolidayDates, loadUsHolidays } from "./holidays.ts";

describe("US holiday loading", () => {
  it("uses built-in fallback holidays when remote loading fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 503 }))) as typeof fetch;
    try {
      const dates = await loadUsHolidays([2026]);
      expect(dates.has("2026-01-01")).toBe(true);
      expect(dates.has("2026-07-03")).toBe(true);
      expect(getUsHolidayDates().has("2026-12-25")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
