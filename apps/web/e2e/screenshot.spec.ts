// Visual iteration harness — not a test. Run with:
//   SCREENSHOT_DIR=/tmp/game pnpm test:e2e screenshot
// Saves framed PNGs of the world at production card counts (3× the rich
// fixture board) so the game's look can be reviewed without a server.

import { test } from "@playwright/test";
import { installMockApi, walkDogTo } from "./mockApi.ts";
import { RICH_CARDS, RICH_MEMBERS, RICH_MEMBERSHIPS, RICH_PRS, RICH_TICKETS } from "./fixtures.ts";

const DIR = process.env.SCREENSHOT_DIR;

test.skip(!DIR, "screenshot harness: set SCREENSHOT_DIR to enable");

test.use({ viewport: { width: 1600, height: 1000 } });

// Simulate a production board: ~36 cards.
const PROD_SCALE_CARDS = [0, 1, 2].flatMap((n) =>
  RICH_CARDS.map((c) => ({ ...c, id: `${c.id}-${n}`, taskNumber: (c.taskNumber ?? 0) + n * 100 })),
);

test("capture game views", async ({ page }) => {
  test.setTimeout(90_000);
  await installMockApi(page, {
    cards: PROD_SCALE_CARDS,
    githubPrs: [0,1,2,3,4].flatMap((n) => RICH_PRS.map((pr) => ({ ...pr, number: pr.number + n * 10 }))),
    linearTickets: RICH_TICKETS,
    members: RICH_MEMBERS,
    memberships: RICH_MEMBERSHIPS,
  });
  await page.goto("/?game=1");
  await page.waitForFunction(() => !!window.__mantaGame);
  // Let the corgi FBX + fonts land so shots show the real thing.
  await page.waitForFunction(() => window.__mantaGame!.getState().modelLoaded, undefined, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.screenshot({ path: `${DIR}/1-overview.png` });

  const firstCardId = await page.evaluate(() =>
    window.__mantaGame!.getState().interactables.find((i) => i.kind === "card")!.id);
  await walkDogTo(page, firstCardId);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${DIR}/2-district.png` });

  await page.keyboard.down("e");
  await page.waitForSelector('[data-testid="game-wheel"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/3-card-wheel.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.up("e");

  await page.keyboard.press("f");
  await page.waitForSelector('[data-testid="game-carry-banner"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/4-carrying.png` });
  await page.keyboard.press("Escape");

  await page.evaluate(() => window.__mantaGame!.setDogPosition(0, -60));
  await page.keyboard.down("e");
  await page.waitForSelector('[data-testid="game-wheel"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/5-global-wheel.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.up("e");

  await page.evaluate(() => {
    const depot = window.__mantaGame!.getState().interactables.find((i) => i.id === "depot:github-prs")!;
    window.__mantaGame!.setDogPosition(depot.x, depot.z - 2.5);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${DIR}/6-intake.png` });
});
