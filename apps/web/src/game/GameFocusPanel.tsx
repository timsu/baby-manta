// Fixed HUD inspector for the focused (nearest) world object — the pattern
// dense 3D games use: icons in the world, one always-legible detail panel in
// the corner. Crisp DOM text, so details never depend on sprite resolution.

import { checksColorCss, statusColorCss } from "./palette.ts";
import type { Interactable } from "./types.ts";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="game-focus-row">
      <span className="game-focus-key">{label}</span>
      <span className="game-focus-val">{children}</span>
    </div>
  );
}

export function GameFocusPanel({ focus }: { focus: Interactable | null }) {
  if (!focus) return null;
  const face = focus.data?.face;
  const pr = focus.data?.pr;
  const ticket = focus.data?.ticket;

  if (focus.kind === "card" && face) {
    return (
      <div className="game-focus" data-testid="game-focus">
        <div className="game-focus-head">
          <span>{face.emoji}</span>
          <span className="game-focus-id">{face.displayId}</span>
          <span className="game-focus-pill" style={{ color: statusColorCss(face.status), borderColor: statusColorCss(face.status) }}>
            {face.statusLabel}
          </span>
        </div>
        <div className="game-focus-title">{face.title}</div>
        <Row label="repo">{face.repo}</Row>
        {face.prNumber !== null && (
          <Row label="pr">
            <span style={{ color: checksColorCss(face.checksStatus, face.mergeable) }}>
              #{face.prNumber} · {face.mergeable === "CONFLICTING" ? "conflicts" : face.checksStatus}
            </span>
          </Row>
        )}
        {face.linearIssueIdentifier && <Row label="linear">{face.linearIssueIdentifier}</Row>}
        {face.assigneeName && <Row label="assignee">{face.assigneeName}</Row>}
        {face.workerLive && <Row label="worker"><span style={{ color: "#3ddc84" }}>● live</span></Row>}
      </div>
    );
  }

  if (focus.kind === "github-pr" && pr) {
    return (
      <div className="game-focus" data-testid="game-focus">
        <div className="game-focus-head">
          <span>⬡</span>
          <span className="game-focus-id" style={{ color: "#53d7a4" }}>PR #{pr.number}</span>
          <span className="game-focus-pill" style={{ color: "#53d7a4", borderColor: "#53d7a4" }}>untracked</span>
        </div>
        <div className="game-focus-title">{pr.title}</div>
        <Row label="repo">{pr.repo}</Row>
        <Row label="branch">{pr.branch}</Row>
        {pr.author && <Row label="author">@{pr.author.login}</Row>}
        <div className="game-focus-hint">E track as card</div>
      </div>
    );
  }

  if (focus.kind === "linear-ticket" && ticket) {
    const priority = ["none", "urgent", "high", "medium", "low"][ticket.priority] ?? "none";
    return (
      <div className="game-focus" data-testid="game-focus">
        <div className="game-focus-head">
          <span>📋</span>
          <span className="game-focus-id" style={{ color: "#8a63ff" }}>{ticket.identifier}</span>
          <span className="game-focus-pill" style={{ color: "#8a63ff", borderColor: "#8a63ff" }}>{ticket.state.name}</span>
        </div>
        <div className="game-focus-title">{ticket.title}</div>
        {ticket.repo && <Row label="repo">{ticket.repo}</Row>}
        {ticket.priority > 0 && <Row label="priority">{priority}</Row>}
        <div className="game-focus-hint">E start a card</div>
      </div>
    );
  }

  if (focus.kind === "linear-depot") {
    const filters = focus.data?.ticketFilters ?? [];
    const current = filters.find((f) => f.label === focus.data?.ticketFilter);
    return (
      <div className="game-focus" data-testid="game-focus">
        <div className="game-focus-head">
          <span>📋</span>
          <span className="game-focus-id" style={{ color: "#8a63ff" }}>LINEAR YARD</span>
          <span className="game-focus-pill" style={{ color: "#8a63ff", borderColor: "#8a63ff" }}>
            {current ? `${current.label} · ${current.count}` : "empty"}
          </span>
        </div>
        <div className="game-focus-title">Showing "{current?.label ?? focus.data?.ticketFilter}" tickets</div>
        {filters.filter((f) => f.label !== focus.data?.ticketFilter).map((f) => (
          <div className="game-focus-row" key={f.label}>
            <span className="game-focus-key">{f.label}</span>
            <span className="game-focus-val">{f.count}</span>
          </div>
        ))}
        <div className="game-focus-hint">E browse · pick "Showing:" to switch status</div>
      </div>
    );
  }

  // PR depot, portals, question beacons: label is the summary.
  return (
    <div className="game-focus" data-testid="game-focus">
      <div className="game-focus-title">{focus.label}</div>
    </div>
  );
}
