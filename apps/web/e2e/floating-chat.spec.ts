import { expect, test } from "@playwright/test";
import { installMockApi } from "./mockApi.ts";

test.beforeEach(async ({ page }) => {
  await installMockApi(page);
  await page.goto("/?game=0");
});

test("positions board actions for desktop and mobile viewports", async ({ page }) => {
  const chatLauncher = page.getByRole("button", { name: "Open Manta chat" });
  const newCardLauncher = page.getByRole("button", { name: "New card", exact: true });

  const desktopChat = await chatLauncher.boundingBox();
  expect(desktopChat?.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(newCardLauncher).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(newCardLauncher).toBeVisible();

  const mobileChat = await chatLauncher.boundingBox();
  const mobileNewCard = await newCardLauncher.boundingBox();
  expect(mobileChat?.x).toBeLessThan(page.viewportSize()!.width / 2);
  expect(mobileNewCard?.x).toBeGreaterThan(page.viewportSize()!.width / 2);
});

test("floating chat opens, moves, expands, and stays off task detail", async ({ page }) => {
  const launcher = page.getByRole("button", { name: "Open Manta chat" });
  await expect(launcher).toBeVisible();
  await launcher.click();

  const chat = page.getByRole("dialog", { name: "Manta chat" });
  await expect(chat).toBeVisible();
  await expect(chat.getByText("Plan and manage tasks across this board.")).toBeVisible();

  await chat.getByRole("tab", { name: "Repo" }).click();
  await expect(chat.getByText("Explore a repo checkout and turn findings into cards.")).toBeVisible();

  const before = await chat.boundingBox();
  if (!before) throw new Error("Chat window has no bounds");
  await page.mouse.move(before.x + 100, before.y + 24);
  await page.mouse.down();
  await page.mouse.move(before.x - 80, before.y - 60);
  await page.mouse.up();
  const moved = await chat.boundingBox();
  expect(moved?.x).toBeLessThan(before.x);
  expect(moved?.y).toBeLessThan(before.y);

  if (!moved) throw new Error("Moved chat window has no bounds");
  await page.mouse.move(moved.x + moved.width - 2, moved.y + moved.height - 2);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width + 70, moved.y + moved.height + 30);
  await page.mouse.up();
  const resized = await chat.boundingBox();
  expect(resized?.width).toBeGreaterThan(moved.width);
  expect(resized?.height).toBeGreaterThan(moved.height);

  await chat.getByRole("button", { name: "Expand chat window" }).click();
  await expect(chat).toHaveClass(/expanded/);
  await chat.getByRole("button", { name: "Restore chat window" }).click();
  await expect(chat).not.toHaveClass(/expanded/);

  await chat.getByRole("button", { name: "Close chat" }).click();
  await expect(launcher).toBeVisible();

  await page.getByText("Fix login bug").click();
  await expect(page.getByRole("button", { name: "← Board" })).toBeVisible();
  await expect(page.getByPlaceholder("Message the worker…")).toBeVisible();
  await expect(launcher).toHaveCount(0);
  await expect(chat).toHaveCount(0);
});
