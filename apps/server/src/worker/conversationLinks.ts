import { config } from "../config.ts";

const PR_BODY_LINK_LABEL = "Manta conversation";

export function taskTranscriptUrl(workspaceId: string, taskId: string): string {
  const base = config.webAppUrl().replace(/\/+$/, "");
  return `${base}/transcripts/${encodeURIComponent(workspaceId)}/${encodeURIComponent(taskId)}`;
}

export function appendTaskTranscriptLink(body: string | undefined, workspaceId: string, taskId: string): string {
  const url = taskTranscriptUrl(workspaceId, taskId);
  const existing = body?.trimEnd() ?? "";
  if (existing.includes(url)) return existing;
  const linkLine = `${PR_BODY_LINK_LABEL}: ${url}`;
  return existing ? `${existing}\n\n---\n${linkLine}` : linkLine;
}
