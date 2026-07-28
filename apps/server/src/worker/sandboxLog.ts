// A small ring buffer of each cloud sandbox's recent launcher output, kept so a
// mid-task disconnect notice can show WHY the worker died (the real error — a
// failed extension load, an upstream 529, a crash) instead of a bare "worker
// disconnected mid-task". The server already receives this output via the
// streamLogs onChunk in cloud.ts; here we just retain the tail in memory.

const tails = new Map<string, string[]>();

const MAX_LINES = 40;
const MAX_CHARS = 2_000;

/** Append a chunk of launcher output for a task, keeping only the last lines. */
export function appendSandboxLog(taskId: string, chunk: string): void {
  const lines = tails.get(taskId) ?? [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed) lines.push(trimmed);
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  tails.set(taskId, lines);
}

/** The retained tail of a task's launcher output, capped for a card note. "" if
 * nothing was buffered (e.g. a laptop worker, whose output isn't relayed here). */
export function recentSandboxLog(taskId: string): string {
  const text = (tails.get(taskId) ?? []).join("\n");
  return text.length > MAX_CHARS ? text.slice(text.length - MAX_CHARS) : text;
}

/** Drop a task's buffer once the box is gone (stop/remove). */
export function clearSandboxLog(taskId: string): void {
  tails.delete(taskId);
}
