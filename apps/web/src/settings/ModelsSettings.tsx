import { useCallback, useEffect, useState } from "react";
import { api, type ModelsView, type ProviderStatus } from "../api.ts";

export function ModelsSettings({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<ModelsView | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => { void api.models(workspaceId).then(setView); }, [workspaceId]);
  useEffect(() => { reload(); }, [reload]);

  if (!view) return <p className="muted">Loading…</p>;

  const { models, providers, defaultModel, scoutModel, cardModels } = view;
  // The selected model ids may reference something no longer available (provider
  // removed); keep them selectable so the user can see/clear them.
  const modelIds = new Set(models.map((m) => m.id));
  const labelFor = (id: string) => models.find((m) => m.id === id)?.label ?? id;

  const saveDefault = async (id: string | null) => {
    if (id === defaultModel) return;
    const from = defaultModel ? labelFor(defaultModel) : "Auto (server default)";
    const to = id ? labelFor(id) : "Auto (server default)";
    if (!confirm(`Change the workspace brain model from ${from} to ${to}? This affects all future brain turns and new cards in this workspace.`)) return;
    setBusy(true);
    try { setView(await api.updateModels(workspaceId, { defaultModel: id })); }
    finally { setBusy(false); }
  };
  const saveScout = async (id: string | null) => {
    setBusy(true);
    try { setView(await api.updateModels(workspaceId, { scoutModel: id })); }
    finally { setBusy(false); }
  };
  const setCardModels = async (ids: string[]) => {
    setBusy(true);
    try { setView(await api.updateModels(workspaceId, { cardModels: ids })); }
    finally { setBusy(false); }
  };

  const addable = models.filter((m) => !cardModels.includes(m.id) && m.id !== defaultModel);

  return (
    <>
      <h2>Models</h2>

      <div className="s-field">
        <label>Brain model</label>
        <select value={defaultModel ?? ""} disabled={busy}
                onChange={(e) => void saveDefault(e.target.value || null)}>
          <option value="">Auto (server default)</option>
          {defaultModel && !modelIds.has(defaultModel) && (
            <option value={defaultModel}>{labelFor(defaultModel)} (unavailable)</option>
          )}
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <span className="s-hint">Used for brain turns and new cards unless a card picks another model.</span>
      </div>

      <div className="s-field">
        <label>Scout model</label>
        <select value={scoutModel ?? ""} disabled={busy}
                onChange={(e) => void saveScout(e.target.value || null)}>
          <option value="">Auto (cheapest available)</option>
          {scoutModel && !modelIds.has(scoutModel) && (
            <option value={scoutModel}>{labelFor(scoutModel)} (unavailable)</option>
          )}
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <span className="s-hint">Cheap model for the background triage pass that runs every few minutes. Auto picks the cheapest available model, then the brain model.</span>
      </div>

      <div className="s-field">
        <label>New-card models</label>
        {cardModels.length === 0 && <span className="s-hint">No extra models — only the default shows in the new-card picker.</span>}
        <div className="chip-row">
          {cardModels.map((id, i) => (
            <span key={id} className={`chip ${modelIds.has(id) ? "" : "chip-stale"}`}>
              {labelFor(id)}
              {i > 0 && (
                <button className="chip-x" title="Move left" disabled={busy} onClick={() => {
                  const next = [...cardModels];
                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                  void setCardModels(next);
                }}>←</button>
              )}
              {i < cardModels.length - 1 && (
                <button className="chip-x" title="Move right" disabled={busy} onClick={() => {
                  const next = [...cardModels];
                  [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                  void setCardModels(next);
                }}>→</button>
              )}
              <button className="chip-x" title="Remove" disabled={busy}
                      onClick={() => void setCardModels(cardModels.filter((x) => x !== id))}>✕</button>
            </span>
          ))}
        </div>
        {addable.length > 0 && (
          <select value="" disabled={busy}
                  onChange={(e) => { if (e.target.value) void setCardModels([...cardModels, e.target.value]); }}>
            <option value="">Add a model…</option>
            {addable.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        <span className="s-hint">Extra models offered in the new-card modal. The default is always included.</span>
      </div>

      <h3 className="s-subhead">API keys</h3>
      <p className="s-hint" style={{ marginTop: 0 }}>
        Workspace-level API keys. Subscription providers (Codex) are configured per-user in Account settings.
      </p>
      {providers.filter((p) => p.authKind !== "subscription").map((p) => (
        <ProviderRow key={p.id} provider={p} workspaceId={workspaceId} onChange={setView} />
      ))}
      {models.length === 0 && (
        <p className="muted small" style={{ marginTop: 12 }}>
          No models available yet. Add an API key here or connect a Codex subscription in Account settings.
        </p>
      )}
    </>
  );
}

function ProviderRow({ provider, workspaceId, onChange }: {
  provider: ProviderStatus; workspaceId: string; onChange: (v: ModelsView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => { setValue(""); setErr(null); };

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true); setErr(null);
    try {
      onChange(await api.setProvider(workspaceId, provider.id, { apiKey: value.trim() }));
      reset(); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!confirm(`Disconnect ${provider.label} from this workspace? Models that depend on this API key will stop working until you configure it again.`)) return;
    setBusy(true);
    try { onChange(await api.removeProvider(workspaceId, provider.id)); }
    finally { setBusy(false); }
  };

  return (
    <div className="provider-row">
      <div className="provider-head">
        <div className="provider-info">
          <span className="provider-name">
            {provider.label}
            <span className={`provider-dot ${provider.configured ? "on" : ""}`} />
          </span>
          <span className="provider-meta">
            {provider.configured ? "API key set" : "Not configured"}
            {provider.modelCount > 0 ? ` · ${provider.modelCount} models` : ""}
          </span>
        </div>
        <div className="provider-actions">
          {provider.configured
            ? <button className="btn ghost small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
            : <button className="btn small" onClick={() => { reset(); setOpen((v) => !v); }}>{open ? "Cancel" : "Configure"}</button>}
          {provider.configured && (
            <button className="btn ghost small" onClick={() => { reset(); setOpen((v) => !v); }}>{open ? "Cancel" : "Replace"}</button>
          )}
        </div>
      </div>
      {open && (
        <div className="provider-form">
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)}
                 placeholder={`${provider.label} API key`}
                 onKeyDown={(e) => e.key === "Enter" && void save()} />
          {err && <span className="provider-err">{err}</span>}
          <div className="s-foot">
            <button className="btn primary" disabled={busy || !value.trim()} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
