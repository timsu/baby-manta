import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    task: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    repo: {
      findUnique: vi.fn(),
    },
    taskTransition: {
      create: vi.fn(),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    },
    tasks: {
      newTaskId: vi.fn(() => "c-replacement"),
    },
  };
});

vi.mock("@manta/db", () => ({
  prisma: db.prisma,
  tasks: db.tasks,
}));

vi.mock("@manta/shared", () => ({
  isTransitionAllowed: vi.fn(() => true),
}));

import { recreateTaskInRepo } from "./switchRepo.ts";

const baseTask = {
  id: "c-original",
  workspaceId: "ws-1",
  name: "Wrong repo task",
  title: "Wrong repo task",
  description: "Do work",
  kind: "agent",
  cardType: "bot",
  cardStatus: "bot_working",
  repo: "acme/platform",
  workerBackend: "local",
  transitions: [],
  prNumber: null,
  prUrl: null,
  model: null,
  type: null,
  createdBy: null,
  linearIssueIdentifier: null,
  slackChannel: null,
  slackThreadTs: null,
  slackUserId: null,
  slackBotId: null,
};

function replacement(overrides: Record<string, unknown> = {}) {
  return {
    ...baseTask,
    ...overrides,
    id: "c-replacement",
  };
}

describe("recreateTaskInRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.tx.task.findFirst.mockResolvedValue(baseTask);
    db.tx.repo.findUnique.mockResolvedValue({ orgRepo: "acme/platform", enabled: true });
    db.tx.task.count.mockResolvedValue(7);
    db.tx.task.create.mockImplementation(async ({ data }) => replacement(data));
    db.tx.taskTransition.create.mockResolvedValue({});
    db.tx.task.update.mockResolvedValue({});
  });

  it("refreshes the card when the requested target matches the recorded repo", async () => {
    const result = await recreateTaskInRepo({
      workspaceId: "ws-1",
      taskId: "c-original",
      targetRepo: "acme/platform",
      reason: "worker checkout is for another repo",
    });

    expect(result.id).toBe("c-replacement");
    expect(result.repo).toBe("acme/platform");
    expect(db.tx.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        repo: "acme/platform",
        taskNumber: 8,
        cardStatus: "bot_working",
      }),
    }));
    expect(db.tx.task.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "c-original" },
      data: expect.objectContaining({
        cardStatus: "canceled",
        workerActive: false,
        workerStatus: "stalled",
      }),
    }));
    expect(db.tx.taskTransition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reason: "Refreshed as c-replacement in acme/platform: worker checkout is for another repo",
      }),
    }));
  });
});
