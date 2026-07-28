import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Repo, type SlackBot, type SlackMessageSchedule, type SlackMessageScheduleCadence, type SlackMessageScheduleInput, type SlackMessageScheduleTestResult, type SpawnCardPolicy } from "../api.ts";
import { SlackBotEditor } from "./SlackBotEditor.tsx";
import { buildSlackManifest, slackEventsUrl } from "./slackManifest.ts";

type View = { kind: "list" } | { kind: "register" } | { kind: "edit"; bot: SlackBot };

export function SlackBotsSettings({ workspaceId, onOpenTask }: { workspaceId: string; onOpenTask?: (taskId: string) => void }) {
  const [bots, setBots] = useState<SlackBot[]>([]);
  const [schedules, setSchedules] = useState<SlackMessageSchedule[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });

  const load = async () => {
    await Promise.allSettled([
      api.slackBots(workspaceId).then((r) => setBots(r.bots)),
      api.slackMessageSchedules(workspaceId).then((r) => setSchedules(r.schedules)),
    ]);
  };
  useEffect(() => {
    let cancelled = false;
    api.slackBots(workspaceId).then((r) => { if (!cancelled) setBots(r.bots); }).catch(() => { /* keep the current list */ });
    api.slackMessageSchedules(workspaceId).then((r) => { if (!cancelled) setSchedules(r.schedules); }).catch(() => { /* keep the current list */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const done = async () => { await load(); setView({ kind: "list" }); };

  if (view.kind === "register") {
    return (
      <>
        <h2>Register a Slack bot</h2>
        <RegisterWizard workspaceId={workspaceId} onDone={done} onCancel={() => setView({ kind: "list" })} />
      </>
    );
  }

  if (view.kind === "edit") {
    return (
      <>
        <h2>Edit {view.bot.name}</h2>
        <SlackBotEditor workspaceId={workspaceId} bot={view.bot} onSaved={done} onCancel={() => setView({ kind: "list" })} />
      </>
    );
  }

  return (
    <>
      <h2>Slack bots</h2>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Run many bots in one Slack workspace — each with its own token, operating instructions, and
        channels. A bot resolves the Slack user to their Manta account (by email) and runs requests on
        their board.
      </p>
      {bots.map((bot) => (
        <div key={bot.id} className="channel-row">
          <div className="channel-info">
            <span className="channel-label">
              {bot.name}{" "}
              <span className="muted small">· {bot.botType}{!bot.enabled ? " · disabled" : ""}</span>
            </span>
            <span className="muted small">
              {bot.autoRespondChannels.length
                ? `auto-responds in ${bot.autoRespondChannels.length} channel${bot.autoRespondChannels.length > 1 ? "s" : ""}`
                : "mentions + DMs only"}
              {" · "}cards: {bot.spawnCardPolicy}
              {bot.defaultRepo ? ` · default repo: ${bot.defaultRepo}` : ""}
            </span>
            {bot.instructions && (
              <p className="channel-preview">{bot.instructions.slice(0, 120)}{bot.instructions.length > 120 ? "…" : ""}</p>
            )}
          </div>
          <div className="channel-actions">
            <button className="btn ghost" style={{ fontSize: 12 }}
                    onClick={() => api.updateSlackBot(workspaceId, bot.id, { enabled: !bot.enabled }).then(load)}>
              {bot.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => setView({ kind: "edit", bot })}>Edit</button>
            <button className="btn ghost" style={{ fontSize: 12 }}
                    onClick={async () => { if (confirm(`Remove ${bot.name}?`)) { await api.deleteSlackBot(workspaceId, bot.id); await load(); } }}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {bots.length === 0 && <p className="muted">No bots registered yet.</p>}
      <button className="btn primary" style={{ marginTop: 12 }} onClick={() => setView({ kind: "register" })}>
        + Register a bot
      </button>

      <ScheduledMessagesSettings workspaceId={workspaceId} bots={bots} schedules={schedules} onChange={load} onOpenTask={onOpenTask} />
    </>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function ScheduledMessagesSettings({
  workspaceId,
  bots,
  schedules,
  onChange,
  onOpenTask,
}: {
  workspaceId: string;
  bots: SlackBot[];
  schedules: SlackMessageSchedule[];
  onChange: () => Promise<void>;
  onOpenTask?: (taskId: string) => void;
}) {
  const firstBotId = bots[0]?.id ?? "";
  const [editing, setEditing] = useState<SlackMessageSchedule | null>(null);
  const [name, setName] = useState("");
  const [slackBotId, setSlackBotId] = useState(firstBotId);
  const [channelId, setChannelId] = useState("");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<SlackMessageScheduleCadence>("daily");
  const [timeOfDayUtc, setTimeOfDayUtc] = useState("09:00");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1]);
  const [timeZone, setTimeZone] = useState(BROWSER_TIME_ZONE);
  const [includeWeekendsAndHolidays, setIncludeWeekendsAndHolidays] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testComplete, setTestComplete] = useState(false);
  const [postingTest, setPostingTest] = useState(false);
  const [testPosted, setTestPosted] = useState(false);
  const [testResult, setTestResult] = useState<SlackMessageScheduleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestDraftKeyRef = useRef("");
  const testAbortRef = useRef<AbortController | null>(null);
  const testRunIdRef = useRef(0);
  const postRunIdRef = useRef(0);
  const postingTestRef = useRef(false);
  const latestTestTaskIdRef = useRef("");

  const draftData = (): SlackMessageScheduleInput => ({
    name: name.trim(),
    slackBotId,
    channelId: channelId.trim(),
    repo: repo || bots.find((bot) => bot.id === slackBotId)?.defaultRepo || repos[0]?.orgRepo || null,
    prompt: prompt.trim(),
    cadence,
    timeOfDayUtc,
    daysOfWeek: cadence === "weekly" ? daysOfWeek : [],
    timeZone,
    includeWeekendsAndHolidays,
  });

  const draftKey = () => JSON.stringify({ workspaceId, ...draftData() });

  const abortTest = useCallback(() => {
    latestDraftKeyRef.current = "";
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTesting(false);
  }, []);

  useEffect(() => {
    if (!slackBotId && firstBotId) setSlackBotId(firstBotId);
  }, [firstBotId, slackBotId]);

  useEffect(() => {
    latestDraftKeyRef.current = draftKey();
    if (testing) abortTest();
    postRunIdRef.current += 1;
    latestTestTaskIdRef.current = "";
    setTestResult(null);
    setTestComplete(false);
    setTestPosted(false);
  }, [workspaceId, name, slackBotId, channelId, repo, prompt, cadence, timeOfDayUtc, daysOfWeek, timeZone, includeWeekendsAndHolidays]);

  useEffect(() => () => abortTest(), [abortTest]);

  useEffect(() => {
    let cancelled = false;
    if (!slackBotId) {
      setChannels([]);
      return () => { cancelled = true; };
    }
    api.slackBotChannels(workspaceId, slackBotId)
      .then((r) => { if (!cancelled) setChannels(r.channels); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, [workspaceId, slackBotId]);

  useEffect(() => {
    let cancelled = false;
    api.repos(workspaceId)
      .then((res) => { if (!cancelled) setRepos(res.repos.filter((repo) => repo.enabled)); })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const reset = () => {
    abortTest();
    setEditing(null);
    setName("");
    setSlackBotId(firstBotId);
    setChannelId("");
    setRepo("");
    setPrompt("");
    setCadence("daily");
    setTimeOfDayUtc("09:00");
    setDaysOfWeek([1]);
    setTimeZone(BROWSER_TIME_ZONE);
    setIncludeWeekendsAndHolidays(false);
    setTestResult(null);
    setTestComplete(false);
    setTestPosted(false);
    setError(null);
  };

  const edit = (schedule: SlackMessageSchedule) => {
    abortTest();
    setEditing(schedule);
    setName(schedule.name);
    setSlackBotId(schedule.slackBotId);
    setChannelId(schedule.channelId);
    setRepo(schedule.repo ?? "");
    setPrompt(schedule.prompt);
    setCadence(schedule.cadence);
    setTimeOfDayUtc(schedule.timeOfDayUtc);
    setDaysOfWeek(schedule.daysOfWeek);
    setTimeZone(schedule.timeZone || BROWSER_TIME_ZONE);
    setIncludeWeekendsAndHolidays(schedule.includeWeekendsAndHolidays);
    setTestResult(null);
    setTestComplete(false);
    setTestPosted(false);
    setError(null);
  };

  const save = async () => {
    abortTest();
    setSaving(true);
    setError(null);
    try {
      const data = draftData();
      if (editing) await api.updateSlackMessageSchedule(workspaceId, editing.id, data);
      else await api.createSlackMessageSchedule(workspaceId, data);
      reset();
      await onChange();
    } catch (e) {
      setError(prettyError((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (postingTestRef.current) return;
    abortTest();
    postRunIdRef.current += 1;
    latestTestTaskIdRef.current = "";
    const controller = new AbortController();
    const runId = testRunIdRef.current + 1;
    testRunIdRef.current = runId;
    testAbortRef.current = controller;
    setTesting(true);
    setError(null);
    setTestComplete(false);
    setTestPosted(false);
    setTestResult(null);
    const testedDraftKey = draftKey();
    latestDraftKeyRef.current = testedDraftKey;
    setTestResult({ text: "", events: [], taskId: "", terminalReason: null });
    try {
      await api.streamSlackMessageScheduleTest(workspaceId, draftData(), (message) => {
        if (latestDraftKeyRef.current !== testedDraftKey || testRunIdRef.current !== runId) return;
        if (message.type === "task") {
          setTestResult((current) => ({
            text: current?.text ?? "",
            events: current?.events ?? [],
            taskId: message.taskId,
            terminalReason: current?.terminalReason ?? null,
          }));
        } else if (message.type === "event") {
          setTestResult((current) => ({
            text: `${current?.text ?? ""}${message.event.type === "text" ? message.event.text : ""}`,
            events: [...(current?.events ?? []), message.event],
            taskId: current?.taskId ?? "",
            terminalReason: current?.terminalReason ?? null,
          }));
        } else if (message.type === "result") {
          latestTestTaskIdRef.current = message.taskId;
          setTestComplete(true);
          setTestResult((current) => ({
            text: message.text,
            events: current?.events ?? [],
            taskId: message.taskId,
            terminalReason: message.terminalReason,
          }));
        } else {
          if (message.taskId) {
            setTestResult((current) => ({
              text: current?.text ?? "",
              events: current?.events ?? [],
              taskId: message.taskId ?? current?.taskId ?? "",
              terminalReason: current?.terminalReason ?? null,
            }));
          }
          setError(prettyError(message.error));
        }
      }, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (latestDraftKeyRef.current === testedDraftKey && testRunIdRef.current === runId) setError(prettyError((e as Error).message));
    } finally {
      if (testRunIdRef.current === runId) {
        testAbortRef.current = null;
        setTesting(false);
      }
    }
  };

  const postTest = async () => {
    if (postingTestRef.current || !testComplete || !testResult?.text || !testResult.taskId || testing) return;
    postingTestRef.current = true;
    const taskId = testResult.taskId;
    const runId = postRunIdRef.current + 1;
    postRunIdRef.current = runId;
    setPostingTest(true);
    setError(null);
    try {
      await api.postSlackMessageScheduleTest(workspaceId, {
        taskId,
        slackBotId,
        channelId: channelId.trim(),
      });
      if (latestTestTaskIdRef.current === taskId && postRunIdRef.current === runId) setTestPosted(true);
    } catch (e) {
      if (latestTestTaskIdRef.current === taskId && postRunIdRef.current === runId) setError(prettyError((e as Error).message));
    } finally {
      postingTestRef.current = false;
      setPostingTest(false);
    }
  };

  const channelName = (id: string) => channels.find((ch) => ch.id === id)?.name ?? id;
  const formatNextRun = (schedule: SlackMessageSchedule) => new Date(schedule.nextRunAt).toLocaleString(undefined, { timeZone: schedule.timeZone || undefined });
  const toggleWeekday = (day: number) => {
    setDaysOfWeek((current) => current.includes(day)
      ? current.length === 1 ? current : current.filter((value) => value !== day)
      : [...current, day].sort((a, b) => a - b));
  };

  return (
    <div style={{ marginTop: 28 }}>
      <h3>Scheduled messages</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Run an AI prompt daily or weekly and post the generated message into a Slack channel. Times use your local timezone by default.
      </p>

      {schedules.map((schedule) => (
        <div key={schedule.id} className="channel-row">
          <div className="channel-info">
            <span className="channel-label">
              {schedule.name}{" "}
              <span className="muted small">· {schedule.cadence}{schedule.enabled ? "" : " · disabled"}</span>
            </span>
            <span className="muted small">
              #{schedule.channelId} · {schedule.timeOfDayUtc} {schedule.timeZone || "local time"}
              {schedule.cadence === "weekly" ? ` · ${schedule.daysOfWeek.map((day) => WEEKDAYS[day]).join(", ")}` : ""}
              {schedule.includeWeekendsAndHolidays ? " · includes weekends/holidays" : " · weekdays/non-holidays"}
              {schedule.repo ? ` · repo: ${schedule.repo}` : ""}
              {" · next: "}{formatNextRun(schedule)}
            </span>
            {schedule.lastError && <span className="s-error small">Last error: {schedule.lastError}</span>}
            <p className="channel-preview">{schedule.prompt.slice(0, 140)}{schedule.prompt.length > 140 ? "…" : ""}</p>
          </div>
          <div className="channel-actions">
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => api.updateSlackMessageSchedule(workspaceId, schedule.id, { enabled: !schedule.enabled }).then(onChange)}>
              {schedule.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => edit(schedule)}>Edit</button>
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={async () => { if (confirm(`Remove ${schedule.name}?`)) { await api.deleteSlackMessageSchedule(workspaceId, schedule.id); await onChange(); } }}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {schedules.length === 0 && <p className="muted small">No scheduled messages yet.</p>}

      {bots.length === 0 ? (
        <p className="muted small">Register a Slack bot before adding scheduled messages.</p>
      ) : (
        <div className="channel-form schedule-editor-grid" style={{ marginTop: 12 }}>
          <div>
            <h4>{editing ? `Edit ${editing.name}` : "Add scheduled message"}</h4>
            <div className="s-field">
              <label>Name</label>
              <input value={name} placeholder="Weekly status digest" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="s-field">
              <label>Bot</label>
              <select value={slackBotId} onChange={(e) => { setSlackBotId(e.target.value); setChannelId(""); }}>
                {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </div>
            <div className="s-field">
              <label>Channel</label>
              <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">Choose a visible channel…</option>
                {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name} · {ch.id}</option>)}
              </select>
              <input style={{ marginTop: 8 }} value={channelId} placeholder="Or paste channel ID, e.g. C0123456789" onChange={(e) => setChannelId(e.target.value)} />
              {channelId && <span className="s-hint">Posting to #{channelName(channelId)}. Invite the bot to private channels first.</span>}
            </div>
            {repos.length > 0 && (
              <div className="s-field">
                <label>Repo checkout</label>
                <select value={repo || bots.find((bot) => bot.id === slackBotId)?.defaultRepo || repos[0]?.orgRepo || ""} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((repo) => <option key={repo.id} value={repo.orgRepo}>{repo.orgRepo}</option>)}
                </select>
                <span className="s-hint">The hidden worker runs this scheduled prompt from the selected repo checkout.</span>
              </div>
            )}
            <div className="s-field">
              <label>AI prompt</label>
              <textarea rows={5} value={prompt} placeholder="Write a concise daily standup reminder with one practical engineering tip." onChange={(e) => setPrompt(e.target.value)} />
            </div>
            <div className="s-field">
              <label>Schedule</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select value={cadence} onChange={(e) => {
                  const nextCadence = e.target.value as SlackMessageScheduleCadence;
                  if (nextCadence === "weekly" && daysOfWeek.length === 0) setDaysOfWeek([1]);
                  setCadence(nextCadence);
                }}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                {cadence === "weekly" && (
                  <div className="schedule-weekdays" role="group" aria-label="Days of week">
                    {WEEKDAYS.map((day, index) => (
                      <button key={day} type="button" className={daysOfWeek.includes(index) ? "selected" : ""} aria-pressed={daysOfWeek.includes(index)} onClick={() => toggleWeekday(index)}>
                        {day.slice(0, 3)}
                      </button>
                    ))}
                  </div>
                )}
                <input type="time" value={timeOfDayUtc} onChange={(e) => setTimeOfDayUtc(e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder={BROWSER_TIME_ZONE} />
                <button className="btn ghost" onClick={() => setTimeZone(BROWSER_TIME_ZONE)}>Use my timezone</button>
              </div>
              <label className="s-inline-label" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={includeWeekendsAndHolidays} onChange={(e) => setIncludeWeekendsAndHolidays(e.target.checked)} />
                Include weekends and US holidays
              </label>
              <span className="s-hint">Default is your browser timezone ({BROWSER_TIME_ZONE}); schedules skip weekends and US holidays unless enabled.</span>
            </div>
            {error && <p className="s-error">{error}</p>}
            <div className="s-foot">
              {editing && <button className="btn ghost" onClick={reset} disabled={saving}>Cancel edit</button>}
              <button className="btn ghost" onClick={test} disabled={saving || testing || postingTest || !name.trim() || !slackBotId || !channelId.trim() || !prompt.trim()}>
                {testing ? "Testing…" : "Test"}
              </button>
              {testing && <button className="btn ghost" onClick={abortTest} disabled={saving}>Abort test</button>}
              <button className="btn primary" onClick={save} disabled={saving || !name.trim() || !slackBotId || !channelId.trim() || !prompt.trim()}>
                {saving ? "Saving…" : editing ? "Save schedule" : "Add schedule"}
              </button>
            </div>
          </div>
          <ScheduledMessageTestPanel
            testing={testing}
            complete={testComplete}
            posting={postingTest}
            posted={testPosted}
            channelName={channelId ? channelName(channelId) : ""}
            result={testResult}
            onPost={postTest}
            onOpenTask={onOpenTask}
          />
        </div>
      )}
    </div>
  );
}

function ScheduledMessageTestPanel({ testing, complete, posting, posted, channelName, result, onPost, onOpenTask }: {
  testing: boolean;
  complete: boolean;
  posting: boolean;
  posted: boolean;
  channelName: string;
  result: SlackMessageScheduleTestResult | null;
  onPost: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const process = result?.events.filter((event) => event.type === "thinking" || event.type === "tool_use" || event.type === "tool_result" || event.type === "done" || event.type === "error") ?? [];
  return (
    <aside className="schedule-test-panel">
      <div className="schedule-test-heading">
        <h4>Test preview</h4>
        <span className="muted small">Preview only</span>
      </div>
      {result ? (
        <>
          {result.taskId && (
            <button className="btn ghost" style={{ alignSelf: "flex-start", fontSize: 12 }} onClick={() => onOpenTask?.(result.taskId)}>
              Open debug task
            </button>
          )}
          <div className="schedule-test-process">
            {process.length === 0 ? <span className="muted small">{testing ? "Running the scheduled-message AI flow…" : "Generated directly without tools."}</span> : process.map((event, index) => (
              <div key={index} className="schedule-test-step">
                {event.type === "thinking" && <>Thinking: {event.text}</>}
                {event.type === "tool_use" && <>Using <code>{event.toolName}</code>{event.argsPreview ? ` with ${event.argsPreview}` : ""}</>}
                {event.type === "tool_result" && <>{event.ok ? "Tool result" : "Tool failed"}{event.preview ? `: ${event.preview}` : ""}</>}
                {event.type === "done" && <>Finished{event.reason ? `: ${event.reason}` : ""}</>}
                {event.type === "error" && <>Error: {event.message}</>}
              </div>
            ))}
          </div>
          <label className="schedule-test-output-label">Message output</label>
          <pre className="schedule-test-output">{result.text || (testing ? "Generating…" : "")}</pre>
          {!testing && complete && result.text && (
            <div className="schedule-test-actions">
              <button className="btn primary" onClick={onPost} disabled={posting || posted}>
                {posting ? "Posting…" : posted ? "Posted to Slack" : "Post to Slack"}
              </button>
              <span className={posted ? "small" : "muted small"}>
                {posted ? `Posted to #${channelName}.` : `Posts this exact preview to #${channelName}.`}
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="schedule-test-empty">Use Test to see what the AI would do and the Slack message it would produce.</div>
      )}
    </aside>
  );
}

function RegisterWizard({
  workspaceId,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [policy, setPolicy] = useState<SpawnCardPolicy>("auto");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [defaultRepo, setDefaultRepo] = useState("");
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.repos(workspaceId)
      .then((r) => { if (!cancelled) setRepos(r.repos.filter((repo) => repo.enabled)); })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const manifest = buildSlackManifest(name);
  const copyManifest = async () => {
    await navigator.clipboard.writeText(manifest).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const register = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.createSlackBot(workspaceId, {
        name: name.trim(),
        instructions,
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim(),
        spawnCardPolicy: policy,
        defaultRepo: defaultRepo || null,
      });
      onDone();
    } catch (e) {
      setError(prettyError((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="channel-form">
      <ol className="slack-steps muted small">
        <li className={step === 1 ? "on" : ""}>1. Describe the bot</li>
        <li className={step === 2 ? "on" : ""}>2. Create the Slack app</li>
        <li className={step === 3 ? "on" : ""}>3. Paste credentials</li>
      </ol>

      {step === 1 && (
        <>
          <div className="s-field">
            <label>Name</label>
            <input value={name} placeholder="Support Bot" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="s-field">
            <label>Operating instructions</label>
            <textarea rows={6} value={instructions}
                      placeholder="You are an on-call support bot. Triage questions, spawn cards for code changes…"
                      onChange={(e) => setInstructions(e.target.value)} />
            <span className="s-hint">This bot's system prompt. Leave blank to use the workspace brain instructions.</span>
          </div>
          <div className="s-field">
            <label>When to spawn a card</label>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as SpawnCardPolicy)}>
              <option value="auto">Auto — decide per request</option>
              <option value="never">Never — always answer inline</option>
            </select>
          </div>
          <div className="s-field">
            <label>Default repo</label>
            <select value={defaultRepo} onChange={(e) => setDefaultRepo(e.target.value)}>
              <option value="">No default — ask or infer from the request</option>
              {repos.map((repo) => <option key={repo.id} value={repo.orgRepo}>{repo.orgRepo}</option>)}
            </select>
            <span className="s-hint">Used when a Slack request does not name a repo.</span>
          </div>
          <div className="s-foot">
            <button className="btn ghost" onClick={onCancel}>Cancel</button>
            <button className="btn primary" onClick={() => setStep(2)} disabled={!name.trim()}>Next</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted small">
            Create the Slack app from this manifest — it pre-fills every permission and points Slack's
            events at Manta. Open{" "}
            <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">api.slack.com/apps</a>{" "}
            → <strong>Create New App</strong> → <strong>From a manifest</strong> → pick your workspace →
            paste:
          </p>
          <pre className="slack-manifest">{manifest}</pre>
          <button className="btn ghost" onClick={copyManifest}>{copied ? "Copied!" : "Copy manifest"}</button>
          <p className="muted small" style={{ marginTop: 12 }}>
            Then <strong>Install to Workspace</strong>, and from the app's{" "}
            <strong>OAuth &amp; Permissions</strong> page copy the <strong>Bot User OAuth Token</strong>{" "}
            (<code className="inline-code">xoxb-…</code>), and from <strong>Basic Information</strong> copy
            the <strong>Signing Secret</strong>. Events go to{" "}
            <code className="inline-code">{slackEventsUrl()}</code>.
          </p>
          <p className="muted small">
            DMs to the bot work out of the box — the manifest enables its Messages tab. (For an app that
            shows "sending messages turned off," flip it on under <strong>App Home → Show Tabs →
            Messages Tab → Allow users to send messages</strong>.)
          </p>
          <div className="s-foot">
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary" onClick={() => setStep(3)}>Next</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="s-field">
            <label>Bot User OAuth Token</label>
            <input type="password" autoComplete="off" value={botToken} placeholder="xoxb-…" onChange={(e) => setBotToken(e.target.value)} />
          </div>
          <div className="s-field">
            <label>Signing Secret</label>
            <input type="password" autoComplete="off" value={signingSecret} placeholder="from Basic Information" onChange={(e) => setSigningSecret(e.target.value)} />
          </div>
          {error && <p className="s-error">{error}</p>}
          <div className="s-foot">
            <button className="btn ghost" onClick={() => setStep(2)} disabled={saving}>Back</button>
            <button className="btn primary" onClick={register} disabled={saving || !botToken.trim() || !signingSecret.trim()}>
              {saving ? "Verifying…" : "Register bot"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function prettyError(code: string): string {
  switch (code) {
    case "invalid_bot_token": return "That bot token didn't validate with Slack. Make sure you installed the app and copied the xoxb- token.";
    case "bot_already_registered": return "This Slack app is already registered in a workspace.";
    case "bot_token_required": return "Bot token is required.";
    case "signing_secret_required": return "Signing secret is required.";
    case "slack_bot_required": return "Choose a Slack bot.";
    case "slack_bot_not_found": return "That Slack bot no longer exists.";
    case "slack_bot_unavailable": return "That Slack bot is unavailable or disabled.";
    case "slack_post_failed": return "Slack could not post the preview. Check the bot's channel access and try again.";
    case "completed_test_not_found": return "That completed test is no longer available. Run the test again before posting.";
    case "channel_required": return "Choose or paste a Slack channel ID.";
    case "prompt_required": return "Prompt is required.";
    case "invalid_time_of_day": return "Choose a valid local time.";
    case "invalid_time_zone": return "Choose a valid IANA timezone, like America/Los_Angeles.";
    case "invalid_days_of_week": return "Choose at least one day for weekly schedules.";
    case "weekend_days_require_inclusion": return "Turn on weekend and holiday inclusion to use a weekend-only schedule.";
    default: return code;
  }
}
