import { describe, expect, it } from "vitest";
import { orderedLinearStates } from "./linear.ts";
import type { LinearTicket } from "../api.ts";

function ticket(id: string, state: LinearTicket["state"]): LinearTicket {
  return {
    id,
    identifier: id,
    title: id,
    description: null,
    state,
    url: "https://linear.app/test/issue/" + id,
    updatedAt: "2026-06-17T00:00:00.000Z",
    priority: 0,
    estimate: null,
    team: null,
    project: null,
    repo: null,
  };
}

describe("orderedLinearStates", () => {
  it("shows actionable active states first and keeps backlog after active columns", () => {
    const backlog = { id: "backlog", name: "Backlog", type: "backlog", position: 3 };
    const upcoming = { id: "upcoming", name: "Upcoming", type: "unstarted", position: 2 };
    const onCall = { id: "on-call", name: "On call triage", type: "unstarted", position: 1 };
    const todo = { id: "todo", name: "Todo", type: "unstarted", position: 4 };

    expect(orderedLinearStates([
      ticket("ENG-1", backlog),
      ticket("ENG-2", upcoming),
      ticket("ENG-3", onCall),
      ticket("ENG-4", todo),
    ]).map((state) => state.name)).toEqual([
      "Todo",
      "Upcoming",
      "On call triage",
      "Backlog",
    ]);
  });
});
