import { useEffect, useState } from "react";
import { api, type WorkspaceDetail } from "../api.ts";
import { $me } from "../stores.ts";

export function GeneralSettings({ workspaceId }: { workspaceId: string }) {
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [name, setName] = useState("");
  const [brainPrompt, setBrainPrompt] = useState("");
  const [teamMemory, setTeamMemory] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    api.workspace(workspaceId).then((w) => {
      if (cancelled) return;
      setWs(w); setName(w.name); setBrainPrompt(w.brainPrompt); setTeamMemory(w.teamMemory);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateWorkspace(workspaceId, { name, brainPrompt, teamMemory });
      const me = $me.get();
      if (me) {
        $me.set({ ...me, memberships: me.memberships.map((m) => m.workspaceId === workspaceId ? { ...m, name } : m) });
      }
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } finally { setBusy(false); }
  };

  if (loadError) return <p className="muted">Couldn't load workspace settings. Reload to try again.</p>;
  if (!ws) return <p className="muted">Loading…</p>;
  return (
    <>
      <h2>General</h2>
      <div className="s-field">
        <label>Workspace name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="s-field">
        <label>Brain instructions</label>
        <textarea rows={6} value={brainPrompt} onChange={(e) => setBrainPrompt(e.target.value)}
                  placeholder="Leave blank to use the default." />
        <div className="s-default-expando">
          <button className="s-default-toggle" onClick={() => setShowDefault((v) => !v)}>
            {showDefault ? "▼" : "▶"} {brainPrompt.trim() ? "View default (not used)" : "View default (currently active)"}
          </button>
          {showDefault && <pre className="s-default-text">{ws.defaultBrainPrompt}</pre>}
        </div>
      </div>
      <div className="s-field">
        <label>Team memory</label>
        <textarea rows={4} value={teamMemory} onChange={(e) => setTeamMemory(e.target.value)}
                  placeholder="Persistent context the brain always sees — conventions, norms, decisions." />
        <span className="s-hint">The brain can append to this automatically via <code>append_team_memory</code>.</span>
      </div>
      <div className="s-foot">
        {saved && <span className="muted">Saved ✓</span>}
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </>
  );
}
