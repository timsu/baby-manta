// Shared fixtures for game unit tests.

import type { GithubPr, LinearTicket, Member, TaskCard } from "../api.ts";

export function makeCard(overrides: Partial<TaskCard> & { id: string }): TaskCard {
  return {
    title: overrides.id,
    cardType: "bot",
    cardStatus: "bot_working",
    doneReason: null,
    hidden: false,
    backgroundMode: null,
    repo: "org/repo",
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
    taskNumber: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    createdBy: "user-1",
    workerBackend: "test",
    localWorkerStatus: "offline",
    ...overrides,
  };
}

export function makePr(overrides: Partial<GithubPr> & { number: number }): GithubPr {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/org/repo/pull/${overrides.number}`,
    branch: "feature",
    repo: "org/repo",
    updatedAt: "2026-01-01T00:00:00Z",
    state: "OPEN",
    author: null,
    ...overrides,
  };
}

export function makeMember(overrides: Partial<Member> & { userId: string }): Member {
  return {
    role: "member",
    email: `${overrides.userId}@example.com`,
    name: null,
    avatarUrl: null,
    githubLogin: null,
    nonEngineer: false,
    localWorkerCount: 0,
    ...overrides,
  };
}

export function makeTicket(overrides: Partial<LinearTicket> & { identifier: string }): LinearTicket {
  return {
    id: overrides.identifier,
    title: `Ticket ${overrides.identifier}`,
    description: null,
    state: { id: "s1", name: "Todo", type: "unstarted", position: 0 },
    url: `https://linear.app/org/issue/${overrides.identifier}`,
    updatedAt: "2026-01-01T00:00:00Z",
    priority: 0,
    estimate: null,
    team: null,
    project: null,
    repo: null,
    ...overrides,
  };
}
