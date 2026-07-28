import type { LinearTicket } from "../api.ts";

type LinearState = LinearTicket["state"];

function linearStateRank(state: Pick<LinearState, "type">): number {
  // Manta renders Linear workflow columns top-to-bottom inside the Backlog
  // column. Put the most actionable right-most kanban columns (e.g. Todo) first,
  // while keeping Linear's own Backlog category after active workflow states.
  return state.type === "backlog" ? 1 : 0;
}

export function compareLinearStates(a: LinearState, b: LinearState): number {
  const byRank = linearStateRank(a) - linearStateRank(b);
  if (byRank !== 0) return byRank;
  const byPosition = b.position - a.position;
  if (byPosition !== 0) return byPosition;
  return a.name.localeCompare(b.name);
}

export function orderedLinearStates(tickets: LinearTicket[]): LinearState[] {
  return Array.from(new Map(tickets.map((ticket) => [ticket.state.id, ticket.state])).values())
    .sort(compareLinearStates);
}
