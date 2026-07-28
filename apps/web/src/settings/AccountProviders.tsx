import { useCallback, useEffect, useState } from "react";
import { api, type ProviderStatus, type UserProvidersView } from "../api.ts";

const CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

function parseRedirectUrl(input: string): { code: string; state: string } | null {
  try {
    const url = new URL(input.trim());
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch { /* not a URL */ }
  return null;
}

export function AccountProviders() {
  const [view, setView] = useState<UserProvidersView | null>(null);
  const reload = useCallback(() => { void api.userProviders().then(setView); }, []);
  useEffect(() => { reload(); }, [reload]);

  if (!view) return <p className="muted">Loading…</p>;

  return (
    <>
      <h3 className="s-subhead" style={{ marginTop: 0 }}>My model subscriptions</h3>
      <p className="s-hint" style={{ marginTop: 0 }}>
        Connect your ChatGPT Plus/Pro and Claude Code subscriptions. Tasks you create will use
        your subscriptions; if you haven't connected one, Manta rotates through available teammates' subscriptions.
      </p>
      {view.providers.map((p) => (
        <UserProviderRow key={p.id} provider={p} onChange={setView} />
      ))}
      {view.providers.length === 0 && (
        <p className="muted small">No subscription providers available.</p>
      )}
    </>
  );
}

function UserProviderRow({ provider, onChange }: {
  provider: ProviderStatus; onChange: (v: UserProvidersView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState<string | null>(null);

  const reset = () => { setValue(""); setErr(null); setOauthState(null); };

  const startOAuth = async () => {
    setBusy(true); setErr(null);
    try {
      const { authUrl, state } = await api.codexOAuthStart();
      setOauthState(state);
      window.open(authUrl, "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start login");
    } finally { setBusy(false); }
  };

  const connectClaude = async () => {
    const token = value.trim();
    if (!token) { setErr("Paste the OAuth token printed by `claude setup-token`"); return; }
    setBusy(true); setErr(null);
    try {
      onChange(await api.setUserProvider(provider.id, { authJson: { type: "oauth", token } }));
      reset(); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally { setBusy(false); }
  };

  const connectJson = async () => {
    if (!value.trim()) return;
    setBusy(true); setErr(null);
    try {
      onChange(await api.setUserProvider(provider.id, { authJson: value.trim() }));
      reset(); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally { setBusy(false); }
  };

  const completeOAuth = async () => {
    const parsed = parseRedirectUrl(value);
    if (!parsed) { setErr("Paste the full redirect URL (starts with http://localhost:1455/auth/callback?...)"); return; }
    if (!oauthState) return;
    setBusy(true); setErr(null);
    try {
      onChange(await api.codexOAuthComplete(oauthState, parsed.code));
      reset(); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try { onChange(await api.removeUserProvider(provider.id)); }
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
            {provider.configured ? "Connected" : "Not connected"}
            {provider.modelCount > 0 ? ` · ${provider.modelCount} models` : ""}
          </span>
        </div>
        <div className="provider-actions">
          {provider.configured && (
            <button className="btn ghost small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
          )}
          <button className="btn small" onClick={() => { reset(); setOpen((v) => !v); }}>
            {open ? "Cancel" : provider.configured ? "Replace" : "Connect"}
          </button>
        </div>
      </div>
      {open && provider.id === CODEX_PROVIDER_ID && !oauthState && (
        <div className="provider-form">
          <button className="btn primary" disabled={busy} onClick={() => void startOAuth()}>
            {busy ? "Opening…" : "Login with ChatGPT"}
          </button>
          <span className="s-hint">
            Opens ChatGPT in a new tab. After logging in you'll see a "connection refused" page —
            copy the URL from your address bar and paste it below. No Pi installation required.
          </span>
          {err && <span className="provider-err">{err}</span>}
        </div>
      )}
      {open && provider.id === CODEX_PROVIDER_ID && oauthState && (
        <div className="provider-form">
          <span className="s-hint">
            Paste the redirect URL from your browser address bar after signing in.
          </span>
          <input value={value} onChange={(e) => setValue(e.target.value)}
                 placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                 onKeyDown={(e) => e.key === "Enter" && void completeOAuth()} />
          {err && <span className="provider-err">{err}</span>}
          <div className="s-foot">
            <button className="btn ghost small" disabled={busy} onClick={() => setOauthState(null)}>Back</button>
            <button className="btn primary" disabled={busy || !value.trim()} onClick={() => void completeOAuth()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      )}
      {open && provider.id === CLAUDE_CODE_PROVIDER_ID && (
        <div className="provider-form">
          <span className="s-hint">
            Run <code>claude setup-token</code> locally, complete the browser login, then paste the
            printed <code>CLAUDE_CODE_OAUTH_TOKEN</code> value here. Manta stores it encrypted and
            passes it to the Claude Agent SDK when Claude bridge models run.
          </span>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)}
                 placeholder="Paste CLAUDE_CODE_OAUTH_TOKEN"
                 onKeyDown={(e) => e.key === "Enter" && void connectClaude()} />
          {err && <span className="provider-err">{err}</span>}
          <div className="s-foot">
            <button className="btn primary" disabled={busy || !value.trim()} onClick={() => void connectClaude()}>
              {busy ? "Connecting…" : "Connect Claude"}
            </button>
          </div>
        </div>
      )}
      {open && provider.id !== CODEX_PROVIDER_ID && provider.id !== CLAUDE_CODE_PROVIDER_ID && (
        <div className="provider-form">
          <span className="s-hint">Paste this provider's auth JSON.</span>
          <textarea rows={5} value={value} onChange={(e) => setValue(e.target.value)} />
          {err && <span className="provider-err">{err}</span>}
          <div className="s-foot">
            <button className="btn primary" disabled={busy || !value.trim()} onClick={() => void connectJson()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
