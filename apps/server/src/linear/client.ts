// Minimal Linear GraphQL client.
//
// Auth precedence: callers that know a workspace pass a per-workspace OAuth token
// resolved via `linearTokenForWorkspace` (the production path — an actor=app token
// so mutations post as the Manta bot). Functions also accept an explicit `token`
// argument and fall back to the global `LINEAR_API_KEY` env var when omitted, so
// single-workspace/dev setups and existing read paths keep working unchanged.

import { workspaceSecrets } from "@manta/db";
import { decrypt, encrypt } from "../secrets/crypto.ts";
import { getLinearAppConfig } from "./app-config.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Linear");

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/** Metadata we persist alongside the encrypted Linear OAuth access token. */
export interface LinearSecretMeta {
  refreshToken?: string;
  /** ms epoch when the access token expires (0/undefined → never/unknown). */
  expiresAt?: number;
  organizationId?: string;
  organizationName?: string;
  appUserId?: string;
  botName?: string;
}

export function getLinearToken(): string | null {
  return process.env["LINEAR_API_KEY"] ?? null;
}

/**
 * Resolve the access token to use for a workspace's Linear calls. Prefers the
 * workspace's stored actor=app OAuth token (refreshing it first if expired);
 * falls back to the global env key. Returns null when neither is available.
 */
export async function linearTokenForWorkspace(workspaceId: string): Promise<string | null> {
  return (await linearAppTokenForWorkspace(workspaceId)) ?? getLinearToken();
}

/**
 * Resolve the workspace's stored actor=app OAuth token only. Use this for writes
 * that must be attributed to the Manta app/bot; unlike linearTokenForWorkspace,
 * it intentionally does not fall back to LINEAR_API_KEY, which may be a human
 * user's token and would make comments appear as that user.
 */
export async function linearAppTokenForWorkspace(workspaceId: string): Promise<string | null> {
  const stored = await workspaceSecrets.get({ workspaceId }, "linear_oauth");
  if (!stored) return null;

  const accessToken = decrypt(Buffer.from(stored.ciphertext));
  const meta = (stored.meta ?? {}) as LinearSecretMeta;

  // Refresh slightly ahead of expiry so an in-flight call doesn't race the clock.
  const expiresAt = meta.expiresAt ?? 0;
  const expired = expiresAt > 0 && Date.now() > expiresAt - 60_000;
  if (expired) {
    const refreshed = meta.refreshToken
      ? await refreshLinearToken(workspaceId, meta).catch((err) => {
          logger.warn("linear token refresh failed", { workspaceId, err });
          return null;
        })
      : null;
    if (refreshed) return refreshed;
    // Expired and we can't refresh — the connection is effectively dead. Return
    // null so callers treat Linear as disconnected, rather than handing back a
    // stale token that Linear will reject on the next call.
    logger.warn("linear access token expired and could not be refreshed", { workspaceId });
    return null;
  }
  return accessToken;
}

/** Exchange a refresh token for a fresh access token and persist it. */
async function refreshLinearToken(workspaceId: string, meta: LinearSecretMeta): Promise<string | null> {
  const app = await getLinearAppConfig(workspaceId);
  if (!app || !meta.refreshToken) return null;
  const { clientId, clientSecret } = app;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: meta.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Linear token refresh ${res.status}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Linear token refresh: no access_token");

  const newMeta: LinearSecretMeta = {
    ...meta,
    refreshToken: json.refresh_token ?? meta.refreshToken,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : meta.expiresAt,
  };
  await workspaceSecrets.upsert({ workspaceId }, "linear_oauth", encrypt(json.access_token), newMeta);
  return json.access_token;
}

/** Resolve an explicit token, falling back to the env key. Throws when neither. */
function requireToken(token?: string): string {
  const tok = token ?? getLinearToken();
  if (!tok) throw new Error("Linear not connected (no OAuth token or LINEAR_API_KEY)");
  return tok;
}

async function gql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors?.length) throw new Error(`Linear GQL error: ${JSON.stringify(json.errors[0])}`);
  return json.data as T;
}

/** The authorizing identity + org for a token. Used at connect time to capture
 * the org id (for WorkspaceIdentity routing) and the bot's display name. */
export async function linearViewer(
  token: string,
): Promise<{ viewer: { id: string; name: string; email?: string } | null; organization: { id: string; name: string; urlKey: string } | null }> {
  const data = await gql<{
    viewer: { id: string; name: string; email?: string } | null;
    organization: { id: string; name: string; urlKey: string } | null;
  }>(
    `query Viewer { viewer { id name email } organization { id name urlKey } }`,
    {},
    token,
  );
  return { viewer: data.viewer ?? null, organization: data.organization ?? null };
}

/** List workspace members (id, name, email) for email-based user association. */
export async function listLinearMembers(
  token: string,
): Promise<{ id: string; name: string; email: string; active: boolean }[]> {
  const data = await gql<{ users: { nodes: { id: string; name: string; email: string; active: boolean }[] } }>(
    `query Members { users(first: 250, filter: { active: { eq: true } }) { nodes { id name email active } } }`,
    {},
    token,
  );
  return data.users.nodes;
}

export interface LinearProjectSummary {
  id: string;
  name: string;
  url: string;
}

export interface LinearBacklogIssue {
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
  project: LinearProjectSummary | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  team: { id: string; name: string; key: string } | null;
}

export interface LinearIssueLabel {
  id: string;
  name: string;
  team?: { id: string } | null;
}

export interface LinearIssueCreateOptions {
  description?: string;
  priority?: number;
  /** Label IDs to apply directly. */
  labelIds?: string[];
  /** Label names to resolve within the issue's team before creating. */
  labelNames?: string[];
  /** Linear user ID to assign on create. */
  assigneeId?: string;
  /** Slack thread permalink to attach to the issue after creation. */
  slackUrl?: string;
}

export interface LinearIssueUpdateOptions {
  /** Workflow state ID to move the issue to. */
  stateId?: string;
  /** Workflow state name to resolve within the issue's team, e.g. "Done". */
  stateName?: string;
  /** Label IDs to add while preserving existing labels. */
  labelIds?: string[];
  /** Label names to resolve within the issue's team before adding. */
  labelNames?: string[];
}

/** List all active Linear projects accessible with the configured token. */
export async function listLinearProjects(token?: string): Promise<LinearProjectSummary[]> {
  const tok = requireToken(token);
  const data = await gql<{ projects: { nodes: { id: string; name: string; url: string }[] } }>(
    `query Projects { projects(first: 250, filter: { archivedAt: { null: true } }) { nodes { id name url } } }`,
    {},
    tok,
  );
  return data.projects.nodes;
}

/** List the viewer's not-completed issues, grouped/sortable by Linear workflow state position. */
export async function listLinearIssuesAssignedTo(
  assigneeId: string,
  opts: { limit?: number } = {},
  token?: string,
): Promise<LinearBacklogIssue[]> {
  const tok = requireToken(token);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250); // Linear caps `first` at 250.
  const data = await gql<{
    issues: {
      nodes: Array<{
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
        project: { id: string; name: string; url: string } | null;
      }>;
    };
  }>(
    `query MyIssues($assigneeId: ID!, $limit: Int!) {
      issues(
        first: $limit,
        filter: {
          assignee: { id: { eq: $assigneeId } },
          state: { type: { in: ["backlog", "unstarted", "started"] } }
        },
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title description url updatedAt priority estimate
          state { id name type position }
          team { id name key }
          project { id name url }
        }
      }
    }`,
    { assigneeId, limit },
    tok,
  );
  return data.issues.nodes.sort((a, b) => {
    const byBacklog = Number(a.state.type === "backlog") - Number(b.state.type === "backlog");
    if (byBacklog !== 0) return byBacklog;
    const byState = a.state.position - b.state.position;
    if (byState !== 0) return byState;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/** List issues in a team, optionally filtered by state (e.g. "In Progress", "Todo"). */
export async function listLinearIssues(
  teamId: string,
  opts: { stateFilter?: string; limit?: number } = {},
  token?: string,
): Promise<{ id: string; identifier: string; title: string; state: string; assignee: string | null; assigneeId: string | null; url: string; updatedAt: string }[]> {
  const tok = requireToken(token);
  // Linear rejects `first` above 250, so a caller asking for more must be paged
  // rather than passed straight through (that used to fail the whole call).
  const cap = Math.min(Math.max(opts.limit ?? 25, 1), 500);
  // Pass the state name as a GraphQL variable — never interpolate it into the
  // query string, or a crafted stateFilter could alter the query structure.
  const filterExpr = opts.stateFilter
    ? `state: { name: { eq: $stateName } }`
    : `state: { type: { in: ["started", "unstarted"] } }`;
  const stateDecl = opts.stateFilter ? ", $stateName: String!" : "";
  type IssueNode = {
    id: string;
    identifier: string;
    title: string;
    state: { name: string };
    assignee: { id: string; name: string } | null;
    url: string;
    updatedAt: string;
  };
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  do {
    const pageSize = Math.min(250, cap - nodes.length);
    const data: { team: { issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } = await gql(
      `query Issues($teamId: String!, $first: Int!, $after: String${stateDecl}) {
        team(id: $teamId) {
          issues(filter: { ${filterExpr} }, first: $first, after: $after, orderBy: updatedAt) {
            nodes { id identifier title state { name } assignee { id name } url updatedAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId, first: pageSize, after, ...(opts.stateFilter ? { stateName: opts.stateFilter } : {}) },
      tok,
    );
    const page = data.team?.issues;
    if (!page) break;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after && nodes.length < cap);
  return nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    state: n.state.name,
    assignee: n.assignee?.name ?? null,
    assigneeId: n.assignee?.id ?? null,
    url: n.url,
    updatedAt: n.updatedAt,
  }));
}

/** List all Linear teams accessible with the configured token. */
export async function listLinearTeams(token?: string): Promise<{ id: string; name: string; key: string }[]> {
  const tok = requireToken(token);
  const data = await gql<{ teams: { nodes: { id: string; name: string; key: string }[] } }>(
    `query Teams { teams { nodes { id name key } } }`,
    {},
    tok,
  );
  return data.teams.nodes;
}

/** List workflow states across accessible Linear teams. */
export async function listLinearWorkflowStates(token?: string): Promise<LinearWorkflowState[]> {
  const tok = requireToken(token);
  type WorkflowStatesPage = {
    workflowStates: {
      nodes: LinearWorkflowState[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  const states: LinearWorkflowState[] = [];
  let after: string | null = null;
  do {
    const data: WorkflowStatesPage = await gql<WorkflowStatesPage>(
      `query WorkflowStates($after: String) {
        workflowStates(first: 250, after: $after, includeArchived: false) {
          nodes { id name type position team { id name key } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
      tok,
    );
    states.push(...data.workflowStates.nodes);
    after = data.workflowStates.pageInfo.hasNextPage ? data.workflowStates.pageInfo.endCursor : null;
  } while (after);
  return states.sort((a, b) => {
    const teamCompare = (a.team?.key ?? "").localeCompare(b.team?.key ?? "");
    return teamCompare || a.position - b.position || a.name.localeCompare(b.name);
  });
}

/** List issues in a workflow state, oldest-updated first. */
export async function listLinearIssuesByState(
  stateId: string,
  opts: { limit?: number } = {},
  token?: string,
): Promise<Array<{ id: string; identifier: string; title: string; description: string | null; url: string; updatedAt: string; state: { id: string; name: string; type: string }; team: { id: string; name: string; key: string } | null; project: LinearProjectSummary | null }>> {
  const tok = requireToken(token);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const data = await gql<{ issues: { nodes: Array<{ id: string; identifier: string; title: string; description: string | null; url: string; updatedAt: string; state: { id: string; name: string; type: string }; team: { id: string; name: string; key: string } | null; project: LinearProjectSummary | null }> } }>(
    `query IssuesByState($stateId: ID!, $limit: Int!) {
      issues(first: $limit, filter: { state: { id: { eq: $stateId } }, archivedAt: { null: true } }, orderBy: updatedAt) {
        nodes { id identifier title description url updatedAt state { id name type } team { id name key } project { id name url } }
      }
    }`,
    { stateId, limit },
    tok,
  );
  return data.issues.nodes;
}

/** List the issues of a Linear custom view, by the view's UUID. Custom views
 * hold a saved filter (and optional manual membership) that no team/state query
 * can reproduce, so this is the only way to enumerate one — e.g. an automation's
 * "aging candidates" triage view. Paginates through all matches (capped). */
export async function listLinearCustomViewIssues(
  viewId: string,
  opts: { limit?: number } = {},
  token?: string,
): Promise<{
  view: { id: string; name: string; description: string | null } | null;
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    updatedAt: string;
    priority: number;
    state: { id: string; name: string; type: string };
    assignee: { id: string; name: string } | null;
    team: { id: string; name: string; key: string } | null;
    project: LinearProjectSummary | null;
  }>;
}> {
  const tok = requireToken(token);
  const cap = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  type IssueNode = {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    updatedAt: string;
    priority: number;
    state: { id: string; name: string; type: string };
    assignee: { id: string; name: string } | null;
    team: { id: string; name: string; key: string } | null;
    project: LinearProjectSummary | null;
  };
  type Page = {
    customView: {
      id: string;
      name: string;
      description: string | null;
      issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null;
  };
  const issues: IssueNode[] = [];
  let after: string | null = null;
  let view: { id: string; name: string; description: string | null } | null = null;
  do {
    const pageSize = Math.min(250, cap - issues.length);
    const data: Page = await gql<Page>(
      `query CustomViewIssues($id: String!, $first: Int!, $after: String) {
        customView(id: $id) {
          id name description
          issues(first: $first, after: $after, orderBy: updatedAt) {
            nodes {
              id identifier title description url updatedAt priority
              state { id name type }
              assignee { id name }
              team { id name key }
              project { id name url }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: viewId, first: pageSize, after },
      tok,
    );
    if (!data.customView) return { view: null, issues: [] };
    view = { id: data.customView.id, name: data.customView.name, description: data.customView.description };
    issues.push(...data.customView.issues.nodes);
    after = data.customView.issues.pageInfo.hasNextPage ? data.customView.issues.pageInfo.endCursor : null;
  } while (after && issues.length < cap);
  return { view, issues };
}

/** Move an issue to a workflow state. issueId may be UUID or identifier. */
export async function moveLinearIssueToState(issueId: string, stateId: string, token?: string): Promise<void> {
  const tok = requireToken(token);
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation MoveIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input: { stateId } },
    tok,
  );
  if (!data.issueUpdate.success) throw new Error(`Linear issueUpdate failed`);
}

/** List issue labels available to a team. */
export async function listLinearIssueLabels(teamId: string, token?: string): Promise<LinearIssueLabel[]> {
  const tok = requireToken(token);
  const data = await gql<{ team: { labels: { nodes: LinearIssueLabel[] } } | null }>(
    `query IssueLabels($teamId: String!) {
      team(id: $teamId) { labels(first: 250) { nodes { id name team { id } } } }
    }`,
    { teamId },
    tok,
  );
  return data.team?.labels.nodes ?? [];
}

async function resolveLinearLabelIds(teamId: string, names: string[] | undefined, token: string): Promise<{ ids: string[]; missing: string[] }> {
  const wanted = Array.from(new Set((names ?? []).map((n) => n.trim()).filter(Boolean)));
  if (wanted.length === 0) return { ids: [], missing: [] };
  const globalNameCandidates = Array.from(new Set(wanted.flatMap((name) => [
    name,
    name.toLowerCase(),
    name.toUpperCase(),
    name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ])));
  const [teamLabels, globalLabels] = await Promise.all([
    listLinearIssueLabels(teamId, token),
    gql<{ issueLabels: { nodes: LinearIssueLabel[] } }>(
      `query GlobalIssueLabels($names: [String!]) {
        issueLabels(first: 250, filter: { name: { in: $names }, team: { null: true } }) { nodes { id name team { id } } }
      }`,
      { names: globalNameCandidates },
      token,
    ),
  ]);
  const labels = [...teamLabels, ...globalLabels.issueLabels.nodes];
  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const id = byName.get(name.toLowerCase());
    if (id) ids.push(id);
    else missing.push(name);
  }
  return { ids, missing };
}

export async function findLinearIssueBySlackUrl(
  slackUrl: string,
  token?: string,
): Promise<{ id: string; identifier: string; title: string; url: string } | null> {
  const tok = requireToken(token);
  const data = await gql<{
    attachmentsForURL: { nodes: Array<{ issue: { id: string; identifier: string; title: string; url: string; state: { type: string } } | null }> };
  }>(
    `query AttachedIssue($url: String!) {
      attachmentsForURL(url: $url, first: 5) {
        nodes { issue { id identifier title url state { type } } }
      }
    }`,
    { url: slackUrl },
    tok,
  );
  const openTypes = new Set(["triage", "backlog", "unstarted", "started"]);
  return data.attachmentsForURL.nodes.map((n) => n.issue).find((i): i is NonNullable<typeof i> => Boolean(i && openTypes.has(i.state.type))) ?? null;
}

function duplicateTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !new Set(["this", "that", "with", "from", "have", "when", "what", "does", "support", "issue", "ticket", "please", "help"]).has(t)),
  );
}

function duplicateScore(request: string, issue: { title: string; description?: string | null; comments?: { nodes?: Array<{ body?: string | null }> } }): number {
  const requestTokens = duplicateTokens(request);
  if (requestTokens.size === 0) return 0;
  const issueText = [issue.title, issue.description ?? "", ...(issue.comments?.nodes ?? []).map((c) => c.body ?? "")].join("\n");
  const issueTokens = duplicateTokens(issueText);
  let overlap = 0;
  for (const token of requestTokens) if (issueTokens.has(token)) overlap++;
  return overlap / requestTokens.size;
}

/**
 * Search open Linear issues for a likely duplicate, then read the top candidates'
 * title, description, and recent comments before returning a match. We only
 * accept high token overlap against the full issue body so a title-only fuzzy
 * hit in the same product area doesn't get treated as the same exact issue.
 */
export async function searchDuplicateLinearIssue(
  teamId: string,
  text: string,
  token?: string,
): Promise<{ id: string; identifier: string; title: string; url: string; state: string; duplicateScore: number } | null> {
  const tok = requireToken(token);
  const term = text.trim().slice(0, 200);
  if (term.length < 8) return null;
  const data = await gql<{
    searchIssues: { nodes: Array<{ id: string; identifier: string; title: string; url: string; team: { id: string }; state: { name: string; type: string } }> };
  }>(
    `query SearchIssues($term: String!) {
      searchIssues(term: $term, first: 8) {
        nodes { id identifier title url team { id } state { name type } }
      }
    }`,
    { term },
    tok,
  );
  const openTypes = new Set(["triage", "backlog", "unstarted", "started"]);
  const candidates = data.searchIssues.nodes.filter((issue) => issue.team.id === teamId && openTypes.has(issue.state.type)).slice(0, 3);
  for (const candidate of candidates) {
    const details = await gql<{
      issue: { id: string; identifier: string; title: string; description: string | null; url: string; state: { name: string }; comments: { nodes: Array<{ body: string | null }> } } | null;
    }>(
      `query DuplicateCandidate($id: String!) {
        issue(id: $id) {
          id identifier title description url
          state { name }
          comments(first: 5, orderBy: updatedAt) { nodes { body } }
        }
      }`,
      { id: candidate.id },
      tok,
    );
    if (!details.issue) continue;
    const score = duplicateScore(text, details.issue);
    if (score >= 0.55) {
      return {
        id: details.issue.id,
        identifier: details.issue.identifier,
        title: details.issue.title,
        url: details.issue.url,
        state: details.issue.state.name,
        duplicateScore: score,
      };
    }
  }
  return null;
}

export async function attachSlackUrlToLinearIssue(issueId: string, slackUrl: string, token?: string): Promise<boolean> {
  const tok = requireToken(token);
  const data = await gql<{ attachmentLinkSlack: { success: boolean } }>(
    `mutation AttachSlack($issueId: String!, $url: String!) {
      attachmentLinkSlack(issueId: $issueId, url: $url, syncToCommentThread: true) { success }
    }`,
    { issueId, url: slackUrl },
    tok,
  );
  return Boolean(data.attachmentLinkSlack.success);
}

/** Create a new Linear issue. Returns the identifier (e.g. "ENG-42") and URL. */
export async function createLinearIssue(
  teamId: string,
  title: string,
  descriptionOrOptions?: string | LinearIssueCreateOptions,
  priority?: number,
  token?: string,
): Promise<{ id: string; identifier: string; url: string; appliedLabelIds?: string[]; missingLabelNames?: string[] }> {
  const tok = requireToken(token);
  const opts: LinearIssueCreateOptions = typeof descriptionOrOptions === "object" && descriptionOrOptions !== null
    ? descriptionOrOptions
    : { ...(descriptionOrOptions ? { description: descriptionOrOptions } : {}), ...(priority !== undefined ? { priority } : {}) };
  const resolved = await resolveLinearLabelIds(teamId, opts.labelNames, tok);
  const labelIds = Array.from(new Set([...(opts.labelIds ?? []), ...resolved.ids].filter(Boolean)));
  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        teamId,
        title,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(opts.assigneeId ? { assigneeId: opts.assigneeId } : {}),
      },
    },
    tok,
  );
  if (!data.issueCreate.success) throw new Error(`Linear issueCreate failed`);
  if (opts.slackUrl) {
    await attachSlackUrlToLinearIssue(data.issueCreate.issue.id, opts.slackUrl, tok).catch((err) => logger.warn("linear slack attachment failed", { err }));
  }
  return { ...data.issueCreate.issue, ...(labelIds.length ? { appliedLabelIds: labelIds } : {}), ...(resolved.missing.length ? { missingLabelNames: resolved.missing } : {}) };
}

/**
 * Hand an existing issue to a Linear user for review. The issue is moved back
 * to Todo because the new assignee has not yet started their work.
 * issueId can be UUID or identifier.
 */
export async function assignLinearIssue(issueId: string, assigneeId: string, token?: string): Promise<void> {
  const tok = requireToken(token);
  const issueData = await gql<{ issue: { team: { id: string } | null } | null }>(
    `query IssueTeamForAssignment($id: String!) { issue(id: $id) { team { id } } }`,
    { id: issueId },
    tok,
  );
  const issue = issueData.issue;
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);

  const states = await listLinearWorkflowStates(tok);
  const todoState = states.find((state) =>
    state.team?.id === issue.team?.id && state.name.toLowerCase() === "todo"
  );
  if (!todoState) throw new Error(`Linear Todo workflow state not found for issue team`);

  const data = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation AssignIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input: { assigneeId, stateId: todoState.id } },
    tok,
  );
  if (!data.issueUpdate.success) throw new Error(`Linear issueUpdate failed`);
}

/** Update an existing issue's workflow state and/or add labels. issueId may be UUID or identifier. */
export async function updateLinearIssue(
  issueId: string,
  opts: LinearIssueUpdateOptions,
  token?: string,
): Promise<{ id: string; identifier: string; url: string; state: string; appliedLabelIds?: string[]; missingLabelNames?: string[] }> {
  const tok = requireToken(token);
  const issueData = await gql<{
    issue: { id: string; identifier: string; url: string; state: { id: string; name: string }; team: { id: string } | null; labels: { nodes: Array<{ id: string }> } } | null;
  }>(
    `query IssueForUpdate($id: String!) {
      issue(id: $id) { id identifier url state { id name } team { id } labels(first: 250) { nodes { id } } }
    }`,
    { id: issueId },
    tok,
  );
  const issue = issueData.issue;
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);

  let stateId = opts.stateId?.trim();
  if (!stateId && opts.stateName?.trim()) {
    const wanted = opts.stateName.trim().toLowerCase();
    const states = (await listLinearWorkflowStates(tok)).filter((s) => !issue.team?.id || s.team?.id === issue.team.id);
    const state = states.find((s) => s.name.toLowerCase() === wanted) ?? states.find((s) => s.name.toLowerCase().includes(wanted));
    if (!state) throw new Error(`Linear workflow state not found for issue team: ${opts.stateName}`);
    stateId = state.id;
  }

  const resolved = issue.team?.id
    ? await resolveLinearLabelIds(issue.team.id, opts.labelNames, tok)
    : { ids: [], missing: opts.labelNames?.filter((n) => n.trim()) ?? [] };
  const existingLabelIds = issue.labels.nodes.map((label) => label.id);
  const labelIdsToApply = Array.from(new Set([...(opts.labelIds ?? []), ...resolved.ids].map((id) => id.trim()).filter(Boolean)));
  const mergedLabelIds = Array.from(new Set([...existingLabelIds, ...labelIdsToApply]));
  const input = {
    ...(stateId ? { stateId } : {}),
    ...(labelIdsToApply.length > 0 ? { labelIds: mergedLabelIds } : {}),
  };
  if (Object.keys(input).length > 0) {
    const updated = await gql<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string; url: string; state: { name: string } } } }>(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier url state { name } } }
      }`,
      { id: issue.id, input },
      tok,
    );
    if (!updated.issueUpdate.success) throw new Error(`Linear issueUpdate failed`);
    return {
      id: updated.issueUpdate.issue.id,
      identifier: updated.issueUpdate.issue.identifier,
      url: updated.issueUpdate.issue.url,
      state: updated.issueUpdate.issue.state.name,
      ...(labelIdsToApply.length ? { appliedLabelIds: labelIdsToApply } : {}),
      ...(resolved.missing.length ? { missingLabelNames: resolved.missing } : {}),
    };
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    state: issue.state.name,
    ...(resolved.missing.length ? { missingLabelNames: resolved.missing } : {}),
  };
}

/** Fetch a single Linear issue by UUID or identifier (e.g. "ENG-42"). */
export async function getLinearIssue(
  issueId: string,
  token?: string,
): Promise<{ id: string; identifier: string; title: string; description: string; state: string; url: string; updatedAt: string; team: { id: string; name: string; key: string } | null; project: LinearProjectSummary | null } | null> {
  const tok = requireToken(token);
  const data = await gql<{ issue: { id: string; identifier: string; title: string; description: string; state: { name: string }; url: string; updatedAt: string; team: { id: string; name: string; key: string } | null; project: LinearProjectSummary | null } | null }>(
    `query GetIssue($id: String!) { issue(id: $id) { id identifier title description state { name } url updatedAt team { id name key } project { id name url } } }`,
    { id: issueId },
    tok,
  );
  if (!data.issue) return null;
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    title: data.issue.title,
    description: data.issue.description,
    state: data.issue.state.name,
    url: data.issue.url,
    updatedAt: data.issue.updatedAt,
    team: data.issue.team,
    project: data.issue.project,
  };
}

/** Post a comment on a Linear issue. issueId can be the UUID or the issue identifier (e.g. "ENG-123").
 * With an actor=app token the comment is attributed to the Manta bot. */
export async function commentOnIssue(issueId: string, body: string, token?: string, opts: { parentId?: string } = {}): Promise<void> {
  const tok = requireToken(token);

  // Resolve identifier → UUID if needed (identifiers look like "ENG-123").
  let resolvedId = issueId;
  if (/^[A-Z]+-\d+$/.test(issueId)) {
    const data = await gql<{ issue: { id: string } | null }>(
      `query GetIssue($id: String!) { issue(id: $id) { id } }`,
      { id: issueId },
      tok,
    );
    if (!data.issue) throw new Error(`Linear issue not found: ${issueId}`);
    resolvedId = data.issue.id;
  }

  await gql<unknown>(
    `mutation CreateComment($issueId: String!, $body: String!, $parentId: String) {
      commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
        success
      }
    }`,
    { issueId: resolvedId, body, parentId: opts.parentId ?? null },
    tok,
  );
}
