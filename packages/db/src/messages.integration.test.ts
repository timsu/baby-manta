import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./client.ts";
import * as workspaces from "./workspaces.ts";
import * as messages from "./messages.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);

describe.skipIf(!hasDb)("messages store", () => {
  let wid = "";
  beforeAll(async () => {
    await prisma.$connect();
    const ws = await workspaces.create({ slug: "ws-msg-" + Math.random().toString(36).slice(2, 8), name: "Msg" });
    wid = ws.id;
  });
  afterAll(async () => {
    if (wid) await prisma.workspace.deleteMany({ where: { id: wid } });
    await prisma.$disconnect();
  });

  it("assigns monotonic per-channel seq and lists oldest→newest", async () => {
    const scope = { workspaceId: wid };
    await messages.append(scope, { channel: "brain", role: "user", content: "one" });
    await messages.append(scope, { channel: "brain", role: "assistant", content: "two" });
    // a different channel has its own seq space
    await messages.append(scope, { channel: "c-1", role: "user", content: "other" });
    await messages.append(scope, { channel: "brain", role: "user", content: "three" });

    const brain = await messages.list(scope, "brain");
    expect(brain.map((m) => m.content)).toEqual(["one", "two", "three"]);
    expect(brain.map((m) => m.seq)).toEqual([1, 2, 3]);

    const other = await messages.list(scope, "c-1");
    expect(other.map((m) => m.seq)).toEqual([1]);
    expect(await messages.count(scope, "brain")).toBe(3);
  });

  it("paging with beforeSeq returns the earlier slice", async () => {
    const scope = { workspaceId: wid };
    const page = await messages.list(scope, "brain", { beforeSeq: 3, limit: 10 });
    expect(page.map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("does not leak messages across workspaces", async () => {
    const other = await workspaces.create({ slug: "ws-msg2-" + Math.random().toString(36).slice(2, 8), name: "Msg2" });
    try {
      expect(await messages.list({ workspaceId: other.id }, "brain")).toHaveLength(0);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: other.id } });
    }
  });
});
