import { useEffect, useState } from "react";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";
import { ReposSettings } from "./ReposSettings.tsx";
import { SlackBotsSettings } from "./SlackBotsSettings.tsx";
import { LinearIntegration } from "./LinearIntegration.tsx";
import { IntegrationsSettings } from "./IntegrationsSettings.tsx";
import { MembersSettings } from "./MembersSettings.tsx";
import { AccountProviders } from "./AccountProviders.tsx";
import { NotionIntegration } from "./NotionIntegration.tsx";

export type SettingsTab = "general" | "models" | "repos" | "slack" | "linear" | "notion" | "members" | "integrations" | "account";
const WORKSPACE_NAV: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "models", label: "Models" },
  { id: "repos", label: "Repos" },
  { id: "slack", label: "Slack" },
  { id: "linear", label: "Linear" },
  { id: "notion", label: "Notion" },
  { id: "integrations", label: "Integrations" },
  { id: "members", label: "Members" },
];
const ACCOUNT_NAV: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "My subscription" },
];

export function SettingsView({ workspaceId, onClose, onOpenTask, initialTab = "general" }: { workspaceId: string; onClose: () => void; onOpenTask?: (taskId: string) => void; initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <div className="settings-layout">
      <button className="btn ghost icon-btn settings-close" title="Close settings" aria-label="Close settings" onClick={onClose}>✕</button>
      <nav className="settings-nav">
        <div className="settings-nav-label">Workspace</div>
        {WORKSPACE_NAV.map((item) => (
          <button key={item.id} className={`settings-nav-item ${tab === item.id ? "on" : ""}`}
                  onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
        <div className="settings-nav-label" style={{ marginTop: 16 }}>Account</div>
        {ACCOUNT_NAV.map((item) => (
          <button key={item.id} className={`settings-nav-item ${tab === item.id ? "on" : ""}`}
                  onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      <div className={`settings-panel ${tab === "slack" || tab === "linear" || tab === "notion" ? "settings-panel--wide" : ""}`}>
        {tab === "general" && <GeneralSettings workspaceId={workspaceId} />}
        {tab === "models" && <ModelsSettings workspaceId={workspaceId} />}
        {tab === "repos" && <ReposSettings workspaceId={workspaceId} />}
        {tab === "slack" && <SlackBotsSettings workspaceId={workspaceId} onOpenTask={onOpenTask} />}
        {tab === "linear" && <LinearSettings workspaceId={workspaceId} />}
        {tab === "notion" && <NotionSettings workspaceId={workspaceId} />}
        {tab === "integrations" && <IntegrationsSettings workspaceId={workspaceId} />}
        {tab === "members" && <MembersSettings workspaceId={workspaceId} />}
        {tab === "account" && <AccountProviders />}
      </div>
    </div>
  );
}

function NotionSettings({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <h2>Notion</h2>
      <NotionIntegration workspaceId={workspaceId} />
    </>
  );
}

function LinearSettings({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <h2>Linear</h2>
      <div className="integrations-list">
        <LinearIntegration workspaceId={workspaceId} />
      </div>
    </>
  );
}
