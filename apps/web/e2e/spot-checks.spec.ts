import { expect, test } from "@playwright/test";
import { installMockApi } from "./mockApi.ts";

// The runs list is one flat newest-first stream across every check, so an
// hourly check buries a weekly one. These cover the two places that answer
// "how did *this* check last do?" without scrolling: the topbar badge and the
// per-check chip.
const CHECKS = [
  { id: "sc-hourly", name: "Sentry New Issues", instructions: "Check Sentry", repo: "acme/app", enabled: true, schedule: { enabled: true, cadence: "hourly", timeZone: "UTC", daysOfWeek: [1, 2, 3, 4, 5], startTime: "07:00", endTime: "17:00" } },
  { id: "sc-weekly", name: "Review old issues", instructions: "Review aging issues", repo: "acme/app", enabled: true, schedule: { enabled: true, cadence: "weekly", timeZone: "UTC", daysOfWeek: [1], startTime: "08:00", endTime: "09:00" } },
];

function run(spotCheckId: string, spotCheckName: string, verdict: string, completedAt: string, summary: string) {
  return { id: `${spotCheckId}-${completedAt}`, spotCheckId, spotCheckName, taskId: null, startedAt: completedAt, completedAt, verdict, summary, report: `VERDICT: ${verdict}\nSUMMARY: ${summary}` };
}

// Newest first, hourly runs dominating — the weekly red is last in the list.
const RUNS = [
  run("sc-hourly", "Sentry New Issues", "pass", "2026-07-24T23:03:00.000Z", "No genuinely new high-frequency Sentry issues found."),
  run("sc-hourly", "Sentry New Issues", "pass", "2026-07-24T22:03:00.000Z", "No genuinely new high-frequency Sentry issues found."),
  run("sc-weekly", "Review old issues", "fail", "2026-07-24T11:19:00.000Z", "Six aging issues; runtime evidence unavailable for five."),
];

test("surfaces each check's latest grade in the panel and the topbar", async ({ page }) => {
  await installMockApi(page, { spotChecks: CHECKS, spotCheckRuns: RUNS });
  await page.goto("/");

  const toggle = page.getByRole("button", { name: /Spot checks/ });
  // Red wins over green across checks: the weekly failure must not be hidden
  // by the hourly check passing.
  await expect(toggle).toHaveClass(/alert-fail/);

  await toggle.click();
  const hourly = page.locator(".spotcheck-item", { hasText: "Sentry New Issues" });
  const weekly = page.locator(".spotcheck-item", { hasText: "Review old issues" });

  await expect(hourly.locator(".spotcheck-latest .spotcheck-verdict")).toHaveText("Green");
  await expect(weekly.locator(".spotcheck-latest .spotcheck-verdict")).toHaveText("Red");
});

test("shows no grade chip for a check that has never run", async ({ page }) => {
  await installMockApi(page, { spotChecks: CHECKS, spotCheckRuns: RUNS.filter((r) => r.spotCheckId === "sc-hourly") });
  await page.goto("/");

  await page.getByRole("button", { name: /Spot checks/ }).click();

  await expect(page.locator(".spotcheck-item", { hasText: "Review old issues" }).locator(".spotcheck-latest")).toHaveCount(0);
});

test("adds a started run to the table and links to its task", async ({ page }) => {
  await installMockApi(page, { spotChecks: CHECKS, spotCheckRuns: [] });
  const startedRun = {
    id: "run-live",
    spotCheckId: "sc-hourly",
    spotCheckName: "Sentry New Issues",
    taskId: "task-live",
    startedAt: "2026-07-25T06:00:00.000Z",
    completedAt: null,
    verdict: "unknown",
    summary: "In progress",
    report: "",
  };
  await page.route("**/api/workspaces/ws-1/spot-checks/sc-hourly/run-stream", (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: started\ndata: ${JSON.stringify({ run: startedRun })}\n\n`,
  }));
  await page.route("**/api/workspaces/ws-1/tasks/task-live", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "task-live", title: "Spot check: Sentry New Issues", description: "Live run", cardType: "bot", cardStatus: "bot_working", hidden: true, backgroundMode: "spot_check", checklist: [], terminalTabs: null, planDocument: null }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Spot checks/ }).click();

  await page.locator(".spotcheck-item", { hasText: "Sentry New Issues" }).getByRole("button", { name: "Run" }).click();

  const row = page.locator(".spotcheck-runs-table tbody tr", { hasText: "Sentry New Issues" });
  await expect(row).toContainText("Running");
  await row.getByRole("button", { name: "Open run" }).click();
  await expect(page.getByText("Spot check: Sentry New Issues", { exact: true })).toBeVisible();
  await expect(page.getByText("This spot-check run is read-only.")).toBeVisible();
});

test("replaces the running row when a run fails", async ({ page }) => {
  await installMockApi(page, { spotChecks: CHECKS, spotCheckRuns: [] });
  const pending = {
    id: "run-failed",
    spotCheckId: "sc-hourly",
    spotCheckName: "Sentry New Issues",
    taskId: "task-failed",
    startedAt: "2026-07-25T06:00:00.000Z",
    completedAt: null,
    verdict: "unknown",
    summary: "In progress",
    report: "",
  };
  const failed = { ...pending, completedAt: "2026-07-25T06:01:00.000Z", summary: "Run failed" };
  await page.route("**/api/workspaces/ws-1/spot-checks/sc-hourly/run-stream", (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: [
      `event: started\ndata: ${JSON.stringify({ run: pending })}`,
      `event: error\ndata: ${JSON.stringify({ message: "worker unavailable", run: failed })}`,
      "",
    ].join("\n\n"),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Spot checks/ }).click();

  await page.locator(".spotcheck-item", { hasText: "Sentry New Issues" }).getByRole("button", { name: "Run" }).click();

  const row = page.locator(".spotcheck-runs-table tbody tr", { hasText: "Sentry New Issues" });
  await expect(row).toContainText("Run failed");
  await expect(row).not.toContainText("Running");
});
