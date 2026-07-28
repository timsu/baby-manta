import { afterEach, describe, expect, it, vi } from "vitest";
import { assignLinearIssue, commentOnIssue, listLinearIssues } from "./client.ts";

describe("listLinearIssues", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const issuePage = (ids: string[], hasNextPage: boolean, endCursor: string | null) => ({
    ok: true,
    json: async () => ({
      data: {
        team: {
          issues: {
            nodes: ids.map((id) => ({
              id,
              identifier: `ENG-${id}`,
              title: `Issue ${id}`,
              state: { name: "Todo" },
              assignee: { id: `user-${id}`, name: `User ${id}` },
              url: `https://linear.app/issue/${id}`,
              updatedAt: "2026-07-27T00:00:00.000Z",
            })),
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    }),
  }) as Response;

  it("pages a limit above Linear's 250 max instead of sending it as `first`", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(issuePage(["a"], true, "cursor-1"))
      .mockResolvedValueOnce(issuePage(["b"], false, null));

    const issues = await listLinearIssues("DST", { stateFilter: "Todo", limit: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(first.variables).toMatchObject({ teamId: "DST", first: 250, after: null, stateName: "Todo" });
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(second.variables).toMatchObject({ first: 250, after: "cursor-1" });
    expect(issues.map((issue) => issue.assignee)).toEqual(["User a", "User b"]);
  });

  it("returns an empty list when the team does not resolve", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: { team: null } }),
    } as Response);

    expect(await listLinearIssues("nope")).toEqual([]);
  });
});

describe("commentOnIssue", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes parentId when creating threaded Linear replies", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: { commentCreate: { success: true } } }),
    } as Response);

    await commentOnIssue("11111111-1111-4111-8111-111111111111", "Threaded reply", undefined, { parentId: "comment-parent" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.variables).toEqual({
      issueId: "11111111-1111-4111-8111-111111111111",
      body: "Threaded reply",
      parentId: "comment-parent",
    });
  });
});

describe("assignLinearIssue", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("moves the issue to Todo while assigning the reviewer", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { issue: { team: { id: "team-1" } } } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: "review-state", name: "In Review", type: "started", position: 2, team: { id: "team-1", name: "Engineering", key: "ENG" } },
                { id: "todo-state", name: "Todo", type: "unstarted", position: 1, team: { id: "team-1", name: "Engineering", key: "ENG" } },
                { id: "other-todo", name: "Todo", type: "unstarted", position: 1, team: { id: "team-2", name: "Product", key: "PROD" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { issueUpdate: { success: true } } }),
      } as Response);

    await assignLinearIssue("ENG-42", "engineer-1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const mutationBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(mutationBody.variables).toEqual({
      id: "ENG-42",
      input: { assigneeId: "engineer-1", stateId: "todo-state" },
    });
  });
});
