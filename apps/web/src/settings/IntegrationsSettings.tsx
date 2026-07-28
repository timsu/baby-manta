import { useCallback, useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { api, type GithubInstallation, type LinearConnection, type NotionConnection } from "../api.ts";
import { $me } from "../stores.ts";

export function IntegrationsSettings({ workspaceId }: { workspaceId: string }) {
  const me = useStore($me);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [gh, setGh] = useState<GithubInstallation | null>(null);
  const [linear, setLinear] = useState<LinearConnection | null>(null);
  const [notion, setNotion] = useState<NotionConnection | null>(null);
  const load = useCallback(() => {
    void api.integrations(workspaceId).then((r) => setProviders(r.providers));
    void api.githubInstallation(workspaceId).then(setGh).catch(() => setGh(null));
    void api.linearStatus(workspaceId).then(setLinear).catch(() => setLinear(null));
    void api.notionStatus(workspaceId).then(setNotion).catch(() => setNotion(null));
  }, [workspaceId]);
  useEffect(load, [load]);
  if (!providers) return <p className="muted">Loading…</p>;

  const disconnectGh = async () => {
    if (!confirm("Disconnect GitHub from this workspace? Manta loses repo access until you reconnect. This does NOT uninstall the app on GitHub.")) return;
    await api.githubDisconnect(workspaceId);
    load();
  };

  return (
    <>
      <h2>Integrations</h2>
      <div className="integrations-list">
        {/* GitHub — App installation (per workspace) */}
        <div className={`integration-row ${gh?.connected ? "connected" : ""}`}>
          <div className="integration-info">
            <span className="integration-label">GitHub</span>
            {gh?.connected
              ? <span className="muted small">Installed on {gh.account?.login} · {gh.repos.length} repos available</span>
              : <span className="muted small">Install the GitHub App on your org to connect. Required before you can add repos.</span>}
          </div>
          {gh?.connected ? (
            <div className="integration-actions">
              <a className="btn ghost small" href="https://github.com/settings/installations" target="_blank" rel="noreferrer">Manage</a>
              <button className="btn ghost small" onClick={disconnectGh}>Disconnect</button>
            </div>
          ) : (
            <a className="btn primary small" href={api.githubInstallUrl(workspaceId)}>Connect</a>
          )}
        </div>

        {/* GitHub — per-user link (powers "my PRs" on the board) */}
        <div className="integration-row sub">
          <div className="integration-info">
            <span className="integration-label">Your GitHub account</span>
            {me?.githubLogin
              ? <span className="muted small">Linked as @{me.githubLogin} — used to surface your PRs on the board.</span>
              : <span className="muted small">Link your GitHub account so the board can show your PRs.</span>}
          </div>
          {me?.githubLogin
            ? <span className="integration-badge on">@{me.githubLogin}</span>
            : <a className="btn small" href={api.githubLinkUrl()}>Link GitHub</a>}
        </div>

        {/* Slack — workspace connection (set up bots in the Slack tab) */}
        {(() => {
          const connected = providers.includes("slack");
          return (
            <div className={`integration-row ${connected ? "connected" : ""}`}>
              <div className="integration-info">
                <span className="integration-label">Slack</span>
                <span className="muted small">
                  {connected
                    ? "Connected. Manage bots in the Slack tab."
                    : "Register a bot in the Slack tab to connect your Slack workspace."}
                </span>
              </div>
              <span className={`integration-badge ${connected ? "on" : ""}`}>{connected ? "Connected" : "Not connected"}</span>
            </div>
          );
        })()}

        {/* Slack — per-user link (auto-linked by email on first message) */}
        <div className="integration-row sub">
          <div className="integration-info">
            <span className="integration-label">Your Slack account</span>
            {me?.slackUserId
              ? <span className="muted small">Linked — Manta runs your Slack requests on your board.</span>
              : <span className="muted small">Not linked. Message a Manta bot in Slack from the same email you use here ({me?.email}) and it links automatically.</span>}
          </div>
          <span className={`integration-badge ${me?.slackUserId ? "on" : ""}`}>{me?.slackUserId ? "Linked" : "Not linked"}</span>
        </div>

        {/* Linear — workspace connection (manage OAuth app and automation in the Linear tab) */}
        <div className={`integration-row ${linear?.connected ? "connected" : ""}`}>
          <div className="integration-info">
            <span className="integration-label">Linear</span>
            <span className="muted small">
              {linear?.connected
                ? `Connected${linear.organization ? ` to ${linear.organization}` : ""}. Manage app settings and automation in the Linear tab.`
                : linear?.appConfigured
                  ? "App credentials saved. Connect and manage automation in the Linear tab."
                  : "Set up the Linear app and automation in the Linear tab."}
            </span>
          </div>
          <span className={`integration-badge ${linear?.connected ? "on" : ""}`}>{linear?.connected ? "Connected" : "Not connected"}</span>
        </div>

        {/* Linear — per-user link (auto-linked by email when the workspace connects) */}
        <div className="integration-row sub">
          <div className="integration-info">
            <span className="integration-label">Your Linear account</span>
            {me?.linearUserId
              ? <span className="muted small">Linked — Manta attributes your Linear activity to you.</span>
              : <span className="muted small">Auto-links when the workspace is connected and a Linear member matches your email ({me?.email}).</span>}
          </div>
          <span className={`integration-badge ${me?.linearUserId ? "on" : ""}`}>{me?.linearUserId ? "Linked" : "Not linked"}</span>
        </div>

        <div className={`integration-row ${notion?.connected ? "connected" : ""}`}>
          <div className="integration-info">
            <span className="integration-label">Notion</span>
            <span className="muted small">
              {notion?.connected
                ? "Connected. Manage the connection and workspace instructions in the Notion tab."
                : "Connect a Notion workspace and configure important documentation links in the Notion tab."}
            </span>
          </div>
          <span className={`integration-badge ${notion?.connected ? "on" : ""}`}>{notion?.connected ? "Connected" : "Not connected"}</span>
        </div>
      </div>
    </>
  );
}
