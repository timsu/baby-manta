import { prisma } from "./client.ts";
import type { User } from "../generated/client/index.js";

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

/** Upsert a user by their Google subject id, refreshing profile fields. */
export function upsertByGoogle(p: GoogleProfile): Promise<User> {
  return prisma.user.upsert({
    where: { googleSub: p.googleSub },
    create: {
      googleSub: p.googleSub,
      email: p.email,
      ...(p.name ? { name: p.name } : {}),
      ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
    },
    update: {
      email: p.email,
      ...(p.name ? { name: p.name } : {}),
      ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
    },
  });
}

export function byId(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export function byEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function bySlackUserId(slackUserId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { slackUserId } });
}

/** Link a Slack identity to a Manta user. Auto-called the first time a Slack
 * message resolves (by email) to a user that isn't linked yet. */
export async function setSlack(userId: string, slackUserId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { slackUserId } });
}

export function byLinearUserId(linearUserId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { linearUserId } });
}

/** Link a Linear identity to a Manta user. Auto-called when a connected Linear
 * workspace's member email matches this user's email. */
export async function setLinear(
  userId: string,
  linear: { linearUserId: string; linearName?: string },
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { linearUserId: linear.linearUserId, ...(linear.linearName ? { linearName: linear.linearName } : {}) },
  });
}

/** Store the user's GitHub identity, captured via the "Link GitHub" OAuth flow. */
export async function setGithub(
  userId: string,
  github: { login: string; githubUserId: string },
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { githubLogin: github.login, githubUserId: github.githubUserId },
  });
}

/** Persist the user's local-worker onboarding dismissal preference. */
export async function setLocalWorkerOnboardingDismissed(
  userId: string,
  dismissed: boolean,
): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: { localWorkerOnboardingDismissed: dismissed },
  });
}

/** Persist whether this user should be treated as a non-engineer for PR review routing. */
export async function setNonEngineer(userId: string, nonEngineer: boolean): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: { nonEngineer },
  });
}

/** A user's workspace memberships (id, slug, name, role) for the session/me view. */
export async function membershipsFor(userId: string): Promise<
  Array<{ workspaceId: string; slug: string; name: string; role: string }>
> {
  const rows = await prisma.membership.findMany({
    where: { userId },
    include: { workspace: { select: { slug: true, name: true } } },
  });
  return rows.map((m) => ({
    workspaceId: m.workspaceId,
    slug: m.workspace.slug,
    name: m.workspace.name,
    role: m.role,
  }));
}
