import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { addToast } from "../stores.ts";
import type { ServerLogEntry } from "../api.ts";

export function DebugView({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<ServerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.serverLogs(200);
      setLogs(res.logs);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load server logs", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <section className="debug-view">
      <div className="debug-head">
        <div>
          <h2>Debugging</h2>
          <p className="muted small">Recent structured server logs from this Manta process.</p>
        </div>
        <div className="debug-actions">
          <button className="btn" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="debug-log-list" aria-live="polite">
        {logs.length === 0 && <div className="muted">{loading ? "Loading logs…" : "No server logs captured yet."}</div>}
        {logs.map((log, idx) => {
          return (
            <article key={`${log.time}-${idx}`} className={`debug-log debug-log-${log.level}`}>
              <div className="debug-log-line">
                <time>{new Date(log.time).toLocaleString()}</time>
                <span className="debug-level">{log.level}</span>
                <span className="debug-domain">{log.domain}</span>
                <span className="debug-msg">{log.msg}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
