import { prisma } from "./client.ts";

// ── Workspace ↔ GitHub App installation ──────────────────────────────────────
//
// The GitHub App is installed per workspace (on the user's org). We store the
// numeric installation id as a WorkspaceIdentity(github) row; it's both the
// webhook-routing key and what we mint repo-scoped tokens against.

export async function findWorkspaceByInstallation(installationId: string): Promise<string | null> {
  const identity = await prisma.workspaceIdentity.findUnique({
    where: { provider_externalId: { provider: "github", externalId: installationId } },
  });
  return identity?.workspaceId ?? null;
}

/** The installation id linked to a workspace, or null if GitHub isn't connected. */
export async function findInstallationForWorkspace(workspaceId: string): Promise<string | null> {
  const identity = await prisma.workspaceIdentity.findFirst({
    where: { workspaceId, provider: "github" },
  });
  return identity?.externalId ?? null;
}

export async function linkInstallation(workspaceId: string, installationId: string): Promise<void> {
  await prisma.workspaceIdentity.upsert({
    where: { provider_externalId: { provider: "github", externalId: installationId } },
    create: { workspaceId, provider: "github", externalId: installationId },
    update: { workspaceId },
  });
}

export async function unlinkInstallation(workspaceId: string): Promise<void> {
  await prisma.workspaceIdentity.deleteMany({ where: { workspaceId, provider: "github" } });
}

/** Remove an installation by its id (e.g. on the `installation.deleted` webhook). */
export async function unlinkInstallationById(installationId: string): Promise<void> {
  await prisma.workspaceIdentity.deleteMany({
    where: { provider: "github", externalId: installationId },
  });
}
