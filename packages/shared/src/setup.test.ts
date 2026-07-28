import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupCommands, formatSetupTranscript } from "./setup.ts";

describe("runSetupCommands", () => {
  it("returns ok with streamed output on success", async () => {
    const chunks: string[] = [];
    const result = await runSetupCommands(process.cwd(), "echo hello-setup", (c) => chunks.push(c));
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.output).toContain("hello-setup");
    expect(chunks.join("")).toContain("hello-setup");
  });

  it("reports a non-zero exit as not-ok without throwing", async () => {
    const result = await runSetupCommands(process.cwd(), "echo before && exit 3", () => {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.output).toContain("before");
  });

  it("no-ops on an empty script", async () => {
    const result = await runSetupCommands(process.cwd(), "   ", () => {});
    expect(result).toEqual({ code: 0, ok: true, output: "", timedOut: false });
  });

  it("disables pnpm store integrity checks for setup shells", async () => {
    const result = await runSetupCommands(process.cwd(), "printf %s \"$npm_config_verify_store_integrity\"", () => {});
    expect(result.ok).toBe(true);
    expect(result.output).toBe("false");
  });

  it("marks timedOut when the command exceeds the timeout", async () => {
    const result = await runSetupCommands(process.cwd(), "sleep 5", () => {}, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("tail-truncates output past maxOutput", async () => {
    const result = await runSetupCommands(process.cwd(), "for i in $(seq 1 1000); do echo line$i; done", () => {}, { maxOutput: 200 });
    expect(result.output.length).toBeLessThanOrEqual(200);
    expect(result.output).toContain("line1000");
  });

  it("kills the whole process tree on timeout, not just the shell", async () => {
    // The script backgrounds a long-lived grandchild and records its pid. If we
    // only killed the bash leader (the old bug), the grandchild would survive
    // and be reparented to init; killing the process group takes it down too.
    const pidFile = join(tmpdir(), `manta-setup-test-${process.pid}-${Date.now()}.pid`);
    const script = `sleep 30 & echo $! > ${pidFile}; wait`;
    const result = await runSetupCommands(process.cwd(), script, () => {}, { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);

    await new Promise((r) => setTimeout(r, 200)); // let SIGKILL propagate + reap
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    try { process.kill(grandchildPid, 0); } catch { alive = false; }
    rmSync(pidFile, { force: true });
    expect(alive).toBe(false);
  });
});

describe("formatSetupTranscript", () => {
  it("uses a success header when ok", () => {
    const body = formatSetupTranscript("pnpm install", { code: 0, ok: true, output: "done", timedOut: false });
    expect(body).toContain("✅ Setup commands completed.");
    expect(body).toContain("$ pnpm install");
    expect(body).toContain("done");
  });

  it("uses a failure header with the exit code", () => {
    const body = formatSetupTranscript("pnpm install", { code: 1, ok: false, output: "boom", timedOut: false });
    expect(body).toContain("⚠️ Setup commands failed (exit 1).");
  });

  it("uses a timeout header when timed out", () => {
    const body = formatSetupTranscript("sleep 999", { code: null, ok: false, output: "", timedOut: true });
    expect(body).toContain("⏱️ Setup commands timed out.");
  });
});
