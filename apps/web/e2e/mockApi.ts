// Hermetic API mocks for e2e tests. Registers page.route handlers for every
// endpoint the app touches at boot plus the ones the tests drive, so tests run
// with no manta-server, database, or OAuth. Later registrations win in
// Playwright, so the catch-all goes first.

import type { Page } from "@playwright/test";

// Local mirror of the hook GameCanvas installs (the e2e tsconfig doesn't
// include src/, so the shape is redeclared here).
declare global {
  interface Window {
    __mantaGame?: {
      getState(): {
        dog: { x: number; z: number };
        modelLoaded: boolean;
        nearestId: string | null;
        carrying: string | null;
        wheel: { title: string; labels: string[]; selected: number } | null;
        linearFilter: string;
        zones: { status: string; x: number; z: number; radius: number }[];
        interactables: { id: string; kind: string; label: string; x: number; z: number }[];
      };
      setDogPosition(x: number, z: number): void;
      pressInteract(): void;
    };
  }
}

export const WS_ID = "ws-1";
export const ME_ID = "user-1";

/** Wire-shape of a board card as the tasks endpoint returns it. Kept wide
 *  (strings, nullables) so fixture files can vary every field. */
export interface MockCard {
  id: string;
  title: string;
  cardType: string;
  cardStatus: string;
  doneReason: string | null;
  hidden: boolean;
  backgroundMode: string | null;
  repo: string;
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  prTitle: string | null;
  checksStatus: string;
  checks: unknown[];
  reviewDecision: string | null;
  mergeable: string;
  autoMergeEnabled: boolean;
  workerStatus: string;
  workerActive: boolean;
  workerVenue: string;
  venueStatus: string;
  branch: string | null;
  characterEmoji: string | null;
  updatedAt: string;
  createdAt: string;
  taskNumber: number | null;
  linearIssueIdentifier: string | null;
  linearIssueUrl: string | null;
  createdBy: string | null;
  workerBackend: string;
  localWorkerStatus: string;
}

export const MOCK_CARDS: MockCard[] = [
  {
    id: "task-login",
    title: "Fix login bug",
    cardType: "bot",
    cardStatus: "bot_working",
    doneReason: null,
    hidden: false,
    backgroundMode: null,
    repo: "acme/app",
    prUrl: null,
    prNumber: null,
    prState: null,
    prTitle: null,
    checksStatus: "unknown",
    checks: [],
    reviewDecision: null,
    mergeable: "UNKNOWN",
    autoMergeEnabled: false,
    workerStatus: "pending",
    workerActive: false,
    workerVenue: "none",
    venueStatus: "none",
    branch: null,
    characterEmoji: null,
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    taskNumber: 1,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    createdBy: ME_ID,
    workerBackend: "test-backend",
    localWorkerStatus: "offline",
  },
  {
    id: "task-docs",
    title: "Write the docs",
    cardType: "bot",
    cardStatus: "done",
    doneReason: "merged",
    hidden: false,
    backgroundMode: null,
    repo: "acme/app",
    prUrl: null,
    prNumber: null,
    prState: null,
    prTitle: null,
    checksStatus: "unknown",
    checks: [],
    reviewDecision: null,
    mergeable: "UNKNOWN",
    autoMergeEnabled: false,
    workerStatus: "done",
    workerActive: false,
    workerVenue: "none",
    venueStatus: "none",
    branch: null,
    characterEmoji: null,
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    taskNumber: 2,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    createdBy: ME_ID,
    workerBackend: "test-backend",
    localWorkerStatus: "offline",
  },
];

const ME = {
  id: ME_ID,
  email: "dog@example.com",
  name: "Dog Tester",
  avatarUrl: null,
  githubLogin: "dogtester",
  githubNeedsRelink: false,
  slackUserId: null,
  linearUserId: null,
  workerEverConnected: true,
  localWorkerOnboardingDismissed: true,
  memberships: [{ workspaceId: WS_ID, slug: "acme", name: "Acme", role: "owner" }],
};

export interface MockApiOptions {
  cards?: typeof MOCK_CARDS;
  githubPrs?: unknown[];
  linearTickets?: unknown[];
  members?: unknown[];
  memberships?: { workspaceId: string; slug: string; name: string; role: string }[];
  spotChecks?: unknown[];
  spotCheckRuns?: unknown[];
}

export async function installMockApi(page: Page, opts: MockApiOptions = {}): Promise<void> {
  const cards = opts.cards ?? MOCK_CARDS;
  const me = { ...ME, memberships: opts.memberships ?? ME.memberships };
  const members = opts.members ?? [{ userId: ME_ID, email: ME.email, name: ME.name, avatarUrl: null, role: "owner", githubLogin: "dogtester", localWorkerCount: 1 }];
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // Catch-all so an unanticipated endpoint can never hang or hit a real server.
  await page.route("**/api/**", (route) => route.fulfill(json({})));

  await page.route("**/api/me", (route) => route.fulfill(json(me)));
  await page.route("**/api/version", (route) => route.fulfill(json({ gitHash: "e2e" })));
  await page.route("**/api/workers", (route) => route.fulfill(json({ workers: [], serverGitHash: "e2e" })));
  await page.route("**/api/sandboxes", (route) => route.fulfill(json({ sandboxes: [] })));
  await page.route(new RegExp(`/api/workspaces/${WS_ID}(\\?|$)`), (route) =>
    route.fulfill(json({ id: WS_ID, slug: "acme", name: "Acme", brainPrompt: "", teamMemory: "" })));
  await page.route(new RegExp(`/api/workspaces/${WS_ID}/tasks(\\?|$)`), (route) =>
    route.fulfill(json({ tasks: cards })));
  await page.route(new RegExp(`/api/workspaces/${WS_ID}/tasks/([^/?]+)$`), (route) => {
    const id = route.request().url().match(/\/tasks\/([^/?]+)$/)![1]!;
    const card = cards.find((c) => c.id === id) ?? cards[0]!;
    return route.fulfill(json({ ...card, description: "Mock task", checklist: [], terminalTabs: null, planDocument: null }));
  });
  await page.route(`**/api/workspaces/${WS_ID}/repos`, (route) =>
    route.fulfill(json({ repos: [{ id: "repo-1", orgRepo: "acme/app", defaultBranch: "main", enabled: true, setupCommands: "", globalInstructions: "", skillRepos: [] }] })));
  await page.route(`**/api/workspaces/${WS_ID}/members`, (route) =>
    route.fulfill(json({ members })));
  await page.route(`**/api/workspaces/${WS_ID}/models`, (route) =>
    route.fulfill(json({ models: [], defaultModel: null, scoutModel: null, cardModel: null, providers: [] })));
  await page.route(`**/api/workspaces/${WS_ID}/spot-checks`, (route) =>
    route.fulfill(json({ spotChecks: opts.spotChecks ?? [], runs: opts.spotCheckRuns ?? [] })));
  await page.route(`**/api/workspaces/${WS_ID}/github-prs`, (route) =>
    route.fulfill(json({ prs: opts.githubPrs ?? [] })));
  await page.route("**/api/linear/my-issues**", (route) =>
    route.fulfill(json({ issues: opts.linearTickets ?? [], needsLinearUser: false, connected: true })));
}

/** Read the game test hook state from the page. */
export async function gameState(page: Page) {
  return page.evaluate(() => {
    const api = window.__mantaGame;
    if (!api) throw new Error("__mantaGame hook not installed");
    return api.getState();
  });
}

/** Teleport the dog next to an interactable and wait for the prompt to
 *  acknowledge it as nearest. */
export async function walkDogTo(page: Page, interactableId: string): Promise<void> {
  await page.evaluate((id) => {
    const api = window.__mantaGame!;
    const target = api.getState().interactables.find((i) => i.id === id);
    if (!target) throw new Error(`no interactable ${id}; have: ${api.getState().interactables.map((i) => i.id).join(", ")}`);
    api.setDogPosition(target.x + 1, target.z + 1);
  }, interactableId);
  await page.waitForFunction((id) => window.__mantaGame?.getState().nearestId === id, interactableId);
}
