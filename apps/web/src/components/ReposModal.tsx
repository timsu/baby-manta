import { useState } from "react";
import { useStore } from "@nanostores/react";
import { api } from "../api.ts";
import { $activeWorkspaceId, $repos } from "../stores.ts";
import { refreshRepos } from "../actions.ts";
import { Modal } from "./ui.tsx";
import { RepoRow } from "./RepoRow.tsx";

function ReposModal({ onClose }: { onClose: () => void }) {
  const repos = useStore($repos);
  const [orgRepo, setOrgRepo] = useState("");
  const workspaceId = $activeWorkspaceId.get()!;
  const add = async () => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(orgRepo)) return;
    await api.addRepo(workspaceId, orgRepo.trim());
    setOrgRepo("");
    await refreshRepos();
  };
  return (
    <Modal title="Repos" onClose={onClose}>
      <div className="repo-add">
        <input value={orgRepo} placeholder="org/repo (e.g. acme/platform)" autoFocus
               onChange={(e) => setOrgRepo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button className="btn primary" onClick={add}>Add</button>
      </div>
      {repos.length === 0 && <p className="muted">No repos yet — add one above.</p>}
      {repos.map((r) => (
        <RepoRow key={r.id} r={r} workspaceId={workspaceId}
                 onRemove={async () => { await api.removeRepo(workspaceId, r.id); await refreshRepos(); }} />
      ))}
    </Modal>
  );
}
