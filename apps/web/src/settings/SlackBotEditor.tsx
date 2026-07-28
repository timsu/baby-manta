import { useEffect, useState } from "react";
import { api, type Repo, type SlackBot, type SpawnCardPolicy } from "../api.ts";

function normalizeSlackChannelId(value: string): string {
  // Accept raw channel IDs as well as Slack's copied channel mention format
  // (<#C0123456789|support>) when users add a channel manually.
  const trimmed = value.trim();
  const mention = trimmed.match(/^<#([^>|]+)(?:\|[^>]+)?>$/);
  return mention?.[1] ?? trimmed.replace(/^#/, "");
}

function uniqueChannelIds(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeSlackChannelId).filter(Boolean)));
}

/** Edit an existing bot: instructions, auto-respond channels, card policy,
 * enabled, and optional token/secret rotation. */
export function SlackBotEditor({
  workspaceId,
  bot,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  bot: SlackBot;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [policy, setPolicy] = useState<SpawnCardPolicy>(bot.spawnCardPolicy);
  const [defaultRepo, setDefaultRepo] = useState(bot.defaultRepo ?? "");
  const [channels, setChannels] = useState<string[]>(() => uniqueChannelIds(bot.autoRespondChannels));
  const [channelInstructions, setChannelInstructions] = useState<Record<string, string>>(bot.autoRespondChannelInstructions ?? {});
  const [available, setAvailable] = useState<{ id: string; name: string }[]>([]);
  const [channelsWarning, setChannelsWarning] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [manualChannel, setManualChannel] = useState("");
  const [rotateToken, setRotateToken] = useState("");
  const [rotateSecret, setRotateSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.slackBotChannels(workspaceId, bot.id)
      .then((r) => { if (!cancelled) { setAvailable(r.channels); setChannelsWarning(r.warning ?? null); } })
      .catch(() => { /* channel listing is best-effort */ });
    api.repos(workspaceId)
      .then((r) => { if (!cancelled) setRepos(r.repos.filter((repo) => repo.enabled)); })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, [workspaceId, bot.id]);

  const toggleChannel = (id: string) => {
    setChannels((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : uniqueChannelIds([...prev, id])));
    if (channels.includes(id)) {
      setChannelInstructions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const addManual = () => {
    const id = normalizeSlackChannelId(manualChannel);
    if (id && !channels.includes(id)) setChannels((prev) => uniqueChannelIds([...prev, id]));
    setManualChannel("");
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const selectedChannels = uniqueChannelIds(channels);
      await api.updateSlackBot(workspaceId, bot.id, {
        name: name.trim(),
        instructions,
        spawnCardPolicy: policy,
        defaultRepo: defaultRepo || null,
        autoRespondChannels: selectedChannels,
        autoRespondChannelInstructions: channelInstructions,
        ...(rotateToken.trim() ? { botToken: rotateToken.trim() } : {}),
        ...(rotateSecret.trim() ? { signingSecret: rotateSecret.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Channels selected but not in the fetched list (manually entered / bot not a member).
  const extraChannels = channels.filter((id) => !available.some((ch) => ch.id === id));
  const channelName = (id: string) => available.find((ch) => ch.id === id)?.name ?? id;

  return (
    <div className="channel-form">
      <div className="s-field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="s-field">
        <label>Operating instructions</label>
        <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                  placeholder="You are an on-call support bot. Triage questions, spawn cards for code changes…" />
        <span className="s-hint">This bot's system prompt. Leave blank to fall back to the workspace brain instructions.</span>
      </div>
      <div className="s-field">
        <label>When to spawn a card</label>
        <select value={policy} onChange={(e) => setPolicy(e.target.value as SpawnCardPolicy)}>
          <option value="auto">Auto — decide per request (answer simple questions, card for real work)</option>
          <option value="never">Never — always answer inline, never create a card</option>
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
      <div className="s-field">
        <label>Auto-respond channels</label>
        <span className="s-hint">Channels where the bot replies to every message. It always replies to DMs and @-mentions regardless.</span>
        <div className="slack-channel-picker">
          {available.map((ch) => (
            <div key={ch.id}>
              <label className="s-inline-label">
                <input type="checkbox" checked={channels.includes(ch.id)} onChange={() => toggleChannel(ch.id)} />
                #{ch.name} <span className="muted small">{ch.id}</span>
              </label>
            </div>
          ))}
          {extraChannels.map((id) => (
            <div key={id}>
              <label className="s-inline-label">
                <input type="checkbox" checked onChange={() => toggleChannel(id)} />
                <span className="muted small">{id}</span>
              </label>
            </div>
          ))}
          {available.length === 0 && extraChannels.length === 0 && !channelsWarning && (
            <span className="muted small">No channels found. Invite the bot to a channel, or add a channel ID below.</span>
          )}
        </div>
        {channelsWarning && (
          <span className="s-hint">
            {channelsWarning === "missing_scope"
              ? "Couldn't load channel names — the bot token is missing the channels:read / groups:read scopes (its scopes predate them). Reinstall the Slack app, then rotate the token below."
              : `Couldn't load channel names from Slack (${channelsWarning}). Channels show as raw IDs until this is resolved.`}
          </span>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={manualChannel} placeholder="C0123456789" onChange={(e) => setManualChannel(e.target.value)} />
          <button className="btn ghost" onClick={addManual}>Add ID</button>
        </div>
        {channels.length > 0 && (
          <div className="slack-channel-instructions">
            <label>Per-channel instructions</label>
            <span className="s-hint">Optional. Appended only for auto-response turns in that channel; use this for workflows like #support.</span>
            {channels.map((id) => (
              <div key={id} className="s-field">
                <label>#{channelName(id)} <span className="muted small">{id}</span></label>
                <textarea
                  rows={4}
                  value={channelInstructions[id] ?? ""}
                  placeholder="Example: In #support, create a Linear issue for bugs, apply the Bug label, spawn a triage worker, and assign the most relevant engineer."
                  onChange={(e) => setChannelInstructions((prev) => ({ ...prev, [id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="s-field">
        <summary className="muted small">Rotate token / signing secret</summary>
        <div className="s-field" style={{ marginTop: 8 }}>
          <label>New Bot User OAuth Token</label>
          <input type="password" autoComplete="off" value={rotateToken} placeholder="xoxb-… (leave blank to keep)" onChange={(e) => setRotateToken(e.target.value)} />
        </div>
        <div className="s-field">
          <label>New Signing Secret</label>
          <input type="password" autoComplete="off" value={rotateSecret} placeholder="leave blank to keep" onChange={(e) => setRotateSecret(e.target.value)} />
        </div>
      </details>
      {error && <p className="s-error">{error}</p>}
      <div className="s-foot">
        <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
