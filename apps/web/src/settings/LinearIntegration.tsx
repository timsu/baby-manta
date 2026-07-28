import { useCallback, useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { api, type LinearConnection, type LinearMember, type LinearProject, type LinearStatusAutomation, type LinearTeam, type LinearWorkflowState } from "../api.ts";
import { $repos, addToast } from "../stores.ts";
import { refreshTasks } from "../actions.ts";

// Linear is a per-workspace, bring-your-own-app connector. A workspace member
// registers their own Linear OAuth app (actor=app), pastes its credentials here,
// then connects. This row walks them through: configure → connect → connected.
export function LinearIntegration({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<LinearConnection | null>(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.linearStatus(workspaceId).then(setStatus).catch(() => setStatus(null));
  }, [workspaceId]);
  useEffect(load, [load]);

  const disconnect = async () => {
    if (!confirm("Disconnect Linear? Manta stops reading issues and posting comments until you reconnect. Your saved app credentials are kept.")) return;
    setErr(null);
    try {
      await api.linearDisconnect(workspaceId);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to disconnect");
    }
  };

  const removeCreds = async () => {
    if (!confirm("Remove the saved Linear app credentials (and disconnect)? You'll need to paste them again to reconnect.")) return;
    setErr(null);
    try {
      await api.linearRemoveAppConfig(workspaceId);
      setEditing(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to remove credentials");
    }
  };

  if (!status) return null;

  const subtitle = status.connected
    ? `Connected${status.organization ? ` to ${status.organization}` : ""}${status.botName ? ` · posts as ${status.botName}` : ""}.`
    : status.appConfigured
      ? "App credentials saved. Connect to authorize the bot (actor=app — no extra seat)."
      : "Register your own Linear OAuth app, then paste its credentials to connect.";

  return (
    <>
      <div className={`integration-row ${status.connected ? "connected" : ""}`}>
        <div className="integration-info">
          <span className="integration-label">Linear</span>
          <span className="muted small">{subtitle}</span>
          {err && <span className="provider-err">{err}</span>}
        </div>
        <div className="integration-actions">
          {status.connected ? (
            <>
              <button className="btn ghost small" onClick={() => setEditing((v) => !v)}>Edit app</button>
              <button className="btn ghost small" onClick={disconnect}>Disconnect</button>
            </>
          ) : status.appConfigured ? (
            <>
              <button className="btn ghost small" onClick={() => setEditing((v) => !v)}>Edit app</button>
              <a className="btn primary small" href={api.linearConnectUrl(workspaceId)}>Connect</a>
            </>
          ) : (
            <button className="btn primary small" onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel" : "Set up"}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <LinearAppForm
          workspaceId={workspaceId}
          status={status}
          onSaved={() => { setEditing(false); load(); }}
          onRemove={status.appConfigured ? removeCreds : undefined}
        />
      )}
      {status.connected && <LinearWorkspaceControls workspaceId={workspaceId} status={status} onChanged={load} />}
    </>
  );
}

function LinearWorkspaceControls({ workspaceId, status, onChanged }: { workspaceId: string; status: LinearConnection; onChanged: () => void }) {
  const repos = useStore($repos);
  const [members, setMembers] = useState<LinearMember[]>([]);
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [projectMappings, setProjectMappings] = useState<Record<string, string>>({});
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [teamMappings, setTeamMappings] = useState<Record<string, string>>({});
  const [workflowStates, setWorkflowStates] = useState<LinearWorkflowState[]>([]);
  const [automations, setAutomations] = useState<LinearStatusAutomation[]>([]);
  const [automationHistory, setAutomationHistory] = useState<Record<string, string[]>>({});
  const [linearUserId, setLinearUserId] = useState(status.myLinearUser?.id ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLinearUserId(status.myLinearUser?.id ?? "");
  }, [status.myLinearUser?.id]);

  useEffect(() => {
    void Promise.allSettled([
      api.linearMembers(workspaceId),
      api.linearProjects(workspaceId),
      api.linearTeams(workspaceId),
      api.linearAutomation(workspaceId),
    ]).then(([membersResult, projectsResult, teamsResult, automationResult]) => {
      if (membersResult.status === "fulfilled") setMembers(membersResult.value.members);
      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value.projects);
        setProjectMappings(projectsResult.value.mappings);
      }
      if (teamsResult.status === "fulfilled") {
        setTeams(teamsResult.value.teams);
        setTeamMappings(teamsResult.value.mappings);
      }
      if (automationResult.status === "fulfilled") {
        setWorkflowStates(automationResult.value.states);
        setAutomations(automationResult.value.automations);
        setAutomationHistory(automationResult.value.history);
      }
    });
  }, [workspaceId]);

  const saveMe = async () => {
    setBusy(true);
    try {
      await api.linearSetMe(workspaceId, linearUserId || null);
      addToast("Linear user updated.", "info");
      onChanged();
      void refreshTasks();
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to update Linear user", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveProjectMappings = async () => {
    setBusy(true);
    try {
      const result = await api.linearSaveProjectMappings(workspaceId, projectMappings);
      setProjectMappings(result.mappings);
      addToast("Linear project mappings saved.", "info");
      void refreshTasks();
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to save Linear mappings", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveTeamMappings = async () => {
    setBusy(true);
    try {
      const result = await api.linearSaveTeamMappings(workspaceId, teamMappings);
      setTeamMappings(result.mappings);
      addToast("Linear team mappings saved.", "info");
      void refreshTasks();
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to save Linear team mappings", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-form linear-controls">
      <span className="s-hint">Manta uses your Linear user to show tickets assigned to you in Mine. If email auto-linking picked the wrong account or found none, choose it here.</span>
      <div className="field">
        <label>My Linear user</label>
        <select value={linearUserId} onChange={(e) => setLinearUserId(e.target.value)}>
          <option value="">Not linked</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.email}</option>)}
        </select>
      </div>
      <div className="s-foot"><button className="btn small" disabled={busy} onClick={() => void saveMe()}>Save Linear user</button></div>

      <span className="s-hint">Map Linear teams to GitHub repos so assigned tickets appear in the right swimlane. Project mappings override team mappings.</span>
      {teams.map((t) => (
        <div className="field" key={t.id}>
          <label>{t.key} — {t.name}</label>
          <select value={teamMappings[t.id] ?? ""} onChange={(e) => setTeamMappings((cur) => ({ ...cur, [t.id]: e.target.value }))}>
            <option value="">No repo</option>
            {repos.map((r) => <option key={r.id} value={r.orgRepo}>{r.orgRepo}</option>)}
          </select>
        </div>
      ))}
      {teams.length > 0 && <div className="s-foot"><button className="btn small" disabled={busy} onClick={() => void saveTeamMappings()}>Save team mappings</button></div>}

      {projects.length > 0 && <>
        <span className="s-hint">Project mappings (override team mappings for specific projects).</span>
        {projects.map((p) => (
          <div className="field" key={p.id}>
            <label>{p.name}</label>
            <select value={projectMappings[p.id] ?? ""} onChange={(e) => setProjectMappings((cur) => ({ ...cur, [p.id]: e.target.value }))}>
              <option value="">No repo</option>
              {repos.map((r) => <option key={r.id} value={r.orgRepo}>{r.orgRepo}</option>)}
            </select>
          </div>
        ))}
        <div className="s-foot"><button className="btn small" disabled={busy} onClick={() => void saveProjectMappings()}>Save project mappings</button></div>
      </>}

      <LinearAutomationControls
        workspaceId={workspaceId}
        states={workflowStates}
        automations={automations}
        history={automationHistory}
        busy={busy}
        setBusy={setBusy}
        onChanged={(next, history) => { setAutomations(next); if (history) setAutomationHistory(history); }}
      />
    </div>
  );
}

function LinearAutomationControls({
  workspaceId,
  states,
  automations,
  history,
  busy,
  setBusy,
  onChanged,
}: {
  workspaceId: string;
  states: LinearWorkflowState[];
  automations: LinearStatusAutomation[];
  history: Record<string, string[]>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: (automations: LinearStatusAutomation[], history?: Record<string, string[]>) => void;
}) {
  const [selectedStatusId, setSelectedStatusId] = useState(automations[0]?.statusId ?? "");
  const [instructions, setInstructions] = useState(automations[0]?.instructions ?? "");
  const [batchSize, setBatchSize] = useState(20);
  const [olderThanMonths, setOlderThanMonths] = useState(1);
  const [moveToStatusId, setMoveToStatusId] = useState("");

  useEffect(() => {
    const current = automations[0];
    setSelectedStatusId(current?.statusId ?? "");
    setInstructions(current?.instructions ?? "");
  }, [automations]);

  const selectedState = states.find((s) => s.id === selectedStatusId);
  const selectedAutomation = automations.find((a) => a.statusId === selectedStatusId);
  const rememberedCount = selectedStatusId ? (history[selectedStatusId]?.length ?? 0) : 0;

  useEffect(() => {
    if (selectedAutomation) setInstructions(selectedAutomation.instructions);
  }, [selectedAutomation]);

  const save = async () => {
    if (!selectedState) return;
    setBusy(true);
    try {
      const automation: LinearStatusAutomation = {
        id: selectedState.id,
        enabled: true,
        statusId: selectedState.id,
        statusName: selectedState.name,
        ...(selectedState.team ? { teamId: selectedState.team.id, teamKey: selectedState.team.key } : {}),
        instructions,
      };
      const nextAutomations = [...automations.filter((item) => item.statusId !== automation.statusId), automation];
      const result = await api.linearSaveAutomation(workspaceId, nextAutomations);
      onChanged(result.automations);
      addToast("Linear status automation saved.", "info");
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to save Linear automation", "error");
    } finally {
      setBusy(false);
    }
  };

  const runBatch = async () => {
    if (!selectedStatusId) return;
    setBusy(true);
    try {
      const result = await api.linearRunAutomationBatch(workspaceId, selectedStatusId, batchSize);
      onChanged(automations, { ...history, [selectedStatusId]: Array.from(new Set([...(history[selectedStatusId] ?? []), ...result.identifiers])) });
      addToast(result.queued ? `Queued ${result.queued} Linear items for triage.` : "No new Linear items to triage.", "info");
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to start Linear batch", "error");
    } finally {
      setBusy(false);
    }
  };

  const moveStale = async () => {
    if (!selectedStatusId || !moveToStatusId) return;
    setBusy(true);
    try {
      const result = await api.linearMoveStale(workspaceId, selectedStatusId, moveToStatusId, olderThanMonths);
      addToast(`Moved ${result.moved} stale Linear item${result.moved === 1 ? "" : "s"}.`, "info");
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to move stale Linear items", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="linear-automation">
      <h3>Auto-handle Linear status</h3>
      <span className="s-hint">Choose a workflow status, then tell Manta what to do whenever an issue enters it.</span>
      <div className="field">
        <label>Auto-handle items in</label>
        <select value={selectedStatusId} onChange={(e) => setSelectedStatusId(e.target.value)}>
          <option value="">Choose status…</option>
          {states.map((s) => <option key={s.id} value={s.id}>{s.team ? `${s.team.key} · ` : ""}{s.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Custom instructions</label>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Example: validate whether this can be closed, tag AutoValidated when safe, otherwise route to NeedsHumanQA." />
      </div>
      <div className="s-foot"><button className="btn small" disabled={busy || !selectedStatusId || !instructions.trim()} onClick={() => void save()}>Save automation</button></div>

      <div className="linear-automation-actions">
        <div className="field">
          <label>Run triage batch</label>
          <input type="number" min={1} max={100} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value) || 20)} />
          <span className="s-hint">Already remembered for this status: {rememberedCount}</span>
          <button className="btn small" disabled={busy || !selectedStatusId || !automations.length} onClick={() => void runBatch()}>Run batch</button>
        </div>
        <div className="field">
          <label>Auto-move stale items</label>
          <div className="linear-stale-row">
            <input type="number" min={1} max={60} value={olderThanMonths} onChange={(e) => setOlderThanMonths(Number(e.target.value) || 1)} />
            <span className="muted small">months old to</span>
          </div>
          <select value={moveToStatusId} onChange={(e) => setMoveToStatusId(e.target.value)}>
            <option value="">Choose destination…</option>
            {states.filter((s) => s.id !== selectedStatusId).map((s) => <option key={s.id} value={s.id}>{s.team ? `${s.team.key} · ` : ""}{s.name}</option>)}
          </select>
          <button className="btn small" disabled={busy || !selectedStatusId || !moveToStatusId} onClick={() => void moveStale()}>Move stale items</button>
        </div>
      </div>
    </div>
  );
}

function LinearAppForm({
  workspaceId,
  status,
  onSaved,
  onRemove,
}: {
  workspaceId: string;
  status: LinearConnection;
  onSaved: () => void;
  onRemove?: () => void;
}) {
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.linearSaveAppConfig(workspaceId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-form">
      <span className="s-hint">
        In Linear → Settings → API → <b>OAuth applications</b>, create an app with <b>actor=app</b> enabled.
        Register these URLs on it, then paste the app's credentials below:
        <br />Redirect URI: <code>{status.redirectUri}</code>
        <br />Webhook URL: <code>{status.webhookUrl}</code>
      </span>
      <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" />
      <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
             placeholder={status.appConfigured ? "Client secret (re-enter to update)" : "Client secret"} />
      <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)}
             placeholder="Webhook signing secret (optional)" />
      {err && <span className="provider-err">{err}</span>}
      <div className="s-foot">
        <button className="btn primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save credentials"}
        </button>
        {onRemove && <button className="btn ghost" onClick={onRemove}>Remove</button>}
      </div>
    </div>
  );
}
