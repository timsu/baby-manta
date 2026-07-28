import { useCallback, useEffect, useState } from "react";
import { api, type NotionConnection } from "../api.ts";

export function NotionIntegration({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<NotionConnection | null>(null);
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void api.notionStatus(workspaceId).then((next) => {
      setStatus(next);
      setInstructions(next.instructions);
    }).catch((err) => {
      setStatus(null);
      setLoadError(err instanceof Error ? err.message : "Failed to load Notion settings");
    }).finally(() => setLoading(false));
  }, [workspaceId]);
  useEffect(load, [load]);

  const saveInstructions = async () => {
    setSaving(true); setMessage(null);
    try {
      const result = await api.notionSaveInstructions(workspaceId, instructions);
      setInstructions(result.instructions);
      setStatus((current) => current ? { ...current, instructions: result.instructions } : current);
      setMessage("Notion instructions saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save Notion instructions");
    } finally { setSaving(false); }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Notion from this workspace? Notion tools will stop working until you reconnect.")) return;
    setSaving(true); setMessage(null);
    try {
      await api.notionDisconnect(workspaceId);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to disconnect Notion");
    } finally { setSaving(false); }
  };

  if (loading) return <p className="muted">Loading…</p>;
  if (!status) return (
    <div className="provider-form">
      <span className="provider-err">{loadError ?? "Failed to load Notion settings"}</span>
      <div className="s-foot"><button className="btn small" onClick={load}>Retry</button></div>
    </div>
  );
  return (
    <div className="integrations-list">
      <div className={`integration-row ${status.connected ? "connected" : ""}`}>
        <div className="integration-info">
          <span className="integration-label">Notion workspace</span>
          <span className="muted small">
            {status.connected
              ? "Connected. Manta's brain, workers, and Slack workflows can use workspace-scoped Notion tools."
              : "Connect Notion once for the workspace. Manta stores the OAuth credential encrypted and keeps it server-side."}
          </span>
        </div>
        <div className="integration-actions">
          {status.connected
            ? <button className="btn ghost small" disabled={saving} onClick={() => void disconnect()}>Disconnect</button>
            : <a className="btn primary small" href={api.notionConnectUrl(workspaceId)}>Connect Notion</a>}
        </div>
      </div>

      <div className="provider-form">
        <label>Notion instructions</label>
        <textarea
          rows={9}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={"Add durable guidance for agents using Notion. For example:\n\nImportant docs:\n- Product specs: https://notion.so/...\n- Engineering handbook: https://notion.so/..."}
        />
        <span className="s-hint">
          Put important doc links, naming conventions, and usage guidance here. Agents can retrieve this on demand with <code>read_notion_instructions</code>.
        </span>
        {message && <span className="small muted">{message}</span>}
        <div className="s-foot">
          <button className="btn primary small" disabled={saving || instructions === status.instructions} onClick={() => void saveInstructions()}>
            {saving ? "Saving…" : "Save instructions"}
          </button>
        </div>
      </div>
    </div>
  );
}
