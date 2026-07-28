import { workspaces } from "@manta/db";
import { getLinearIssue, linearTokenForWorkspace } from "../linear/client.ts";
import { ownerWorkerPresenceStatus, type OwnerWorkerPresenceStatus } from "../worker/registry.ts";

interface LinearWorkspaceSettings extends workspaces.WorkspaceSettings {
  linearProjectRepos?: Record<string, string>;
  linearTeamRepos?: Record<string, string>;
}

export async function localWorkerStatusForOwner(
  ownerUserId: string | null | undefined,
  cache: Map<string, Promise<OwnerWorkerPresenceStatus>>,
): Promise<OwnerWorkerPresenceStatus> {
  if (!ownerUserId) return "offline";
  let status = cache.get(ownerUserId);
  if (!status) {
    status = ownerWorkerPresenceStatus(ownerUserId);
    cache.set(ownerUserId, status);
  }
  return status;
}

export async function linearCardMetadataAndRepo(
  workspaceId: string,
  requestedRepo: string,
  identifier: string | undefined,
): Promise<{ repo: string; linearIssueIdentifier?: string; linearIssueUrl?: string }> {
  const issueIdentifier = identifier?.trim();
  if (!issueIdentifier) return { repo: requestedRepo };

  const token = await linearTokenForWorkspace(workspaceId).catch(() => null);
  const [issue, settings] = await Promise.all([
    token ? getLinearIssue(issueIdentifier, token).catch(() => null) : Promise.resolve(null),
    workspaces.getSettings(workspaceId) as Promise<LinearWorkspaceSettings>,
  ]);
  const mappedRepo = issue?.project?.id
    ? (settings.linearProjectRepos?.[issue.project.id] ?? settings.linearTeamRepos?.[issue.team?.id ?? ""])
    : settings.linearTeamRepos?.[issue?.team?.id ?? ""];
  return {
    repo: mappedRepo ?? requestedRepo,
    linearIssueIdentifier: issueIdentifier,
    ...(issue?.url ? { linearIssueUrl: issue.url } : {}),
  };
}
