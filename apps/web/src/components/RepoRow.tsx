import { useState } from "react";
import { api, type Repo, type SkillRepoConfig } from "../api.ts";

function normalizeSkillRepos(entries: SkillRepoConfig[]): SkillRepoConfig[] {
  return entries
    .map((entry) => ({ repo: entry.repo.trim(), path: entry.path?.trim() || undefined }))
    .filter((entry) => entry.repo);
}

export function RepoRow({ r, workspaceId, onRemove }: { r: Repo; workspaceId: string; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [setupCommands, setSetupCommands] = useState(r.setupCommands);
  const [globalInstructions, setGlobalInstructions] = useState(r.globalInstructions);
  const [skillRepos, setSkillRepos] = useState<SkillRepoConfig[]>(r.skillRepos ?? []);
  const [personalInstructions, setPersonalInstructions] = useState("");
  const [personalExpanded, setPersonalExpanded] = useState(false);
  const [personalLoaded, setPersonalLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [personalSaving, setPersonalSaving] = useState(false);
  const [personalSaved, setPersonalSaved] = useState(false);

  const toggle = () => setExpanded((v) => !v);

  const loadPersonal = async () => {
    if (!personalLoaded) {
      const p = await api.getRepoPersonal(workspaceId, r.id);
      setPersonalInstructions(p.instructions);
      setPersonalLoaded(true);
    }
    setPersonalExpanded((v) => !v);
  };

  const save = async () => {
    setSaving(true);
    try {
      const normalizedSkillRepos = normalizeSkillRepos(skillRepos);
      await api.updateRepo(workspaceId, r.id, { setupCommands, globalInstructions, skillRepos: normalizedSkillRepos });
      setSkillRepos(normalizedSkillRepos);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const savePersonal = async () => {
    setPersonalSaving(true);
    try {
      await api.updateRepoPersonal(workspaceId, r.id, personalInstructions);
      setPersonalSaved(true);
      setTimeout(() => setPersonalSaved(false), 2000);
    } finally { setPersonalSaving(false); }
  };

  const updateSkillRepo = (i: number, patch: Partial<SkillRepoConfig>) =>
    setSkillRepos((prev) => prev.map((e, idx) => idx === i ? { ...e, ...patch } : e));

  const removeSkillRepo = (i: number) =>
    setSkillRepos((prev) => prev.filter((_, idx) => idx !== i));

  const addSkillRepo = () =>
    setSkillRepos((prev) => [...prev, { repo: "", path: "" }]);

  return (
    <>
      <div className="repo-row" onClick={toggle} style={{ cursor: "pointer" }}>
        <span className="repo-toggle">{expanded ? "▼" : "▶"}</span>
        <span className="repo-row-name">{r.orgRepo} <span className="muted small">· {r.defaultBranch}</span></span>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onRemove(); }}>Remove</button>
      </div>
      {expanded && (
        <div className="repo-detail">
          <div className="s-field">
            <label>Setup commands</label>
            <textarea rows={3} value={setupCommands} onChange={(e) => setSetupCommands(e.target.value)}
                      placeholder="e.g. pnpm install" />
          </div>
          <div className="s-field">
            <label>Global instructions</label>
            <textarea rows={4} value={globalInstructions} onChange={(e) => setGlobalInstructions(e.target.value)}
                      placeholder="Shared instructions for all agents on this repo." />
          </div>
          <div className="s-field">
            <label>Skill repos</label>
            {skillRepos.map((entry, i) => (
              <div key={i} className="skill-repo-row">
                <input
                  value={entry.repo}
                  onChange={(e) => updateSkillRepo(i, { repo: e.target.value })}
                  placeholder="org/repo"
                  style={{ flex: 2 }}
                />
                <input
                  value={entry.path ?? ""}
                  onChange={(e) => updateSkillRepo(i, { path: e.target.value || undefined })}
                  placeholder="subdir (optional)"
                  style={{ flex: 1 }}
                />
                <button className="btn ghost" onClick={() => removeSkillRepo(i)}>×</button>
              </div>
            ))}
            <button className="btn ghost" onClick={addSkillRepo} style={{ marginTop: 4 }}>+ Add skill repo</button>
          </div>
          <div className="repo-detail-foot">
            {saved && <span className="muted small">Saved ✓</span>}
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      )}
      <div className="repo-personal">
        <button className="repo-personal-toggle" onClick={loadPersonal}>
          {personalExpanded ? "▼" : "▶"} Personal instructions
        </button>
        {personalExpanded && (
          <>
            <textarea rows={4} value={personalInstructions} onChange={(e) => setPersonalInstructions(e.target.value)}
                      placeholder="Your personal notes and preferences for this repo." />
            <div className="repo-detail-foot">
              {personalSaved && <span className="muted small">Saved ✓</span>}
              <button className="btn primary" onClick={savePersonal} disabled={personalSaving}>{personalSaving ? "Saving…" : "Save"}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
