import { describe, it, expect } from "vitest";
import { FakeSandboxes } from "./fake.ts";

describe("Sandboxes (fake)", () => {
  it("creates, execs, stops, and starts (state tracked)", async () => {
    const sb = new FakeSandboxes((cmd) => ({ stdout: `ran: ${cmd}`, exitCode: 0 }));
    const h = await sb.create({ labels: { workspace: "w1", task: "c-1" } });
    expect(h.state).toBe("started");
    expect(await sb.exec(h.id, "echo hi")).toEqual({ stdout: "ran: echo hi", exitCode: 0 });
    await sb.stop(h.id);
    // listByLabel surfaces stopped boxes (with state) so the control plane can
    // resume/clean them and the UI can show them.
    expect((await sb.listByLabel({ workspace: "w1" }))[0]?.state).toBe("stopped");
    await sb.start(h.id);
    expect((await sb.listByLabel({ workspace: "w1" }))[0]?.state).toBe("started");
  });

  it("listByLabel is workspace-scoped (ownership)", async () => {
    const sb = new FakeSandboxes();
    await sb.create({ labels: { workspace: "w1", task: "c-1" } });
    await sb.create({ labels: { workspace: "w1", task: "c-2" } });
    await sb.create({ labels: { workspace: "w2", task: "c-3" } });
    expect(await sb.listByLabel({ workspace: "w1" })).toHaveLength(2);
    expect(await sb.listByLabel({ workspace: "w2" })).toHaveLength(1);
    expect(await sb.listByLabel({ workspace: "w1", task: "c-2" })).toHaveLength(1);
  });

  it("pushFile stores content for the sandbox", async () => {
    const sb = new FakeSandboxes();
    const h = await sb.create({ labels: { workspace: "w1" } });
    await sb.pushFile(h.id, "/home/.creds.json", '{"token":"x"}');
    expect(sb.fileAt(h.id, "/home/.creds.json")).toBe('{"token":"x"}');
  });

  it("streamLogs emits then closes", async () => {
    const sb = new FakeSandboxes((cmd) => ({ stdout: `out:${cmd}`, exitCode: 0 }));
    const h = await sb.create({ labels: { workspace: "w1" } });
    const chunks: string[] = [];
    let closed = false;
    await sb.streamLogs({ id: h.id, command: "build", onChunk: (c) => chunks.push(c), onClose: () => { closed = true; } });
    await new Promise((r) => setTimeout(r, 5));
    expect(chunks).toEqual(["out:build"]);
    expect(closed).toBe(true);
  });
});
