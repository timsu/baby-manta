import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { api, type GithubInstallation } from "../api.ts";
import { $repos } from "../stores.ts";
import { refreshRepos } from "../actions.ts";
import { RepoRow } from "../components/RepoRow.tsx";

export function ReposSettings({ workspaceId }: { workspaceId: string }) {
  const repos = useStore($repos);
  const [orgRepo, setOrgRepo] = useState("");
  const [gh, setGh] = useState<GithubInstallation | null>(null);
  useEffect(() => {
    let cancelled = false;
    setGh(null);
    api.githubInstallation(workspaceId)
      .then((g) => { if (!cancelled) setGh(g); })
      .catch(() => { if (!cancelled) setGh(null); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const have = new Set(repos.map((r) => r.orgRepo));
  const available = (gh?.repos ?? []).filter((r) => !have.has(r.orgRepo));

  // Only repos exposed by the connected GitHub installation can be added.
  const addOne = async (repo: string) => {
    const picked = available.find((r) => r.orgRepo === repo.trim());
    if (!picked) return;
    await api.addRepo(workspaceId, picked.orgRepo, picked.defaultBranch);
    setOrgRepo(""); await refreshRepos();
  };

  const canAdd = available.some((r) => r.orgRepo === orgRepo.trim());

  return (
    <>
      <h2>Repos</h2>

      {gh && !gh.connected && (
        <p className="muted">
          Connect GitHub to add repos — install the app from{" "}
          <a href={api.githubInstallUrl(workspaceId)}>Integrations → GitHub</a>.
        </p>
      )}

      {gh?.connected && (available.length > 0 ? (
        <div className="repo-add">
          <input list="gh-repo-options" value={orgRepo}
                 placeholder={`Add a repo from ${gh.account?.login ?? "GitHub"}…`}
                 onChange={(e) => setOrgRepo(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && canAdd && void addOne(orgRepo)} />
          <datalist id="gh-repo-options">
            {available.map((r) => (
              <option key={r.orgRepo} value={r.orgRepo}>{r.private ? "private" : "public"}</option>
            ))}
          </datalist>
          <button className="btn primary" disabled={!canAdd} onClick={() => void addOne(orgRepo)}>Add</button>
        </div>
      ) : (
        <p className="muted">
          {repos.length > 0
            ? `All repos from ${gh.account?.login ?? "GitHub"} have been added.`
            : `No repositories available — grant the app access from Integrations → GitHub.`}
        </p>
      ))}

      {repos.length === 0 && gh?.connected && available.length > 0 && (
        <p className="muted">No repos yet — add one above.</p>
      )}
      {repos.map((r) => (
        <RepoRow key={r.id} r={r} workspaceId={workspaceId}
                 onRemove={async () => {
                   if (!confirm(`Remove ${r.orgRepo} from this workspace? Existing cards remain, but Manta will no longer create or run work for this repo until it is added again.`)) return;
                   await api.removeRepo(workspaceId, r.id);
                   await refreshRepos();
                 }} />
      ))}
    </>
  );
}
