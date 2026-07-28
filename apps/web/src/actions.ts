import { api } from "./api.ts";
import {
  $me,
  $activeWorkspaceId,
  $cards,
  $repos,
  $githubPrs,
  $linearTickets,
  $chat,
  $members,
  $openTaskId,
  resetAllTaskChats,
  $lastTaskUpdated,
  $workspaceModels,
  $workspaceDefaultModel,
} from "./stores.ts";
import { connectWs } from "./ws.ts";

// ─────────────────────────── data actions ───────────────────────────

export async function loadMe() {
  const me = await api.me();
  $me.set(me);
  const first = me?.memberships[0];
  if (me && first && !$activeWorkspaceId.get()) await selectWorkspace(first.workspaceId);
}

export async function selectWorkspace(id: string) {
  $activeWorkspaceId.set(id);
  $chat.set([]);
  $openTaskId.set(null);
  resetAllTaskChats();
  $lastTaskUpdated.set(null);
  $workspaceModels.set([]);
  $workspaceDefaultModel.set(null);
  connectWs(id, () => void refreshTasks()); // live: streams brain turns + board updates
  await Promise.all([refreshTasks(), refreshRepos(), refreshMembers(), refreshModels(id)]);
}

export async function refreshMembers() {
  const id = $activeWorkspaceId.get();
  if (id) $members.set((await api.members(id)).members);
}

export async function refreshTasks() {
  const id = $activeWorkspaceId.get();
  if (!id) return;
  const [tasksResult, prsResult, linearResult] = await Promise.allSettled([api.tasks(id), api.githubPrs(id), api.linearMyIssues(id)]);
  if (tasksResult.status === "fulfilled") $cards.set(tasksResult.value.tasks);
  if (prsResult.status === "fulfilled") $githubPrs.set(prsResult.value.prs);
  if (linearResult.status === "fulfilled") $linearTickets.set(linearResult.value.issues);
}
export async function refreshRepos() {
  const id = $activeWorkspaceId.get();
  if (id) $repos.set((await api.repos(id)).repos);
}

export async function refreshModels(workspaceId?: string) {
  const id = workspaceId ?? $activeWorkspaceId.get();
  if (!id) return;
  const result = await api.models(id).catch(() => null);
  if (result && $activeWorkspaceId.get() === id) {
    $workspaceDefaultModel.set(result.defaultModel);
    $workspaceModels.set(result.models);
  }
}

export async function newWorkspace(name: string) {
  const ws = await api.createWorkspace(name);
  await loadMe();
  await selectWorkspace(ws.id);
}
