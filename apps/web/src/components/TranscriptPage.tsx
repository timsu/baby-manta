import { useEffect, useMemo, useState } from "react";
import { api, type TaskTranscript } from "../api.ts";
import { type ChatLine } from "../stores.ts";
import { shortTaskId } from "../lib/format.ts";
import { renderLine } from "./TaskDetail.tsx";
import { Logo } from "./ui.tsx";

function transcriptPath(): { workspaceId: string; taskId: string } | null {
  const match = window.location.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return { workspaceId: decodeURIComponent(match[1]!), taskId: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

function flattenTranscript(data: TaskTranscript): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const message of data.messages) {
    if (message.meta?.transcript?.length) {
      for (const entry of message.meta.transcript) {
        if (entry.type === "tool") lines.push({ role: "tool", text: entry.tool, argsPreview: entry.args });
        else if (entry.text) lines.push({ role: entry.type, text: entry.text });
      }
      continue;
    }
    for (const tool of message.meta?.tools ?? []) {
      lines.push({ role: "tool", text: tool.tool, argsPreview: tool.args });
    }
    if (message.content) lines.push({ role: message.role === "system" ? "status" : message.role, text: message.content });
  }
  return lines;
}

export function TranscriptPage() {
  const parsed = useMemo(() => transcriptPath(), []);
  const [data, setData] = useState<TaskTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!parsed) { setError("Invalid transcript URL"); return; }
    let cancelled = false;
    api.getTaskTranscript(parsed.workspaceId, parsed.taskId)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load transcript"); });
    return () => { cancelled = true; };
  }, [parsed]);

  const lines = data ? flattenTranscript(data) : [];

  return (
    <div className="transcript-page">
      <header className="transcript-head">
        <a className="brand transcript-brand" href="/"><Logo /> Manta</a>
        <div>
          <div className="muted small">Conversation transcript</div>
          <h1>{data?.task.title ?? "Loading transcript…"}</h1>
          {data && (
            <div className="detail-meta transcript-meta">
              <span className={`status-badge status-${data.task.cardStatus}`}>{data.task.cardStatus.replace(/_/g, " ")}</span>
              <span className="muted small">{data.task.repo}</span>
              <span className="muted small" title={data.task.id}>{shortTaskId(data.task.id)}</span>
              {data.task.branch && <span className="muted small">{data.task.branch}</span>}
              {data.task.prUrl && <a className="muted small" href={data.task.prUrl}>PR #{data.task.prNumber}</a>}
              {data.task.linearIssueUrl && <a className="muted small" href={data.task.linearIssueUrl}>{data.task.linearIssueIdentifier}</a>}
            </div>
          )}
        </div>
      </header>
      <main className="transcript-card">
        {data?.truncated && (
          <div className="status-line">
            Showing the latest {data.messageLimit.toLocaleString()} of {data.totalMessages.toLocaleString()} transcript messages.
          </div>
        )}
        {error ? <p className="muted">{error}</p> : !data ? <p className="muted">Loading…</p> : lines.length === 0 ? <p className="muted">No conversation messages yet.</p> : lines.map(renderLine)}
      </main>
    </div>
  );
}
