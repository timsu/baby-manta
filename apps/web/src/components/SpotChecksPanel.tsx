import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Repo, type SpotCheckConfig, type SpotCheckRunSummary } from "../api.ts";
import { refreshTasks } from "../actions.ts";
import { addToast } from "../stores.ts";
import { dateTime, relativeDate } from "../lib/format.ts";
import { latestRunByCheck } from "../lib/spotCheckAlert.ts";

interface SpotChecksPanelProps {
  workspaceId: string;
  onClose?: () => void;
  onCountChange?: (count: number) => void;
  onOpenTask?: (taskId: string) => void;
}

function newSpotCheck(repo?: string): SpotCheckConfig {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID?.() ?? `sc-${Date.now().toString(36)}`,
    name: "",
    instructions: "",
    ...(repo ? { repo } : {}),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultSchedule(): NonNullable<SpotCheckConfig["schedule"]> {
  return {
    enabled: false,
    cadence: "hourly",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: "08:00",
    endTime: "18:00",
  };
}

function scheduleDescription(schedule: SpotCheckConfig["schedule"]): string {
  if (!schedule?.enabled) return "Manual only";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (schedule.cadence === "weekly") {
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][schedule.daysOfWeek[0] ?? 1];
    return `Weekly on ${day} at ${schedule.startTime} ${schedule.timeZone}`;
  }
  if (schedule.cadence === "daily") return `Daily at ${schedule.startTime} ${schedule.timeZone}`;
  const days = schedule.daysOfWeek.join(",") === "1,2,3,4,5"
    ? "weekdays"
    : schedule.daysOfWeek.length === 7 ? "every day" : schedule.daysOfWeek.map((day) => dayNames[day]).join(", ");
  return `Hourly, ${days} ${schedule.startTime}–${schedule.endTime} ${schedule.timeZone}`;
}

function verdictLabel(verdict: SpotCheckRunSummary["verdict"]) {
  if (verdict === "pass") return "Green";
  if (verdict === "warn") return "Yellow";
  if (verdict === "fail") return "Red";
  return "Unknown";
}

function withDefaultRepo(checks: SpotCheckConfig[], repo: string): SpotCheckConfig[] {
  if (!repo) return checks;
  return checks.map((check) => check.repo ? check : { ...check, repo });
}

export function SpotChecksPanel({ workspaceId, onClose, onCountChange, onOpenTask }: SpotChecksPanelProps) {
  const [spotChecks, setSpotChecks] = useState<SpotCheckConfig[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const runningRef = useRef(false);
  const [runs, setRuns] = useState<SpotCheckRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedIds(new Set());
    Promise.all([api.spotChecks(workspaceId), api.repos(workspaceId).catch(() => ({ repos: [] as Repo[] }))])
      .then(([spotCheckRes, repoRes]) => {
        if (cancelled) return;
        const enabledRepos = repoRes.repos.filter((repo) => repo.enabled);
        setRepos(enabledRepos);
        setSpotChecks(withDefaultRepo(spotCheckRes.spotChecks, enabledRepos[0]?.orgRepo ?? ""));
        setRuns(spotCheckRes.runs ?? []);
        onCountChange?.(spotCheckRes.spotChecks.length);
      })
      .catch((err) => addToast(err instanceof Error ? err.message : "Failed to load spot checks", "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onCountChange, workspaceId]);

  const dirtyCount = useMemo(() => spotChecks.filter((check) => check.name.trim() && check.instructions.trim()).length, [spotChecks]);
  const latestRuns = useMemo(() => latestRunByCheck(runs), [runs]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);
  const defaultRepo = repos[0]?.orgRepo ?? "";

  const updateCheck = (id: string, patch: Partial<SpotCheckConfig>) => {
    setSpotChecks((checks) => checks.map((check) => check.id === id ? { ...check, ...patch } : check));
  };

  const updateSchedule = (id: string, patch: Partial<NonNullable<SpotCheckConfig["schedule"]>>) => {
    setSpotChecks((checks) => checks.map((check) => {
      if (check.id !== id) return check;
      return { ...check, schedule: { ...(check.schedule ?? defaultSchedule()), ...patch, nextRunAt: undefined, lastError: null } };
    }));
  };

  const addSpotCheck = () => {
    const check = newSpotCheck(defaultRepo || undefined);
    setSpotChecks((checks) => [...checks, check]);
    setExpandedIds((ids) => new Set(ids).add(check.id));
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateCadence = (id: string, cadence: NonNullable<SpotCheckConfig["schedule"]>["cadence"]) => {
    updateSchedule(id, {
      cadence,
      daysOfWeek: cadence === "daily" ? [0, 1, 2, 3, 4, 5, 6] : cadence === "weekly" ? [1] : [1, 2, 3, 4, 5],
    });
  };

  const save = async (next = spotChecks) => {
    setSaving(true);
    try {
      const res = await api.updateSpotChecks(workspaceId, next);
      setSpotChecks(res.spotChecks);
      onCountChange?.(res.spotChecks.length);
      addToast("Spot checks saved", "info");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save spot checks", "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    const next = spotChecks.filter((check) => check.id !== id);
    setSpotChecks(next);
    await save(next);
  };

  const run = async (check: SpotCheckConfig) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunningId(check.id);
    try {
      const saved = await api.updateSpotChecks(workspaceId, spotChecks);
      setSpotChecks(saved.spotChecks);
      onCountChange?.(saved.spotChecks.length);
      await api.runSpotCheckStream(workspaceId, check.id, (event) => {
        if (event.type === "started") setRuns((existing) => [event.run, ...existing.filter((run) => run.id !== event.run.id)].slice(0, 50));
        if (event.type === "complete" && event.result.run) setRuns((existing) => [event.result.run!, ...existing.filter((run) => run.id !== event.result.run!.id)].slice(0, 50));
        if (event.type === "error") {
          if (event.run) setRuns((existing) => [event.run!, ...existing.filter((run) => run.id !== event.run!.id)].slice(0, 50));
          throw new Error(event.message);
        }
      });
      await refreshTasks();
      addToast("Spot check complete", "info");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Spot check failed", "error");
    } finally {
      runningRef.current = false;
      setRunningId(null);
    }
  };

  return (
    <aside className="spotchecks-panel" aria-label="Spot checks">
      <div className="spotchecks-head">
        <div>
          <div className="onboarding-eyebrow">Spot checks</div>
          <h3>Workspace checks</h3>
        </div>
        <div className="spotchecks-head-actions">
          <button className="btn small" onClick={addSpotCheck}>Add</button>
          {onClose && <button className="btn small ghost" aria-label="Close spot checks" onClick={onClose}>×</button>}
        </div>
      </div>
      <p className="spotchecks-help">
        Natural-language checks run on a worker in the selected repo and can request investigation cards with evidence links.
      </p>
      {loading ? (
        <div className="spotchecks-empty">Loading…</div>
      ) : spotChecks.length === 0 ? (
        <div className="spotchecks-empty">Add a check like “find stale PRs with failing CI” or “look for unassigned blocker issues.”</div>
      ) : (
        <div className="spotchecks-list">
          {spotChecks.map((check) => (
            <div className="spotcheck-item" key={check.id}>
              <div className="spotcheck-summary">
                <button className="spotcheck-expand" aria-expanded={expandedIds.has(check.id)} onClick={() => toggleExpanded(check.id)}>
                  <span className="spotcheck-chevron">›</span>
                  <span>
                    <strong>{check.name || "New spot check"}</strong>
                    <small>{scheduleDescription(check.schedule)}</small>
                  </span>
                </button>
                {(() => {
                  const latest = latestRuns.get(check.id);
                  if (!latest) return null;
                  return (
                    <button
                      className="spotcheck-latest"
                      title={`${latest.summary} — ${dateTime(latest.completedAt!)}`}
                      onClick={() => setSelectedRunId(latest.id)}
                    >
                      <span className={`spotcheck-verdict ${latest.verdict}`}>{verdictLabel(latest.verdict)}</span>
                      <small>{relativeDate(latest.completedAt!)}</small>
                    </button>
                  );
                })()}
                <label className="spotcheck-enabled"><input type="checkbox" checked={check.enabled !== false} onChange={(e) => updateCheck(check.id, { enabled: e.target.checked })} /> On</label>
                <button className="btn small primary" disabled={runningId !== null || saving || !check.enabled || !check.name.trim() || !check.instructions.trim()} onClick={() => void run(check)}>{runningId === check.id ? "Running…" : "Run"}</button>
              </div>
              {expandedIds.has(check.id) && (
                <div className="spotcheck-editor">
                  <input value={check.name} onChange={(e) => updateCheck(check.id, { name: e.target.value })} placeholder="Check name" />
                  {repos.length > 0 && (
                    <select value={check.repo ?? defaultRepo} onChange={(e) => updateCheck(check.id, { repo: e.target.value })}>
                      {repos.map((repo) => <option key={repo.id} value={repo.orgRepo}>{repo.orgRepo}</option>)}
                    </select>
                  )}
                  <textarea value={check.instructions} onChange={(e) => updateCheck(check.id, { instructions: e.target.value })} rows={5} placeholder="Describe what the agent should inspect and what counts as an issue…" />
                  <div className="spotcheck-schedule">
                    <label className="spotcheck-enabled"><input type="checkbox" checked={check.schedule?.enabled === true} onChange={(e) => updateSchedule(check.id, { enabled: e.target.checked })} /> Run automatically</label>
                    {check.schedule?.enabled === true && (
                      <div className="spotcheck-schedule-grid">
                        <label>Cadence <select value={check.schedule.cadence} onChange={(e) => updateCadence(check.id, e.target.value as NonNullable<SpotCheckConfig["schedule"]>["cadence"])}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
                        {check.schedule.cadence === "weekly" && <label>On <select value={check.schedule.daysOfWeek[0] ?? 1} onChange={(e) => updateSchedule(check.id, { daysOfWeek: [Number(e.target.value)] })}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
                        <label>{check.schedule.cadence === "hourly" ? "From" : "At"} <input type="time" value={check.schedule.startTime} onChange={(e) => updateSchedule(check.id, { startTime: e.target.value })} /></label>
                        {check.schedule.cadence === "hourly" && <label>Until <input type="time" value={check.schedule.endTime} onChange={(e) => updateSchedule(check.id, { endTime: e.target.value })} /></label>}
                        <label>TZ <input value={check.schedule.timeZone} onChange={(e) => updateSchedule(check.id, { timeZone: e.target.value })} /></label>
                      </div>
                    )}
                    <span>{scheduleDescription(check.schedule)}</span>
                    {check.schedule?.nextRunAt && <span>Next: {new Date(check.schedule.nextRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
                    {check.schedule?.lastError && <span className="spotcheck-schedule-error">Last error: {check.schedule.lastError}</span>}
                  </div>
                  <div className="spotcheck-actions">
                    <button className="btn small" disabled={saving || runningId !== null} onClick={() => void save()}>Save</button>
                    <button className="btn small danger" disabled={saving || runningId !== null} onClick={() => void remove(check.id)}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {spotChecks.length > 0 && <div className="spotchecks-foot">{dirtyCount} configured · open a run below to see its progress and details.</div>}
      {runs.length > 0 && (
        <div className="spotcheck-history">
          <strong>Runs</strong>
          <div className="spotcheck-runs-table-wrap">
            <table className="spotcheck-runs-table">
              <thead>
                <tr><th>Grade</th><th>Check</th><th>Summary</th><th>When</th></tr>
              </thead>
              <tbody>
                {runs.slice(0, 10).map((run) => (
                  <tr key={run.id} className={selectedRun?.id === run.id ? "selected" : ""} onClick={() => run.taskId && onOpenTask ? onOpenTask(run.taskId) : setSelectedRunId(run.id)}>
                    <td><span className={`spotcheck-verdict ${run.completedAt ? run.verdict : "running"}`}>{run.completedAt ? verdictLabel(run.verdict) : "Running"}</span></td>
                    <td>{run.spotCheckName}</td>
                    <td>
                      {run.summary}
                      {run.taskId && onOpenTask && <button className="spotcheck-open-run" onClick={(event) => { event.stopPropagation(); onOpenTask(run.taskId!); }}>Open run</button>}
                    </td>
                    <td>{new Date(run.completedAt ?? run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedRun?.completedAt && (
            <div className="spotcheck-selected-run">
              <div className="spotcheck-selected-run-head">
                <span className={`spotcheck-verdict ${selectedRun.verdict}`}>{verdictLabel(selectedRun.verdict)}</span>
                <strong>{selectedRun.spotCheckName}</strong>
              </div>
              <p>{selectedRun.summary}</p>
              <pre>{selectedRun.report}</pre>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
