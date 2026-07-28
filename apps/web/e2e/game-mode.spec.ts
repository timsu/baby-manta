// Dog-mode e2e. Hermetic: all /api traffic is mocked (see mockApi.ts).
// `?game=1` forces the mode on; `&gameassets=0` skips optional model assets so
// tests exercise the placeholder dog deterministically.

import { expect, test } from "@playwright/test";
import { gameState, installMockApi, walkDogTo } from "./mockApi.ts";
import { RICH_MEMBERS, RICH_PRS } from "./fixtures.ts";

const GAME_URL = "/?game=1&gameassets=0";

test.beforeEach(async ({ page }) => {
  await installMockApi(page);
});

test("regular manta board renders when game mode is off", async ({ page }) => {
  await page.goto("/?game=0");
  await expect(page.getByRole("button", { name: "+ New card" })).toBeVisible();
  await expect(page.getByText("Fix login bug")).toBeVisible();
  await expect(page.getByTestId("game-canvas")).toHaveCount(0);
});

test("?game=1 boots the 3D world with HUD and canvas", async ({ page }) => {
  await page.goto(GAME_URL);
  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator("canvas").first()).toBeVisible(); // renderer (the minimap adds a second canvas)
  await expect(canvas.locator(".game-minimap")).toBeVisible();
  await expect(page.getByText("DOG MODE")).toBeVisible();
  // The 2D board is replaced, the rest of the shell stays.
  await expect(page.getByText("Fix login bug")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New card" })).toBeVisible();
});

test("WASD moves the dog", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  const before = await gameState(page);
  // Thresholds are small because the headless software renderer runs the
  // world at a few fps — direction is what's under test, not speed.
  await page.keyboard.down("w");
  await page.waitForTimeout(1200);
  await page.keyboard.up("w");
  const after = await gameState(page);
  expect(after.dog.z).toBeLessThan(before.dog.z - 0.2); // W runs toward -z
  await page.keyboard.down("d");
  await page.waitForTimeout(1200);
  await page.keyboard.up("d");
  const strafed = await gameState(page);
  expect(strafed.dog.x).toBeGreaterThan(after.dog.x + 0.2);
});

test("the world holds the work; the global wheel holds every operation", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => (window.__mantaGame?.getState().interactables.length ?? 0) > 0);
  const state = await gameState(page);
  const ids = state.interactables.map((i) => i.id);
  expect(ids).toEqual(expect.arrayContaining(["card:task-login", "card:task-docs"]));
  // No buildings cluttering the world — operations live in the wheel.
  expect(ids.filter((id) => id.startsWith("building:"))).toEqual([]);

  await page.evaluate(() => window.__mantaGame!.setDogPosition(0, -60));
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  const wheel = (await gameState(page)).wheel!;
  expect(wheel.labels).toEqual([
    "New card", "Refresh board", "Scope: Mine", "Workers", "Spot checks", "Settings", "Server logs", "Brain chat",
  ]);
  await page.keyboard.press("Escape");
  await page.keyboard.up("e");
});

test("E on a card opens the real task view", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await expect(page.getByTestId("game-prompt")).toContainText("Fix login bug");
  await page.keyboard.press("e");
  await expect(page).toHaveURL(/#task-task-login/);
  await expect(page.getByRole("button", { name: "← Board" })).toBeVisible();
  // Esc returns to the board — the game world is still there.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("game-canvas")).toBeVisible();
});

test("F carries a card to another district and drops it — same status API as 2D drag", async ({ page }) => {
  const transitions: string[] = [];
  await page.route("**/api/workspaces/ws-1/tasks/task-login/status", async (route) => {
    transitions.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "task-login", cardStatus: "backlog" }) });
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await page.keyboard.press("f");
  await expect(page.getByTestId("game-carry-banner")).toBeVisible();
  expect((await gameState(page)).carrying).toBe("task-login");

  // Run (teleport) into the Backlog district and drop.
  await page.evaluate(() => {
    const zone = window.__mantaGame!.getState().zones.find((z) => z.status === "backlog")!;
    window.__mantaGame!.setDogPosition(zone.x, zone.z);
  });
  await page.keyboard.press("f");
  await expect.poll(() => transitions.length).toBe(1);
  expect(JSON.parse(transitions[0]!)).toEqual({ to: "backlog" });
  await expect(page.getByText("Moved to Backlog.")).toBeVisible();
  expect((await gameState(page)).carrying).toBeNull();
});

test("carrying a card to Done sends the same doneReason as 2D drag", async ({ page }) => {
  const transitions: string[] = [];
  await page.route("**/api/workspaces/ws-1/tasks/task-login/status", async (route) => {
    transitions.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "task-login", cardStatus: "done" }) });
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await page.keyboard.press("f");
  await page.evaluate(() => {
    const zone = window.__mantaGame!.getState().zones.find((z) => z.status === "done")!;
    window.__mantaGame!.setDogPosition(zone.x, zone.z);
  });
  await page.keyboard.press("f");
  await expect.poll(() => transitions.length).toBe(1);
  expect(JSON.parse(transitions[0]!)).toEqual({ to: "done", doneReason: "abandoned" });
});

test("Esc puts a carried card back without calling the API", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await page.keyboard.press("f");
  expect((await gameState(page)).carrying).toBe("task-login");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Card put back.")).toBeVisible();
  expect((await gameState(page)).carrying).toBeNull();
});

test("hold E near a card opens its wheel; releasing confirms 'Open card'", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  const wheel = (await gameState(page)).wheel;
  expect(wheel!.title).toBe("Fix login bug");
  expect(wheel!.labels).toEqual(expect.arrayContaining(["Open card", "Carry (move status)", "Link a PR"]));
  expect(wheel!.selected).toBe(0); // "Open card"
  await page.keyboard.up("e");
  await expect(page).toHaveURL(/#task-task-login/);
});

test("hold E away from everything opens the global wheel; Esc cancels cleanly", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await page.evaluate(() => window.__mantaGame!.setDogPosition(0, -60));
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  const wheel = (await gameState(page)).wheel;
  expect(wheel!.title).toBe("Manta");
  expect(wheel!.labels).toEqual(expect.arrayContaining(["New card", "Refresh board", "Workers", "Settings", "Brain chat"]));
  await page.keyboard.press("Escape");
  await page.keyboard.up("e");
  await expect(page.getByTestId("game-wheel")).toHaveCount(0);
  await expect(page.locator(".modal")).toHaveCount(0);
  expect((await gameState(page)).wheel).toBeNull();
});

test("global wheel: releasing E on 'New card' opens the real modal", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await page.evaluate(() => window.__mantaGame!.setDogPosition(0, -60));
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.keyboard.up("e"); // selected = "New card"
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page.locator(".modal textarea").first()).toBeVisible();
});

test("card wheel: reassign submenu hits the same assignee API as the board", async ({ page }) => {
  const patches: string[] = [];
  await installMockApi(page, { members: RICH_MEMBERS }); // two members → reassign appears
  await page.route("**/api/workspaces/ws-1/tasks/task-login/assignee", async (route) => {
    patches.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "task-login", createdBy: "user-2" }) });
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await walkDogTo(page, "card:task-login");
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.keyboard.press("d"); // → Carry
  await page.keyboard.press("d"); // → Reassign
  await page.keyboard.up("e"); // confirm → submenu (browse mode)
  await expect.poll(async () => (await gameState(page)).wheel?.title).toBe("Reassign to…");
  await page.keyboard.press("e"); // confirm first member
  await expect.poll(() => patches.length).toBe(1);
  expect(JSON.parse(patches[0]!)).toEqual({ userId: "user-2" });
  await expect(page.getByText(/^Reassigned to /)).toBeVisible();
});

test("global wheel sectors open the real Workers modal and Settings view", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await page.evaluate(() => window.__mantaGame!.setDogPosition(0, -60));

  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.keyboard.press("Escape"); // release the hold cleanly, browse via mouse instead
  await page.keyboard.up("e");
  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.locator(".game-wheel-item").nth(3).click(); // Workers
  await page.keyboard.up("e");
  await expect(page.locator(".modal")).toBeVisible();
  await page.locator(".modal-head button").click();
  await expect(page.locator(".modal")).toHaveCount(0);

  await page.keyboard.down("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.locator(".game-wheel-item").nth(5).click(); // Settings
  await page.keyboard.up("e");
  await expect(page).toHaveURL(/#settings/);
});

test("the PR depot browses untracked PRs and tracks one as a card", async ({ page }) => {
  await installMockApi(page, { githubPrs: RICH_PRS });
  const tracked: string[] = [];
  await page.route("**/api/workspaces/ws-1/cards/from-pr", async (route) => {
    tracked.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "task-login", cardStatus: "bot_working" }) });
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  // Stand just plaza-side of the depot so it (not a sample crate) is nearest.
  await page.evaluate(() => {
    const depot = window.__mantaGame!.getState().interactables.find((i) => i.id === "depot:github-prs")!;
    const len = Math.hypot(depot.x, depot.z);
    window.__mantaGame!.setDogPosition(depot.x * (1 - 1.3 / len), depot.z * (1 - 1.3 / len));
  });
  await page.waitForFunction(() => window.__mantaGame?.getState().nearestId === "depot:github-prs");
  await page.keyboard.press("e"); // tap: browsing is the depot's default action
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  const wheel = (await gameState(page)).wheel!;
  expect(wheel.title).toBe("Untracked PRs");
  expect(wheel.labels[0]).toContain("#130");
  await page.keyboard.press("e"); // confirm first PR → track it
  await expect.poll(() => tracked.length).toBe(1);
  expect(JSON.parse(tracked[0]!).prNumber).toBe(130);
});

test("Linear yard shows Todo by default and the wheel switches the status", async ({ page }) => {
  await installMockApi(page, {
    linearTickets: [
      { id: "t1", identifier: "ENG-1", title: "Todo thing", description: null, state: { id: "s1", name: "Todo", type: "unstarted", position: 0 }, url: "https://linear.app/x/ENG-1", updatedAt: "2026-06-30T09:00:00Z", priority: 0, estimate: null, team: null, project: null, repo: "acme/app" },
      { id: "t2", identifier: "ENG-2", title: "Started thing", description: null, state: { id: "s2", name: "In Progress", type: "started", position: 1 }, url: "https://linear.app/x/ENG-2", updatedAt: "2026-06-30T09:10:00Z", priority: 0, estimate: null, team: null, project: null, repo: "acme/app" },
      { id: "t3", identifier: "ENG-3", title: "Another started", description: null, state: { id: "s2", name: "In Progress", type: "started", position: 1 }, url: "https://linear.app/x/ENG-3", updatedAt: "2026-06-30T09:20:00Z", priority: 0, estimate: null, team: null, project: null, repo: "acme/app" },
    ],
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  expect((await gameState(page)).linearFilter).toBe("Todo");
  // Only the Todo ticket stands in the yard by default.
  let ids = (await gameState(page)).interactables.filter((i) => i.kind === "linear-ticket").map((i) => i.id);
  expect(ids).toEqual(["linear:ENG-1"]);

  await page.evaluate(() => {
    const depot = window.__mantaGame!.getState().interactables.find((i) => i.id === "depot:linear")!;
    const len = Math.hypot(depot.x, depot.z);
    window.__mantaGame!.setDogPosition(depot.x * (1 - 1.3 / len), depot.z * (1 - 1.3 / len));
  });
  await page.waitForFunction(() => window.__mantaGame?.getState().nearestId === "depot:linear");
  await page.keyboard.press("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  let wheel = (await gameState(page)).wheel!;
  expect(wheel.title).toBe("Linear · Todo");
  expect(wheel.labels).toContain("Showing: Todo");

  // Navigate to the switcher (last item), open it, pick "In Progress".
  await page.keyboard.press("a"); // wrap to the last item = Showing: Todo
  await page.keyboard.press("e"); // open submenu
  await expect.poll(async () => (await gameState(page)).wheel?.title).toBe("Show tickets…");
  wheel = (await gameState(page)).wheel!;
  expect(wheel.labels).toEqual(["Todo (1) ✓", "In Progress (2)"]);
  await page.keyboard.press("d");
  await page.keyboard.press("e"); // confirm In Progress
  await expect(page.getByText('Linear yard now showing "In Progress" tickets.')).toBeVisible();
  await expect.poll(async () => (await gameState(page)).linearFilter).toBe("In Progress");
  ids = (await gameState(page)).interactables.filter((i) => i.kind === "linear-ticket").map((i) => i.id);
  expect(ids).toEqual(["linear:ENG-2", "linear:ENG-3"]);
});

test("whistle search beacons and auto-runs the dog to the match", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  const before = await gameState(page);
  await page.keyboard.press("/");
  await expect(page.getByTestId("game-search")).toBeVisible();
  await page.keyboard.type("write the docs");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("game-search")).toHaveCount(0);
  // The dog auto-runs toward card:task-docs — distance to it shrinks.
  const target = before.interactables.find((i) => i.id === "card:task-docs")!;
  const d0 = Math.hypot(before.dog.x - target.x, before.dog.z - target.z);
  await expect.poll(async () => {
    const s = await gameState(page);
    return Math.hypot(s.dog.x - target.x, s.dog.z - target.z);
  }, { timeout: 20_000 }).toBeLessThan(d0 - 1);
});

test("whistle with no match toasts instead of moving", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await page.keyboard.press("/");
  await page.keyboard.type("zzz-nothing-matches");
  await page.keyboard.press("Enter");
  await expect(page.getByText('Nothing on the board matches "zzz-nothing-matches".')).toBeVisible();
});

test("minimap click auto-runs the dog toward that world point", async ({ page }) => {
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  const before = await gameState(page);
  const map = page.getByTestId("game-minimap");
  const box = (await map.boundingBox())!;
  // Click the east side of the map — the dog should start moving east (+x).
  await map.click({ position: { x: box.width - 12, y: box.height / 2 } });
  await expect.poll(async () => (await gameState(page)).dog.x, { timeout: 20_000 }).toBeGreaterThan(before.dog.x + 1);
});

test("the Linear yard filter persists across reloads", async ({ page }) => {
  await installMockApi(page, {
    linearTickets: [
      { id: "t1", identifier: "ENG-1", title: "Todo thing", description: null, state: { id: "s1", name: "Todo", type: "unstarted", position: 0 }, url: "https://linear.app/x/ENG-1", updatedAt: "2026-06-30T09:00:00Z", priority: 0, estimate: null, team: null, project: null, repo: "acme/app" },
      { id: "t2", identifier: "ENG-2", title: "Started thing", description: null, state: { id: "s2", name: "In Progress", type: "started", position: 1 }, url: "https://linear.app/x/ENG-2", updatedAt: "2026-06-30T09:10:00Z", priority: 0, estimate: null, team: null, project: null, repo: "acme/app" },
    ],
  });
  await page.goto(GAME_URL);
  await page.waitForFunction(() => !!window.__mantaGame);
  await page.evaluate(() => {
    const depot = window.__mantaGame!.getState().interactables.find((i) => i.id === "depot:linear")!;
    const len = Math.hypot(depot.x, depot.z);
    window.__mantaGame!.setDogPosition(depot.x * (1 - 1.3 / len), depot.z * (1 - 1.3 / len));
  });
  await page.waitForFunction(() => window.__mantaGame?.getState().nearestId === "depot:linear");
  await page.keyboard.press("e");
  await expect(page.getByTestId("game-wheel")).toBeVisible();
  await page.keyboard.press("a"); // wrap to "Showing:"
  await page.keyboard.press("e");
  await expect.poll(async () => (await gameState(page)).wheel?.title).toBe("Show tickets…");
  await page.keyboard.press("d");
  await page.keyboard.press("e"); // pick In Progress
  await expect.poll(async () => (await gameState(page)).linearFilter).toBe("In Progress");

  await page.reload();
  await page.waitForFunction(() => !!window.__mantaGame);
  expect((await gameState(page)).linearFilter).toBe("In Progress");
});

test("game mode toggles from the user menu and persists preference", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Fix login bug")).toBeVisible();

  await page.locator(".user-trigger").click();
  await page.getByTestId("game-mode-toggle").click();
  await expect(page.getByTestId("game-canvas")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("manta:gameMode"))).toBe("true");

  await page.locator(".user-trigger").click();
  await page.getByTestId("game-mode-toggle").click();
  await expect(page.getByTestId("game-canvas")).toHaveCount(0);
  await expect(page.getByText("Fix login bug")).toBeVisible();
});
