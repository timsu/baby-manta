// Workspace-scoped query layer. The ONLY way app code touches the database.
//
// Invariant: every read/write is scoped to a workspaceId. Query helpers take a
// `WorkspaceScope` (or an explicit workspaceId) so a query can never silently
// span workspaces — isolation is enforced here, at the module boundary, not in
// route handlers. The raw `prisma` client is exported for migrations/seeds and
// the few genuinely cross-workspace operations (webhook routing, presence).

export interface WorkspaceScope {
  workspaceId: string;
}

export { prisma } from "./client.ts";
export * as workspaces from "./workspaces.ts";
export * as users from "./users.ts";
export * as tasks from "./tasks.ts";
export * as messages from "./messages.ts";
export * as repos from "./repos.ts";
export * as slack from "./slack.ts";
export * as github from "./github.ts";
export * as agentSessions from "./agent-sessions.ts";
export * as inbox from "./inbox.ts";
export * as invitations from "./invitations.ts";
export * as workerCredentials from "./workerCredentials.ts";
export * as cardImages from "./cardImages.ts";
export * as sandboxCredentials from "./sandboxCredentials.ts";
export * as workspaceSecrets from "./workspaceSecrets.ts";
export * as userSecrets from "./userSecrets.ts";
export * as spotCheckRuns from "./spotCheckRuns.ts";
export type { GoogleProfile } from "./users.ts";
export type { WorkspaceSettings } from "./workspaces.ts";
export type { InvitationPreview, AcceptResult } from "./invitations.ts";

// Re-export the generated enum/model types so app code imports DB types from
// "@manta/db" rather than reaching into the generated client path directly.
export type {
  Workspace,
  Role,
  Task,
  TaskKind,
  TaskType,
  CardType,
  CardStatus,
  DoneReason,
  SpotCheckVerdict,
  TransitionActor,
  WorkerStatus,
  SecretKind,
  SlackBot,
  SlackBotType,
  SpawnCardPolicy,
  SlackMessageSchedule,
  SlackMessageScheduleCadence,
  Prisma,
} from "./client.ts";
export type { PrFields } from "./tasks.ts";
