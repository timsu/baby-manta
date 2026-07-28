import { prisma } from "./client.ts";
import type { SlackBot, SlackBotType, SpawnCardPolicy, SlackMessageSchedule, SlackMessageScheduleCadence } from "../generated/client/index.js";

export type { SlackBot, SlackBotType, SpawnCardPolicy, SlackMessageSchedule, SlackMessageScheduleCadence };

// ── Workspace ↔ Slack team ──────────────────────────────────────────────────
// One Slack team maps to one Manta workspace; recorded as a WorkspaceIdentity so
// the Integrations UI can show "Slack connected". Upserted when the first bot for
// a workspace is registered (we learn the team id from auth.test).

export async function findWorkspaceBySlackTeam(teamId: string): Promise<string | null> {
  const identity = await prisma.workspaceIdentity.findUnique({
    where: { provider_externalId: { provider: "slack", externalId: teamId } },
  });
  return identity?.workspaceId ?? null;
}

export async function linkSlackTeam(workspaceId: string, teamId: string): Promise<void> {
  await prisma.workspaceIdentity.upsert({
    where: { provider_externalId: { provider: "slack", externalId: teamId } },
    create: { workspaceId, provider: "slack", externalId: teamId },
    update: { workspaceId },
  });
}

/** The Slack team currently linked to a workspace, if any. Used to enforce one
 * Slack team per workspace when registering additional bots. */
export async function findSlackTeamForWorkspace(workspaceId: string): Promise<string | null> {
  const identity = await prisma.workspaceIdentity.findFirst({
    where: { workspaceId, provider: "slack" },
  });
  return identity?.externalId ?? null;
}

// ── Slack bots ──────────────────────────────────────────────────────────────
// Ciphertext (token, signing secret) is produced/consumed in the server layer
// (apps/server/src/secrets/crypto.ts); the db layer just stores opaque Bytes.

export interface CreateBotInput {
  name: string;
  slackAppId: string;
  instructions: string;
  botTokenCipher: Uint8Array;
  signingSecretCipher: Uint8Array;
  teamId?: string | null;
  botUserId?: string | null;
  botType?: SlackBotType;
  autoRespondChannels?: string[];
  autoRespondChannelInstructions?: Record<string, string>;
  spawnCardPolicy?: SpawnCardPolicy;
  defaultRepo?: string | null;
  enabled?: boolean;
}

export function createBot(workspaceId: string, input: CreateBotInput): Promise<SlackBot> {
  // Buffer.from normalizes to Uint8Array<ArrayBuffer>, which Prisma's Bytes type
  // requires (a bare Uint8Array is Uint8Array<ArrayBufferLike>).
  return prisma.slackBot.create({
    data: {
      workspaceId,
      ...input,
      botTokenCipher: Buffer.from(input.botTokenCipher),
      signingSecretCipher: Buffer.from(input.signingSecretCipher),
    },
  });
}

export interface UpdateBotInput {
  name?: string;
  instructions?: string;
  botType?: SlackBotType;
  autoRespondChannels?: string[];
  autoRespondChannelInstructions?: Record<string, string>;
  spawnCardPolicy?: SpawnCardPolicy;
  defaultRepo?: string | null;
  enabled?: boolean;
  teamId?: string | null;
  botUserId?: string | null;
  slackAppId?: string;
  botTokenCipher?: Uint8Array;
  signingSecretCipher?: Uint8Array;
}

/** Update a bot, scoped to its workspace. Returns null if no row matched the
 * (botId, workspaceId) pair — a mismatched pair can't touch another tenant's bot. */
export async function updateBot(
  workspaceId: string,
  botId: string,
  data: UpdateBotInput,
): Promise<SlackBot | null> {
  const { botTokenCipher, signingSecretCipher, ...rest } = data;
  const res = await prisma.slackBot.updateMany({
    where: { id: botId, workspaceId },
    data: {
      ...rest,
      ...(botTokenCipher ? { botTokenCipher: Buffer.from(botTokenCipher) } : {}),
      ...(signingSecretCipher ? { signingSecretCipher: Buffer.from(signingSecretCipher) } : {}),
    },
  });
  if (res.count === 0) return null;
  // Scope the read-back too: never expose a workspace-owned row by id alone.
  return prisma.slackBot.findFirst({ where: { id: botId, workspaceId } });
}

export async function deleteBot(workspaceId: string, botId: string): Promise<void> {
  await prisma.slackBot.deleteMany({ where: { id: botId, workspaceId } });
}

export function listBots(workspaceId: string): Promise<SlackBot[]> {
  return prisma.slackBot.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
}

export function getBot(workspaceId: string, botId: string): Promise<SlackBot | null> {
  return prisma.slackBot.findFirst({ where: { id: botId, workspaceId } });
}

/** Resolve an inbound Slack event to its bot by Slack's api_app_id. This is the
 * inbound-routing exception to the workspace-scoping rule (analogous to
 * findWorkspaceBySlackTeam): the request isn't authenticated to a workspace yet,
 * and the signing-secret check happens after this lookup. */
export function findBotByAppId(slackAppId: string): Promise<SlackBot | null> {
  return prisma.slackBot.findUnique({ where: { slackAppId } });
}

// ── Scheduled Slack messages ────────────────────────────────────────────────

export interface CreateMessageScheduleInput {
  slackBotId: string;
  name: string;
  channelId: string;
  repo?: string | null;
  prompt: string;
  cadence: SlackMessageScheduleCadence;
  timeOfDayUtc: string;
  daysOfWeek: number[];
  timeZone: string;
  includeWeekendsAndHolidays: boolean;
  enabled?: boolean;
  nextRunAt: Date;
}

export type UpdateMessageScheduleInput = Partial<
  Pick<SlackMessageSchedule, "name" | "channelId" | "repo" | "prompt" | "cadence" | "timeOfDayUtc" | "daysOfWeek" | "timeZone" | "includeWeekendsAndHolidays" | "enabled" | "nextRunAt" | "lastRunAt" | "lastError">
>;

export function listMessageSchedules(workspaceId: string): Promise<SlackMessageSchedule[]> {
  return prisma.slackMessageSchedule.findMany({
    where: { workspaceId },
    orderBy: [{ enabled: "desc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
  });
}

export function getMessageSchedule(workspaceId: string, scheduleId: string): Promise<SlackMessageSchedule | null> {
  return prisma.slackMessageSchedule.findFirst({ where: { id: scheduleId, workspaceId } });
}

export function createMessageSchedule(workspaceId: string, input: CreateMessageScheduleInput): Promise<SlackMessageSchedule> {
  return prisma.$transaction(async (tx) => {
    const bot = await tx.slackBot.findFirst({ where: { id: input.slackBotId, workspaceId }, select: { id: true } });
    if (!bot) throw new Error("slack_bot_not_found");
    return tx.slackMessageSchedule.create({ data: { workspaceId, ...input } });
  });
}

export async function updateMessageSchedule(
  workspaceId: string,
  scheduleId: string,
  data: UpdateMessageScheduleInput,
): Promise<SlackMessageSchedule | null> {
  const res = await prisma.slackMessageSchedule.updateMany({ where: { id: scheduleId, workspaceId }, data });
  if (res.count === 0) return null;
  return getMessageSchedule(workspaceId, scheduleId);
}

export async function deleteMessageSchedule(workspaceId: string, scheduleId: string): Promise<void> {
  await prisma.slackMessageSchedule.deleteMany({ where: { id: scheduleId, workspaceId } });
}
