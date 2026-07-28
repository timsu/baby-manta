// Rich board fixtures shared by the screenshot spec and any test that wants a
// busy world: varied statuses, PR/check states, live workers, Linear links.

import { ME_ID, MOCK_CARDS, type MockCard } from "./mockApi.ts";



function card(overrides: Partial<MockCard> & { id: string; title: string }): MockCard {
  return { ...MOCK_CARDS[0]!, taskNumber: null, ...overrides };
}

export const RICH_CARDS: MockCard[] = [
  card({ id: "b1", title: "Spike: evaluate pgvector for entity search", cardStatus: "backlog", taskNumber: 31, characterEmoji: "🧪" }),
  card({ id: "w1", title: "Fix login redirect loop on Safari", cardStatus: "bot_working", taskNumber: 32, characterEmoji: "🦊", workerActive: true, venueStatus: "active", workerStatus: "running", workerVenue: "laptop" }),
  card({ id: "w2", title: "Add retry budget to webhook dispatcher", cardStatus: "bot_working", taskNumber: 33, characterEmoji: "🐙", workerActive: true, venueStatus: "active", workerStatus: "running", workerVenue: "daytona" }),
  card({ id: "w3", title: "Migrate settings page to new form kit", cardStatus: "bot_working", taskNumber: 34, characterEmoji: "🦉" }),
  card({ id: "h1", title: "Worker stuck on flaky integration test", cardStatus: "needs_help", taskNumber: 35, characterEmoji: "🚨", prNumber: 118, prUrl: "https://github.com/acme/app/pull/118", checksStatus: "failing" }),
  card({ id: "t1", title: "Dark-mode contrast pass on dashboards", cardStatus: "ready_to_test", taskNumber: 36, characterEmoji: "🎨", prNumber: 121, prUrl: "https://github.com/acme/app/pull/121", checksStatus: "passing" }),
  card({ id: "i1", title: "Pair on the billing reconciliation script", cardStatus: "interactive", taskNumber: 37, characterEmoji: "🤝" }),
  card({ id: "p1", title: "Ship incremental Elasticsearch reindexer", cardStatus: "pr_review", taskNumber: 38, characterEmoji: "🚀", prNumber: 124, prUrl: "https://github.com/acme/app/pull/124", checksStatus: "passing", reviewDecision: "APPROVED", autoMergeEnabled: true, linearIssueIdentifier: "ENG-482" }),
  card({ id: "p2", title: "Rate-limit the public lists endpoint", cardStatus: "pr_review", taskNumber: 39, characterEmoji: "🛡", prNumber: 125, prUrl: "https://github.com/acme/app/pull/125", checksStatus: "passing", mergeable: "CONFLICTING" }),
  card({ id: "x1", title: "Why did Tuesday's digest skip 3 users?", cardStatus: "investigation_complete", taskNumber: 40, characterEmoji: "🔎", linearIssueIdentifier: "ENG-471" }),
  card({ id: "d1", title: "Bump Node to 24.5 across workers", cardStatus: "done", doneReason: "merged", taskNumber: 41, characterEmoji: "⚙️", prNumber: 112, checksStatus: "passing", updatedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }),
  card({ id: "d2", title: "Delete the legacy cron poller", cardStatus: "done", doneReason: "merged", taskNumber: 42, characterEmoji: "🧹", updatedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() }),
];

export const RICH_PRS = [
  { number: 130, title: "Add OTEL spans to sandbox boot", url: "https://github.com/acme/app/pull/130", branch: "otel-sandbox", repo: "acme/app", updatedAt: "2026-06-30T10:00:00Z", state: "OPEN", author: { login: "kris", avatarUrl: "" } },
  { number: 131, title: "Fix flaky worker heartbeat test", url: "https://github.com/acme/app/pull/131", branch: "fix-heartbeat", repo: "acme/app", updatedAt: "2026-06-30T11:00:00Z", state: "OPEN", author: { login: "frances", avatarUrl: "" } },
];

export const RICH_TICKETS = [
  { id: "lt1", identifier: "ENG-501", title: "Meeting prep misses external attendees", description: null, state: { id: "s1", name: "Todo", type: "unstarted", position: 0 }, url: "https://linear.app/x/ENG-501", updatedAt: "2026-06-30T09:00:00Z", priority: 2, estimate: null, team: null, project: null, repo: "acme/app" },
  { id: "lt2", identifier: "ENG-502", title: "Campaign digest dedupe misfires", description: null, state: { id: "s1", name: "Todo", type: "unstarted", position: 0 }, url: "https://linear.app/x/ENG-502", updatedAt: "2026-06-30T09:30:00Z", priority: 1, estimate: null, team: null, project: null, repo: "acme/app" },
];

export const RICH_MEMBERS = [
  { userId: ME_ID, email: "dog@example.com", name: "Dog Tester", avatarUrl: null, role: "owner", githubLogin: "dogtester", localWorkerCount: 1 },
  { userId: "user-2", email: "kris@example.com", name: "Kris Katta", avatarUrl: null, role: "member", githubLogin: "kris", localWorkerCount: 0 },
];

export const RICH_MEMBERSHIPS = [
  { workspaceId: "ws-1", slug: "acme", name: "Acme", role: "owner" },
  { workspaceId: "ws-2", slug: "beta", name: "Skunkworks", role: "member" },
];
