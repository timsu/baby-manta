// Typed API client — the only place the web app talks HTTP. In dev, /api/* is
// proxied to the server (:3020) by Vite; cookies are shared across localhost
// ports so the session rides along. The Google login is a full-page navigation
// to the server origin (cleanest cookie flow), exposed as authUrl().

import type { AgentEvent, CardStatus } from "@manta/shared";

// All API calls (incl. the OAuth dance) go through the same origin as the SPA —
// in dev Vite proxies /api/* to the server, so the session cookie is set on and
// sent from one origin (:5173). No cross-port cookie ambiguity.
export const authUrl = "/api/auth/google";

/** Sign-in methods this deployment offers; drives what the login card renders. */
export interface AuthMethods {
  google: boolean;
  email: boolean;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** GitHub login, set once the user runs the "Link GitHub" flow. */
  githubLogin: string | null;
  /** True when GitHub identity exists but the OAuth token must be refreshed by relinking. */
  githubNeedsRelink: boolean;
  /** Slack user id, auto-linked when the user first messages a Manta Slack bot
   * from a Slack account whose email matches theirs. Null until linked. */
  slackUserId: string | null;
  /** Linear user id, auto-linked when the workspace connects Linear and a member's
   * email matches theirs. Null until linked. */
  linearUserId: string | null;
  /** True when an admin marked the user as a non-engineer. */
  nonEngineer: boolean;
  /** True once this user has ever connected a worker daemon. */
  workerEverConnected: boolean;
  /** True when the user dismissed the local-worker onboarding step. */
  localWorkerOnboardingDismissed: boolean;
  memberships: { workspaceId: string; slug: string; name: string; role: string }[];
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

export interface TaskCard {
  id: string;
  title: string;
  cardType: CardType;
  cardStatus: CardStatus;
  doneReason: string | null;
  /** Hidden automated/background cards are returned only for debug views. */
  hidden: boolean;
  backgroundMode: string | null;
  repo: string;
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  prTitle: string | null;
  checksStatus: string;
  checks: Array<{ name?: string; status?: string; conclusion?: string | null }>;
  reviewDecision: string | null;
  mergeable: string;
  autoMergeEnabled: boolean;
  workerStatus: string;
  workerActive: boolean;
  /** Which venue runs the work ("none" | "laptop" | "daytona") and its lifecycle
   * state ("none" | "provisioning" | "active" | "idle" | "stopped" | "failed"). */
  workerVenue: string;
  venueStatus: string;
  branch: string | null;
  characterEmoji: string | null;
  updatedAt: string;
  createdAt: string;
  taskNumber: number | null;
  linearIssueIdentifier: string | null;
  linearIssueUrl: string | null;
  /** User id who created the card; null for automation-created cards. */
  createdBy: string | null;
  /** Backend id used to run the worker, e.g. "pi-openai-codex:gpt-5.5". */
  workerBackend: string;
  /** Local worker availability for the task owner as used by worker-chat routing. */
  localWorkerStatus: "online" | "reconnecting" | "offline";
}

export interface ModelInfo {
  /** Backend id, e.g. "pi-openai-codex:gpt-5.5". */
  id: string;
  label: string;
  provider: string;
  modelId: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  authKind: "subscription" | "api_key" | "other";
  modelCount: number;
  /** Set when a recent turn failed because this credential expired and couldn't
   * refresh — the user must re-login. Drives the re-login prompt. */
  needsReauth?: boolean;
}

export interface ModelsView {
  models: ModelInfo[];
  providers: ProviderStatus[];
  defaultModel: string | null;
  scoutModel: string | null;
  cardModels: string[];
}

export interface ServerLogEntry {
  level: "debug" | "info" | "warn" | "error";
  domain: string;
  msg: string;
  time: string;
}

export interface UserProvidersView {
  providers: ProviderStatus[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface TerminalTab {
  id: string;
  label: string;
}

export interface TaskDetail extends TaskCard {
  description: string;
  ownerName: string | null;
  ownerEmail: string | null;
  checklist: ChecklistItem[];
  terminalTabs: { tabs: TerminalTab[]; activeTerminalId: string } | null;
  planDocument: string | null;
}

export interface SkillRepoConfig {
  repo: string;
  path?: string;
}

export interface Repo {
  id: string;
  orgRepo: string;
  defaultBranch: string;
  enabled: boolean;
  setupCommands: string;
  globalInstructions: string;
  skillRepos: SkillRepoConfig[];
}

export type CardType = "bot" | "investigation" | "interactive" | "plan" | "backlog";

export interface NewCard {
  prompt: string;
  repo: string;
  cardType: CardType;
  workerBackend: string;
  workerVenue?: "laptop" | "daytona";
  linearIssueIdentifier?: string;
}

export interface LinearMember {
  id: string;
  name: string;
  email: string;
}

export interface LinearProject {
  id: string;
  name: string;
  url: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { id: string; name: string; type: string; position: number };
  url: string;
  updatedAt: string;
  priority: number;
  estimate: number | null;
  team: { id: string; name: string; key: string } | null;
  project: LinearProject | null;
  repo: string | null;
}

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  branch: string;
  repo: string;
  updatedAt: string;
  state: string;
  author: { login: string; avatarUrl: string } | null;
}

export interface WorkerInfo {
  workerId: string;
  ownerUserId: string;
  owner: { id: string; name: string | null; email: string; avatarUrl: string | null } | null;
  /** False for short-lived presence-cache entries that are reconnecting/offline. */
  live: boolean;
  currentTaskId: string | null;
  activeTaskIds: string[];
  activeTaskCount: number;
  connectedAt: string;
  idle: boolean;
  gitHash: string | null;
  currentTask: { id: string; title: string; workspaceId: string; cardStatus: string } | null;
  activeTasks: Array<{ id: string; title: string; workspaceId: string; cardStatus: string }>;
}

export interface SandboxInfo {
  id: string;
  taskId: string;
  workspaceId: string;
  state: string | null;
  createdAt: string | null;
  task: { id: string; title: string; cardStatus: string; venueStatus: string } | null;
}

export interface ChatResult {
  assistantText: string;
  toolsUsed: string[];
  terminalReason?: string;
  run?: SpotCheckRunSummary;
}

export interface TranscriptEntryMeta {
  tools?: { tool: string; args: string }[];
  transcript?: Array<
    | { type: "assistant"; text: string }
    | { type: "tool"; tool: string; args: string }
    | { type: "status"; text: string }
    | { type: "thinking"; text: string }
  >;
}

export interface TaskTranscript {
  task: Pick<TaskCard, "id" | "title" | "repo" | "branch" | "cardStatus" | "prUrl" | "prNumber" | "linearIssueIdentifier" | "linearIssueUrl" | "createdAt" | "updatedAt">;
  messages: Array<{
    id: string;
    seq: number;
    role: "user" | "assistant" | "status" | "system";
    content: string;
    meta: TranscriptEntryMeta | null;
    ts: string;
  }>;
  truncated: boolean;
  totalMessages: number;
  messageLimit: number;
}

export interface SpotCheckConfig {
  id: string;
  name: string;
  instructions: string;
  repo?: string;
  enabled: boolean;
  schedule?: SpotCheckSchedule;
  createdAt?: string;
  updatedAt?: string;
}

export interface SpotCheckSchedule {
  enabled: boolean;
  cadence: "hourly" | "daily" | "weekly";
  timeZone: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
}

export interface SpotCheckRunSummary {
  id: string;
  spotCheckId: string;
  spotCheckName: string;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  verdict: "pass" | "warn" | "fail" | "unknown";
  summary: string;
  report: string;
}

export type SpotCheckStreamEvent =
  | { type: "started"; run: SpotCheckRunSummary }
  | { type: "status"; message: string }
  | { type: "agent_event"; event: AgentEvent }
  | { type: "complete"; result: ChatResult }
  | { type: "error"; message: string; run?: SpotCheckRunSummary };

export type RepoChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "agent_event"; event: AgentEvent }
  | { type: "complete"; answer: string }
  | { type: "error"; message: string };
export interface WorkspaceDetail {
  id: string;
  slug: string;
  name: string;
  brainPrompt: string;
  teamMemory: string;
  defaultBrainPrompt: string;
}

export interface Member {
  userId: string;
  role: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
  nonEngineer: boolean;
  localWorkerCount: number;
}

export interface GithubInstallation {
  connected: boolean;
  account: { login: string; avatarUrl: string } | null;
  repos: Array<{ orgRepo: string; defaultBranch: string; private: boolean }>;
}

export interface LinearConnection {
  /** Whether this workspace has saved its Linear OAuth app credentials. */
  appConfigured: boolean;
  /** The saved app's client id (non-secret), for display when editing. */
  clientId: string | null;
  hasWebhookSecret: boolean;
  /** Whether an actor=app OAuth token has been minted (i.e. fully connected). */
  connected: boolean;
  /** Connected Linear organization name, when known. */
  organization: string | null;
  /** Display name of the Manta bot identity posting in this org, when known. */
  botName: string | null;
  myLinearUser: { id: string; name: string | null } | null;
  /** Per-workspace webhook URL to paste into the Linear app settings. */
  webhookUrl: string;
  /** OAuth redirect URI to register in the Linear app settings. */
  redirectUri: string;
}

export interface NotionConnection {
  connected: boolean;
  instructions: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  team: { id: string; name: string; key: string } | null;
}

export interface LinearStatusAutomation {
  id: string;
  enabled: boolean;
  statusId: string;
  statusName: string;
  teamId?: string;
  teamKey?: string;
  instructions: string;
}

export interface Invitation {
  id: string;
  code: string;
  role: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface InvitationPreview {
  code: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  valid: boolean;
}

export type SlackBotType = "slack" | "linear";
export type SpawnCardPolicy = "auto" | "never";
export type SlackMessageScheduleCadence = "daily" | "weekly";

export interface SlackBot {
  id: string;
  name: string;
  slackAppId: string;
  teamId: string | null;
  botUserId: string | null;
  instructions: string;
  botType: SlackBotType;
  autoRespondChannels: string[];
  autoRespondChannelInstructions: Record<string, string>;
  spawnCardPolicy: SpawnCardPolicy;
  defaultRepo: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SlackBotInput {
  name: string;
  instructions: string;
  botToken: string;
  signingSecret: string;
  botType?: SlackBotType;
  autoRespondChannels?: string[];
  autoRespondChannelInstructions?: Record<string, string>;
  spawnCardPolicy?: SpawnCardPolicy;
  defaultRepo?: string | null;
}

export type SlackBotUpdate = Partial<
  Pick<SlackBot, "name" | "instructions" | "botType" | "autoRespondChannels" | "autoRespondChannelInstructions" | "spawnCardPolicy" | "defaultRepo" | "enabled">
> & { botToken?: string; signingSecret?: string };

export interface SlackMessageSchedule {
  id: string;
  slackBotId: string;
  name: string;
  channelId: string;
  repo: string | null;
  prompt: string;
  cadence: SlackMessageScheduleCadence;
  timeOfDayUtc: string;
  daysOfWeek: number[];
  timeZone: string;
  includeWeekendsAndHolidays: boolean;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SlackMessageScheduleInput = Pick<SlackMessageSchedule, "name" | "slackBotId" | "channelId" | "repo" | "prompt" | "cadence" | "timeOfDayUtc" | "daysOfWeek" | "timeZone" | "includeWeekendsAndHolidays"> & {
  enabled?: boolean;
};

export type SlackMessageScheduleUpdate = Partial<SlackMessageScheduleInput & Pick<SlackMessageSchedule, "enabled">>;

export interface SlackMessageScheduleTestResult {
  text: string;
  events: AgentEvent[];
  taskId: string;
  terminalReason: string | null;
}

export type SlackMessageScheduleTestStreamMessage =
  | { type: "task"; taskId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "result"; text: string; taskId: string; terminalReason: string | null }
  | { type: "error"; error: string; taskId?: string };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${path}`;
    try { const body = await res.json() as { error?: string }; if (body.error) msg = body.error; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as T;
}

async function streamNdjson<T>(path: string, init: RequestInit, onMessage: (message: T) => void): Promise<void> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${path}`;
    try { const body = await res.json() as { error?: string }; if (body.error) msg = body.error; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line) as T);
      newline = buffer.indexOf("\n");
    }
  }
  const rest = `${buffer}${decoder.decode()}`.trim();
  if (rest) onMessage(JSON.parse(rest) as T);
}

async function streamSse(
  path: string,
  init: RequestInit,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${path}`;
    try { const body = await res.json() as { error?: string }; if (body.error) msg = body.error; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  if (!res.body) throw new Error("Streaming response was empty");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushBlock = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) return;
    onEvent(event, JSON.parse(dataLines.join("\n")) as unknown);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trimEnd();
      buffer = buffer.slice(boundary + 2);
      if (block) flushBlock(block);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) flushBlock(buffer.trim());
}

export const api = {
  async me(): Promise<Me | null> {
    try {
      return await req<Me>("/api/me");
    } catch (e) {
      if ((e as { status?: number }).status === 401) return null;
      throw e;
    }
  },
  logout: () => req<{ ok: true }>("/api/auth", { method: "DELETE" }),
  /** Which sign-in methods this server offers (unauthenticated). */
  authMethods: () => req<AuthMethods>("/api/auth/methods"),
  /** Passwordless sign-in; creates the account on first use. */
  loginWithEmail: (email: string) =>
    req<{ ok: true; email: string }>("/api/auth/email", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  updateMePreferences: (prefs: { localWorkerOnboardingDismissed?: boolean }) =>
    req<{ localWorkerOnboardingDismissed: boolean }>("/api/me/preferences", {
      method: "PATCH",
      body: JSON.stringify(prefs),
    }),
  createWorkspace: (name: string) =>
    req<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  tasks: (workspaceId: string) =>
    req<{ tasks: TaskCard[] }>(`/api/workspaces/${workspaceId}/tasks?includeBackgroundDebug=true`),
  /** Discover a direct (same-machine) terminal endpoint for a task, if the worker
   * holding its worktree exposes a loopback port. `direct` is null when only the
   * server relay is available. */
  terminalEndpoint: (workspaceId: string, taskId: string, terminalId = "default") =>
    req<{ direct: { host: string; port: number; token: string } | null }>(
      `/api/tasks/${taskId}/terminal-endpoint?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(terminalId)}`,
    ),
  /** Re-bind a disconnected local task terminal to the owner's connected worker
   * without starting a new worker turn. */
  reconnectTerminal: (workspaceId: string, taskId: string) =>
    req<{ ok: true }>(`/api/tasks/${taskId}/reconnect-terminal`, {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }),
  chat: (workspaceId: string, message: string) =>
    req<ChatResult>(`/api/workspaces/${workspaceId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  repoChatStatus: (workspaceId: string) =>
    req<{ available: boolean; models: ModelInfo[] }>(`/api/workspaces/${workspaceId}/repo-chat/status`),
  runRepoChat: (
    workspaceId: string,
    input: { repo: string; model: string; message: string; history: Array<{ role: "user" | "assistant"; text: string }> },
    onEvent: (event: RepoChatStreamEvent) => void,
  ) => streamSse(
    `/api/workspaces/${workspaceId}/repo-chat`,
    { method: "POST", body: JSON.stringify(input) },
    (event, data) => {
      if (event === "status") onEvent({ type: "status", message: String((data as { message?: unknown }).message ?? "") });
      else if (event === "agent_event") onEvent({ type: "agent_event", event: data as AgentEvent });
      else if (event === "complete") onEvent({ type: "complete", answer: String((data as { answer?: unknown }).answer ?? "") });
      else if (event === "error") onEvent({ type: "error", message: String((data as { message?: unknown }).message ?? "Repo chat failed") });
    },
  ),
  spotChecks: (workspaceId: string) =>
    req<{ spotChecks: SpotCheckConfig[]; runs?: SpotCheckRunSummary[] }>(`/api/workspaces/${workspaceId}/spot-checks`),
  updateSpotChecks: (workspaceId: string, spotChecks: SpotCheckConfig[]) =>
    req<{ spotChecks: SpotCheckConfig[] }>(`/api/workspaces/${workspaceId}/spot-checks`, {
      method: "PUT",
      body: JSON.stringify({ spotChecks }),
    }),
  runSpotCheck: (workspaceId: string, checkId: string) =>
    req<ChatResult>(`/api/workspaces/${workspaceId}/spot-checks/${encodeURIComponent(checkId)}/run`, { method: "POST" }),
  runSpotCheckStream: (workspaceId: string, checkId: string, onEvent: (event: SpotCheckStreamEvent) => void) =>
    streamSse(
      `/api/workspaces/${workspaceId}/spot-checks/${encodeURIComponent(checkId)}/run-stream`,
      { method: "POST" },
      (event, data) => {
        if (event === "started") onEvent({ type: "started", run: (data as { run: SpotCheckRunSummary }).run });
        else if (event === "status") onEvent({ type: "status", message: String((data as { message?: unknown }).message ?? "") });
        else if (event === "agent_event") onEvent({ type: "agent_event", event: data as AgentEvent });
        else if (event === "complete") onEvent({ type: "complete", result: data as ChatResult });
        else if (event === "error") {
          const payload = data as { message?: unknown; run?: SpotCheckRunSummary };
          onEvent({ type: "error", message: String(payload.message ?? "Spot check failed"), ...(payload.run ? { run: payload.run } : {}) });
        }
      },
    ),
  repos: (workspaceId: string) =>
    req<{ repos: Repo[] }>(`/api/workspaces/${workspaceId}/repos`),
  addRepo: (workspaceId: string, orgRepo: string, defaultBranch?: string) =>
    req<Repo>(`/api/workspaces/${workspaceId}/repos`, {
      method: "POST",
      body: JSON.stringify({ orgRepo, defaultBranch }),
    }),
  removeRepo: (workspaceId: string, repoId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/repos/${repoId}`, { method: "DELETE" }),
  updateRepo: (workspaceId: string, repoId: string, patch: { setupCommands?: string; globalInstructions?: string; skillRepos?: SkillRepoConfig[] }) =>
    req<Repo>(`/api/workspaces/${workspaceId}/repos/${repoId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  getRepoPersonal: (workspaceId: string, repoId: string) =>
    req<{ instructions: string }>(`/api/workspaces/${workspaceId}/repos/${repoId}/personal`),
  updateRepoPersonal: (workspaceId: string, repoId: string, instructions: string) =>
    req<{ instructions: string }>(`/api/workspaces/${workspaceId}/repos/${repoId}/personal`, {
      method: "PATCH",
      body: JSON.stringify({ instructions }),
    }),
  uploadImage: (workspaceId: string, mimeType: string, data: string) =>
    req<{ url: string }>(`/api/workspaces/${workspaceId}/images`, {
      method: "POST",
      body: JSON.stringify({ mimeType, data }),
    }),
  createCard: (workspaceId: string, card: NewCard) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/cards`, {
      method: "POST",
      body: JSON.stringify(card),
    }),
  workspace: (workspaceId: string) =>
    req<WorkspaceDetail>(`/api/workspaces/${workspaceId}`),
  updateWorkspace: (workspaceId: string, data: Partial<Pick<WorkspaceDetail, "name" | "brainPrompt" | "teamMemory">>) =>
    req<WorkspaceDetail>(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify(data) }),
  members: (workspaceId: string) =>
    req<{ members: Member[] }>(`/api/workspaces/${workspaceId}/members`),
  setMemberNonEngineer: (workspaceId: string, userId: string, nonEngineer: boolean) =>
    req<{ userId: string; nonEngineer: boolean }>(`/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}/non-engineer`, {
      method: "PATCH",
      body: JSON.stringify({ nonEngineer }),
    }),
  invitations: (workspaceId: string) =>
    req<{ invitations: Invitation[] }>(`/api/workspaces/${workspaceId}/invitations`),
  createInvitation: (workspaceId: string, opts?: { role?: string; expiresInDays?: number | null }) =>
    req<Invitation>(`/api/workspaces/${workspaceId}/invitations`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),
  revokeInvitation: (workspaceId: string, invId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/invitations/${invId}`, { method: "DELETE" }),
  invitationPreview: (code: string) =>
    req<InvitationPreview>(`/api/invitations/${encodeURIComponent(code)}`),
  acceptInvitation: (code: string) =>
    req<{ workspaceId: string; alreadyMember: boolean }>(`/api/invitations/${encodeURIComponent(code)}/accept`, {
      method: "POST",
    }),
  slackBots: (workspaceId: string) =>
    req<{ bots: SlackBot[] }>(`/api/workspaces/${workspaceId}/slack/bots`),
  createSlackBot: (workspaceId: string, data: SlackBotInput) =>
    req<SlackBot>(`/api/workspaces/${workspaceId}/slack/bots`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateSlackBot: (workspaceId: string, botId: string, data: SlackBotUpdate) =>
    req<SlackBot>(`/api/workspaces/${workspaceId}/slack/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteSlackBot: (workspaceId: string, botId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/slack/bots/${botId}`, { method: "DELETE" }),
  slackBotChannels: (workspaceId: string, botId: string) =>
    req<{ channels: { id: string; name: string }[]; warning?: string }>(`/api/workspaces/${workspaceId}/slack/bots/${botId}/channels`),
  slackMessageSchedules: (workspaceId: string) =>
    req<{ schedules: SlackMessageSchedule[] }>(`/api/workspaces/${workspaceId}/slack/message-schedules`),
  createSlackMessageSchedule: (workspaceId: string, data: SlackMessageScheduleInput) =>
    req<SlackMessageSchedule>(`/api/workspaces/${workspaceId}/slack/message-schedules`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateSlackMessageSchedule: (workspaceId: string, scheduleId: string, data: SlackMessageScheduleUpdate) =>
    req<SlackMessageSchedule>(`/api/workspaces/${workspaceId}/slack/message-schedules/${scheduleId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  testSlackMessageSchedule: (workspaceId: string, data: SlackMessageScheduleInput) =>
    req<SlackMessageScheduleTestResult>(`/api/workspaces/${workspaceId}/slack/message-schedules/test`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  streamSlackMessageScheduleTest: (workspaceId: string, data: SlackMessageScheduleInput, onMessage: (message: SlackMessageScheduleTestStreamMessage) => void, signal?: AbortSignal) =>
    streamNdjson<SlackMessageScheduleTestStreamMessage>(`/api/workspaces/${workspaceId}/slack/message-schedules/test/stream`, {
      method: "POST",
      body: JSON.stringify(data),
      signal,
    }, onMessage),
  postSlackMessageScheduleTest: (workspaceId: string, data: { taskId: string; slackBotId: string; channelId: string }) =>
    req<{ ok: true; channelId: string; messageTs: string | null }>(`/api/workspaces/${workspaceId}/slack/message-schedules/test/post`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteSlackMessageSchedule: (workspaceId: string, scheduleId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/slack/message-schedules/${scheduleId}`, { method: "DELETE" }),
  integrations: (workspaceId: string) =>
    req<{ providers: string[] }>(`/api/workspaces/${workspaceId}/integrations`),
  blackMantaCommentary: (workspaceId: string, board: {
    cards: Array<{ title: string; status: string; repo: string; pr: string | null; linear: string | null }>;
    linearTickets: Array<{ identifier: string; title: string; state: string; repo: string | null; priority: number }>;
  }) => req<{ text: string }>("/api/black-manta/commentary", {
    method: "POST",
    body: JSON.stringify({ workspaceId, board }),
  }),

  // GitHub App install + per-user link. install/link are full-page navigations
  // (cleanest cookie + redirect flow), so these return URLs rather than fetch.
  githubInstallUrl: (workspaceId: string) =>
    `/api/integrations/github/install?ws=${encodeURIComponent(workspaceId)}`,
  githubLinkUrl: () => `/api/integrations/github/me/connect`,
  githubInstallation: (workspaceId: string) =>
    req<GithubInstallation>(`/api/integrations/github/repos?ws=${encodeURIComponent(workspaceId)}`),
  githubDisconnect: (workspaceId: string) =>
    req<{ ok: true }>(`/api/integrations/github/disconnect`, {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId }),
    }),

  // Linear is a per-workspace, bring-your-own-app connector. Save the app creds
  // first, then Connect (a full-page navigation for the cookie + redirect flow).
  linearStatus: (workspaceId: string) =>
    req<LinearConnection>(`/api/linear/status?ws=${encodeURIComponent(workspaceId)}`),
  linearSaveAppConfig: (
    workspaceId: string,
    cfg: { clientId: string; clientSecret: string; webhookSecret?: string },
  ) =>
    req<{ ok: true }>(`/api/linear/app-config`, {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId, ...cfg }),
    }),
  linearRemoveAppConfig: (workspaceId: string) =>
    req<{ ok: true }>(`/api/linear/app-config?ws=${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    }),
  linearConnectUrl: (workspaceId: string) =>
    `/api/linear/oauth/connect?ws=${encodeURIComponent(workspaceId)}`,
  linearDisconnect: (workspaceId: string) =>
    req<{ ok: true }>(`/api/linear/disconnect`, {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId }),
    }),
  linearMembers: (workspaceId: string) =>
    req<{ members: LinearMember[] }>(`/api/linear/members?ws=${encodeURIComponent(workspaceId)}`),
  linearSetMe: (workspaceId: string, linearUserId: string | null) =>
    req<{ ok: true }>(`/api/linear/me`, {
      method: "PUT",
      body: JSON.stringify({ ws: workspaceId, linearUserId }),
    }),
  linearProjects: (workspaceId: string) =>
    req<{ projects: LinearProject[]; mappings: Record<string, string> }>(`/api/linear/projects?ws=${encodeURIComponent(workspaceId)}`),
  linearSaveProjectMappings: (workspaceId: string, mappings: Record<string, string | null>) =>
    req<{ mappings: Record<string, string> }>(`/api/linear/project-mappings`, {
      method: "PUT",
      body: JSON.stringify({ ws: workspaceId, mappings }),
    }),
  linearTeams: (workspaceId: string) =>
    req<{ teams: LinearTeam[]; mappings: Record<string, string> }>(`/api/linear/teams?ws=${encodeURIComponent(workspaceId)}`),
  linearSaveTeamMappings: (workspaceId: string, mappings: Record<string, string | null>) =>
    req<{ mappings: Record<string, string> }>(`/api/linear/team-mappings`, {
      method: "PUT",
      body: JSON.stringify({ ws: workspaceId, mappings }),
    }),
  linearMyIssues: (workspaceId: string) =>
    req<{ issues: LinearTicket[]; needsLinearUser: boolean; connected: boolean }>(`/api/linear/my-issues?ws=${encodeURIComponent(workspaceId)}`),
  linearAutomation: (workspaceId: string) =>
    req<{ automations: LinearStatusAutomation[]; history: Record<string, string[]>; states: LinearWorkflowState[] }>(`/api/linear/automation?ws=${encodeURIComponent(workspaceId)}`),
  linearSaveAutomation: (workspaceId: string, automations: LinearStatusAutomation[]) =>
    req<{ automations: LinearStatusAutomation[] }>(`/api/linear/automation`, {
      method: "PUT",
      body: JSON.stringify({ ws: workspaceId, automations }),
    }),
  linearRunAutomationBatch: (workspaceId: string, statusId: string, limit: number) =>
    req<{ queued: number; skippedKnown: number; identifiers: string[]; taskId: string | null; taskNumber?: number | null }>(`/api/linear/automation/batch`, {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId, statusId, limit }),
    }),
  linearMoveStale: (workspaceId: string, fromStatusId: string, toStatusId: string, olderThanMonths: number) =>
    req<{ moved: number; identifiers: string[]; cutoff: string }>(`/api/linear/automation/move-stale`, {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId, fromStatusId, toStatusId, olderThanMonths }),
    }),

  notionStatus: (workspaceId: string) =>
    req<NotionConnection>(`/api/notion/status?ws=${encodeURIComponent(workspaceId)}`),
  notionConnectUrl: (workspaceId: string) =>
    `/api/notion/oauth/connect?ws=${encodeURIComponent(workspaceId)}`,
  notionDisconnect: (workspaceId: string) =>
    req<{ ok: true }>("/api/notion/disconnect", {
      method: "POST",
      body: JSON.stringify({ ws: workspaceId }),
    }),
  notionSaveInstructions: (workspaceId: string, instructions: string) =>
    req<{ instructions: string }>("/api/notion/instructions", {
      method: "PUT",
      body: JSON.stringify({ ws: workspaceId, instructions }),
    }),

  getTask: (workspaceId: string, taskId: string) =>
    req<TaskDetail>(`/api/workspaces/${workspaceId}/tasks/${taskId}`).then((d) => ({
      // `checklist` is a Prisma Json column; harden against legacy/malformed
      // non-array values so consumers can rely on it being an array.
      ...d,
      checklist: Array.isArray(d.checklist) ? d.checklist : [],
    })),
  getTaskTranscript: (workspaceId: string, taskId: string) =>
    req<TaskTranscript>(`/api/workspaces/${workspaceId}/tasks/${taskId}/transcript`),
  sendTaskMessage: (workspaceId: string, taskId: string, message: string) =>
    req<{ ok: true; taskId: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
      keepalive: true,
    }),
  archiveTask: (workspaceId: string, taskId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/tasks/${taskId}`, { method: "DELETE" }),
  resurrectTask: (workspaceId: string, taskId: string, instruction?: string) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/resurrect`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    }),
  fixConflicts: (workspaceId: string, taskId: string) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/fix-conflicts`, { method: "POST" }),
  fixChecks: (workspaceId: string, taskId: string) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/fix-checks`, { method: "POST" }),
  linkTaskPr: (workspaceId: string, taskId: string, prUrl: string) =>
    req<{ id: string; prNumber: number; prUrl: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/pr`, {
      method: "PATCH",
      body: JSON.stringify({ prUrl }),
    }),
  patchChecklist: (workspaceId: string, taskId: string, items: ChecklistItem[]) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/checklist`, {
      method: "PATCH",
      body: JSON.stringify({ items }),
    }),
  patchTerminalTabs: (workspaceId: string, taskId: string, tabs: TerminalTab[], activeTerminalId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/terminal-tabs`, {
      method: "PATCH",
      body: JSON.stringify({ tabs, activeTerminalId }),
    }),
  transitionStatus: (workspaceId: string, taskId: string, to: string, doneReason?: string) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ to, ...(doneReason ? { doneReason } : {}) }),
    }),
  clearInvestigationComplete: (workspaceId: string, taskIds: string[]) =>
    req<{ cleared: number; ids: string[] }>(`/api/workspaces/${workspaceId}/tasks/clear-investigation-complete`, {
      method: "POST",
      body: JSON.stringify({ taskIds }),
    }),
  setAutoMerge: (workspaceId: string, taskId: string, enabled: boolean) =>
    req<{ id: string; autoMergeEnabled: boolean }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/auto-merge`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  setTaskModel: (workspaceId: string, taskId: string, workerBackend: string) =>
    req<{ id: string; workerBackend: string }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/model`, {
      method: "PATCH",
      body: JSON.stringify({ workerBackend }),
    }),
  reassignTask: (workspaceId: string, taskId: string, userId: string) =>
    req<{ id: string; createdBy: string | null }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/assignee`, {
      method: "PATCH",
      body: JSON.stringify({ userId }),
    }),
  // ── Models & providers ──
  models: (workspaceId: string) => req<ModelsView>(`/api/workspaces/${workspaceId}/models`),
  updateModels: (
    workspaceId: string,
    data: { defaultModel?: string | null; scoutModel?: string | null; cardModels?: string[] },
  ) => req<ModelsView>(`/api/workspaces/${workspaceId}/models`, { method: "PUT", body: JSON.stringify(data) }),
  setProvider: (workspaceId: string, provider: string, body: { apiKey?: string; authJson?: unknown }) =>
    req<ModelsView>(`/api/workspaces/${workspaceId}/providers/${encodeURIComponent(provider)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  removeProvider: (workspaceId: string, provider: string) =>
    req<ModelsView>(`/api/workspaces/${workspaceId}/providers/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    }),
  // Per-user provider credentials (subscription providers like Codex).
  userProviders: () => req<UserProvidersView>("/api/user/providers"),
  codexOAuthStart: () =>
    req<{ authUrl: string; state: string }>("/api/user/providers/openai-codex/oauth/start", { method: "POST" }),
  codexOAuthComplete: (state: string, code: string) =>
    req<UserProvidersView>("/api/user/providers/openai-codex/oauth/complete", {
      method: "POST",
      body: JSON.stringify({ state, code }),
    }),
  setUserProvider: (provider: string, body: { authJson?: unknown }) =>
    req<UserProvidersView>(`/api/user/providers/${encodeURIComponent(provider)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  removeUserProvider: (provider: string) =>
    req<UserProvidersView>(`/api/user/providers/${encodeURIComponent(provider)}`, { method: "DELETE" }),

  /** Server build version (git short hash), shown in the user menu. */
  version: () => req<{ gitHash: string | null }>("/api/version"),
  serverLogs: (limit = 200) => req<{ logs: ServerLogEntry[] }>(`/api/debug/server-logs?limit=${encodeURIComponent(String(limit))}`),
  listWorkers: (scope: "mine" | "team" = "mine") => req<{ workers: WorkerInfo[]; serverGitHash: string | null }>(`/api/workers${scope === "team" ? "?scope=team" : ""}`),
  updateWorker: (workerId: string) =>
    req<{ ok: true }>(`/api/workers/${encodeURIComponent(workerId)}/update`, { method: "POST" }),
  /** Live cloud (Daytona) sandboxes for the caller's workspaces. */
  listSandboxes: () => req<{ sandboxes: SandboxInfo[] }>("/api/sandboxes"),
  stopSandbox: (taskId: string, workspaceId: string) =>
    req<{ ok: true }>("/api/sandboxes/stop", { method: "POST", body: JSON.stringify({ taskId, workspaceId }) }),
  /** Permanently delete a sandbox (full cleanup), vs. stop which leaves it wakeable. */
  removeSandbox: (taskId: string, workspaceId: string) =>
    req<{ ok: true }>("/api/sandboxes/remove", { method: "POST", body: JSON.stringify({ taskId, workspaceId }) }),
  /** Wake an asleep cloud sandbox (no turn) so its terminal/worker reconnects. */
  resumeSandbox: (taskId: string, workspaceId: string) =>
    req<{ ok: true }>("/api/sandboxes/resume", { method: "POST", body: JSON.stringify({ taskId, workspaceId }) }),
  /** Stop the cloud sandbox and re-run the task on the owner's laptop worker. */
  moveSandboxToLocal: (taskId: string, workspaceId: string) =>
    req<{ ok: true }>("/api/sandboxes/move-to-local", { method: "POST", body: JSON.stringify({ taskId, workspaceId }) }),
  /** Mint a worker token for the one-time daemon pairing flow. */
  pairWorker: (name: string) =>
    req<{ token: string; name: string; email: string }>("/api/worker-auth/pair", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  refreshGithubStatuses: (workspaceId: string) =>
    req<{ ok: true }>(`/api/workspaces/${workspaceId}/refresh-github-statuses`, { method: "POST" }),
  githubPrs: (workspaceId: string) =>
    req<{ prs: GithubPr[] }>(`/api/workspaces/${workspaceId}/github-prs`),
  repoFiles: (workspaceId: string, orgRepo: string) =>
    req<{ files: string[] }>(`/api/workspaces/${workspaceId}/repo-files?orgRepo=${encodeURIComponent(orgRepo)}`),
  createCardFromPr: (workspaceId: string, pr: Pick<GithubPr, "repo" | "number" | "title" | "url" | "branch" | "state">) =>
    req<{ id: string; cardStatus: string }>(`/api/workspaces/${workspaceId}/cards/from-pr`, {
      method: "POST",
      body: JSON.stringify({ repo: pr.repo, prNumber: pr.number, prTitle: pr.title, prUrl: pr.url, prState: pr.state, branch: pr.branch }),
    }),
};
