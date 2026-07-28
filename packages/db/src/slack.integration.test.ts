// Integration test against a REAL Postgres (DATABASE_URL). Covers the Slack
// multi-bot data layer: bot CRUD is workspace-scoped, findBotByAppId routes
// inbound events, email auto-link, and Slack-origin task stamping. Skipped when
// DATABASE_URL is absent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./client.ts";
import * as workspaces from "./workspaces.ts";
import * as tasks from "./tasks.ts";
import * as slack from "./slack.ts";
import * as users from "./users.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const rand = () => Math.random().toString(36).slice(2, 9);

describe.skipIf(!hasDb)("db integration: slack bots + user link", () => {
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const cipher = () => Buffer.from(`secret-${rand()}`);

  it("scopes bot reads/writes to their workspace and routes by app id", async () => {
    const a = await workspaces.create({ slug: `ws-${rand()}`, name: "A" });
    const b = await workspaces.create({ slug: `ws-${rand()}`, name: "B" });
    workspaceIds.push(a.id, b.id);

    const appId = `App${rand()}`;
    const bot = await slack.createBot(a.id, {
      name: "Support",
      slackAppId: appId,
      instructions: "be helpful",
      botTokenCipher: cipher(),
      signingSecretCipher: cipher(),
    });

    // Visible + routable
    expect((await slack.getBot(a.id, bot.id))?.id).toBe(bot.id);
    expect((await slack.findBotByAppId(appId))?.id).toBe(bot.id);
    expect((await slack.listBots(a.id)).map((x) => x.id)).toContain(bot.id);

    // Invisible / immutable from another workspace
    expect(await slack.getBot(b.id, bot.id)).toBeNull();
    expect(await slack.updateBot(b.id, bot.id, { name: "hijacked" })).toBeNull();
    await slack.deleteBot(b.id, bot.id); // no-op
    expect((await slack.getBot(a.id, bot.id))?.name).toBe("Support");

    // Owner can update + delete
    const updated = await slack.updateBot(a.id, bot.id, { name: "Support v2", spawnCardPolicy: "never" });
    expect(updated?.name).toBe("Support v2");
    expect(updated?.spawnCardPolicy).toBe("never");
    await slack.deleteBot(a.id, bot.id);
    expect(await slack.getBot(a.id, bot.id)).toBeNull();
  });

  it("links a Slack team to a workspace", async () => {
    const a = await workspaces.create({ slug: `ws-${rand()}`, name: "T" });
    workspaceIds.push(a.id);
    const team = `T${rand()}`;
    await slack.linkSlackTeam(a.id, team);
    expect(await slack.findWorkspaceBySlackTeam(team)).toBe(a.id);
  });

  it("resolves a user by email and links their Slack id", async () => {
    const email = `u-${rand()}@example.com`;
    const u = await prisma.user.create({ data: { googleSub: `g-${rand()}`, email } });
    userIds.push(u.id);

    expect((await users.byEmail(email))?.id).toBe(u.id);
    expect(await users.bySlackUserId("U_NOPE")).toBeNull();

    const slackUserId = `U${rand()}`;
    await users.setSlack(u.id, slackUserId);
    expect((await users.bySlackUserId(slackUserId))?.id).toBe(u.id);
  });

  it("stamps Slack origin + creator onto a task created from a Slack turn", async () => {
    const a = await workspaces.create({ slug: `ws-${rand()}`, name: "S" });
    workspaceIds.push(a.id);
    const u = await prisma.user.create({ data: { googleSub: `g-${rand()}`, email: `s-${rand()}@example.com` } });
    userIds.push(u.id);
    // slackBotId carries a real FK now, so the originating bot must exist.
    const bot = await slack.createBot(a.id, {
      name: "Origin",
      slackAppId: `App${rand()}`,
      instructions: "",
      botTokenCipher: cipher(),
      signingSecretCipher: cipher(),
    });

    const t = await tasks.create(
      { workspaceId: a.id },
      {
        name: "do-it",
        title: "Do it",
        description: "from slack",
        kind: "agent",
        cardType: "bot",
        repo: "acme/x",
        workerBackend: "pi-gpt-5.4",
        createdBy: u.id,
        slackChannel: "C123",
        slackThreadTs: "1700.001",
        slackUserId: "Uabc",
        slackBotId: bot.id,
      },
    );

    expect(t.createdBy).toBe(u.id);
    expect(t.slackChannel).toBe("C123");
    expect(t.slackThreadTs).toBe("1700.001");
    expect(t.slackBotId).toBe(bot.id);

    // Deleting the bot nulls the task's pointer (onDelete: SetNull), not the task.
    await slack.deleteBot(a.id, bot.id);
    expect((await tasks.get({ workspaceId: a.id }, t.id))?.slackBotId).toBeNull();
  });
});
