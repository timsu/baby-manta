import { prisma } from "./client.ts";
import type { Workspace, Membership, Role } from "../generated/client/index.js";

export interface CreateWorkspaceInput {
  slug: string;
  name: string;
  brainPrompt?: string;
}

export function create(input: CreateWorkspaceInput): Promise<Workspace> {
  return prisma.workspace.create({
    data: {
      slug: input.slug,
      name: input.name,
      brainPrompt: input.brainPrompt ?? "",
    },
  });
}

export function bySlug(slug: string): Promise<Workspace | null> {
  return prisma.workspace.findUnique({ where: { slug } });
}

export function byId(id: string): Promise<Workspace | null> {
  return prisma.workspace.findUnique({ where: { id } });
}

/** Add a user to a workspace (idempotent on the unique (userId, workspaceId)). */
export function addMember(workspaceId: string, userId: string, role: Role = "member"): Promise<Membership> {
  return prisma.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: { userId, workspaceId, role },
    update: { role },
  });
}

/** Whether a user is a member of a workspace (authorization check). */
export async function isMember(userId: string, workspaceId: string): Promise<boolean> {
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return m !== null;
}

/** A user's role in a workspace, or null if not a member. */
export async function roleFor(userId: string, workspaceId: string): Promise<Role | null> {
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

export function update(
  id: string,
  data: { name?: string; brainPrompt?: string; teamMemory?: string },
): Promise<Workspace> {
  return prisma.workspace.update({ where: { id }, data });
}

/** Workspace-level model/provider configuration, persisted in the `settings`
 * JSON column. `defaultModel` is the backend id used for brain turns and new
 * cards; `cardModels` are extra backend ids offered in the new-card picker. */
export interface WorkspaceSettings {
  /** Backend id (e.g. "pi-openai-codex:gpt-5.5") for brain + new-card default. */
  defaultModel?: string;
  /** Backend id for the background Scout triage pass. Falls back to a cheap
   *  available model, then the brain default, when unset. */
  scoutModel?: string;
  /** Extra backend ids to surface in the new-card model picker. */
  cardModels?: string[];
  /** Linear project id → GitHub org/repo slug, used to place assigned Linear tickets in repo swimlanes. */
  linearProjectRepos?: Record<string, string>;
  /** Durable guidance for agents using the workspace's Notion connection. */
  notionInstructions?: string;
  /** Workspace-configured natural-language spot checks shown on the board. */
  spotChecks?: WorkspaceSpotCheck[];
}

export interface WorkspaceSpotCheck {
  id: string;
  name: string;
  instructions: string;
  repo?: string;
  enabled?: boolean;
  schedule?: WorkspaceSpotCheckSchedule;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceSpotCheckSchedule {
  enabled?: boolean;
  /** How often the check runs within its local schedule. */
  cadence?: "hourly" | "daily" | "weekly";
  /** IANA time zone used for the local schedule window. */
  timeZone?: string;
  /** Local weekdays, where 0 is Sunday and 6 is Saturday. */
  daysOfWeek?: number[];
  /** Local inclusive start time in HH:mm. */
  startTime?: string;
  /** Local exclusive end time in HH:mm. */
  endTime?: string;
  /** Legacy cadence value retained for reading existing schedules. */
  intervalMinutes?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
}

export async function getSettings(id: string): Promise<WorkspaceSettings> {
  const ws = await prisma.workspace.findUnique({ where: { id }, select: { settings: true } });
  return ((ws?.settings as WorkspaceSettings | null) ?? {}) as WorkspaceSettings;
}

export async function updateSettings(
  id: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const current = await getSettings(id);
  const next: WorkspaceSettings = { ...current, ...patch };
  await prisma.workspace.update({ where: { id }, data: { settings: next as object } });
  return next;
}

export function listMembers(workspaceId: string) {
  return prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, email: true, name: true, avatarUrl: true, githubLogin: true, nonEngineer: true } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Create a workspace and make `ownerId` its owner, in one transaction. */
export async function createWithOwner(
  input: CreateWorkspaceInput & { ownerId: string },
): Promise<Workspace> {
  return prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: { slug: input.slug, name: input.name, brainPrompt: input.brainPrompt ?? "" },
    });
    await tx.membership.create({ data: { userId: input.ownerId, workspaceId: ws.id, role: "owner" } });
    return ws;
  });
}
