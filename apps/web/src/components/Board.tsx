import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useStore } from "@nanostores/react";
import { COLUMNS, STATUS_LABELS, isUserDragAllowed, type CardStatus } from "@manta/shared";
import { api, type GithubPr, type LinearTicket, type Member, type TaskCard } from "../api.ts";
import { $activeWorkspaceId, $boardMode, $cards, $githubPrs, $linearTickets, $me, $members, $repos, addToast } from "../stores.ts";
import { refreshTasks } from "../actions.ts";
import { openTask } from "../ws.ts";
import { dateTime, relativeDate, repoShort, taskDisplayId } from "../lib/format.ts";
import { orderedLinearStates } from "../lib/linear.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { Modal } from "./ui.tsx";

type PrBadgeState = "closed" | "approved" | "passing" | "pending" | "failing" | "conflicts" | "unknown";

function prBadgeState(card: Pick<TaskCard, "prState" | "checksStatus" | "reviewDecision" | "mergeable">): PrBadgeState {
  if (card.prState?.toLowerCase() === "closed") return "closed";
  if (card.mergeable === "CONFLICTING") return "conflicts";
  if (card.checksStatus === "failing") return "failing";
  if (card.checksStatus === "pending") return "pending";
  if (card.checksStatus === "passing") return card.reviewDecision === "APPROVED" ? "approved" : "passing";
  return "unknown";
}

function PrStatusIcon({ state }: { state: PrBadgeState }) {
  if (state === "closed") return <span className="pr-closed-badge" aria-label="pull request closed">Closed</span>;
  if (state === "approved") return <span className="pr-icon" aria-label="checks passed and approved">✓</span>;
  if (state === "failing") return <span className="pr-icon" aria-label="checks failed">×</span>;
  if (state === "conflicts") return <span className="pr-conflicts">conflicts</span>;
  return <span className="pr-dot" aria-label={state === "pending" ? "checks in progress" : state === "passing" ? "checks passed, no reviews" : "checks unknown"} />;
}

export function PrBadge({ card, className = "pill pill-pr" }: { card: TaskCard; className?: string }) {
  const state = prBadgeState(card);
  return (
    <a className={`${className} pr-${state} checks-${card.checksStatus}`} href={card.prUrl ?? "#"} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <PrStatusIcon state={state} />
      PR #{card.prNumber}{className.includes("pr-badge") && card.prTitle ? ` — ${card.prTitle}` : ""}
    </a>
  );
}

function fixChecksLabel(card: TaskCard): string {
  const failed = (card.checks ?? []).filter((check) => check.status === "failing" && check.name?.trim());
  if (failed.length === 0) return "Fix checks";
  const first = failed[0]!.name!.trim();
  return failed.length === 1 ? `Fix ${first}` : `Fix ${first} +${failed.length - 1}`;
}

/** Mine ⇄ All-team ⇄ hidden-run debug scope toggle (lives in the board titlebar). */
export function BoardModeToggle() {
  const mode = useStore($boardMode);
  return (
    <div className="board-mode-toggle" role="tablist" aria-label="Board scope">
      <button className={`seg ${mode === "me" ? "on" : ""}`} role="tab" aria-selected={mode === "me"} onClick={() => $boardMode.set("me")}>Mine</button>
      <button className={`seg ${mode === "team" ? "on" : ""}`} role="tab" aria-selected={mode === "team"} onClick={() => $boardMode.set("team")}>All team</button>
      <button className={`seg ${mode === "automated" ? "on" : ""}`} role="tab" aria-selected={mode === "automated"} onClick={() => $boardMode.set("automated")}>Automated</button>
    </div>
  );
}

/** Shared board state + handlers threaded into the column/card renderers. */
interface BoardCtx {
  selectedCardId: string | null;
  onSelectCard: (id: string) => void;
  dragSrcId: string | null;
  setDragSrcId: (id: string | null) => void;
  dropTarget: string | null;
  setDropTarget: (s: string | null) => void;
  menuCardId: string | null;
  setMenuCardId: (id: string | null) => void;
  assigneeMenuCardId: string | null;
  setAssigneeMenuCardId: (id: string | null) => void;
  canDrop: (toStatus: string) => boolean;
  handleDrop: (toStatus: string) => void;
  handleMenuTransition: (cardId: string, toStatus: string) => void;
  clearInvestigationComplete: (cardIds: string[]) => void;
  handleReassignCard: (card: TaskCard, member: Member) => void;
  handleAutoMergeToggle: (card: TaskCard, enabled: boolean) => void;
  handleLinkPr: (card: TaskCard) => void;
  handleFixConflicts: (cardId: string) => void;
  fixingConflictsCardId: string | null;
  handleFixChecks: (cardId: string) => void;
  fixingChecksCardId: string | null;
  trackPr: (pr: GithubPr) => void;
  trackingPr: number | null;
  onOpenLinearTicket: (ticket: LinearTicket) => void;
  onNewCardForRepo: (repo: string) => void;
  expandedTerminal: Set<string>;
  toggleTerminal: (s: string) => void;
  memberById: Map<string, Member>;
  /** Show the creator avatar on cards (team mode). */
  showCreator: boolean;
}

function CreatorAvatar({ member }: { member: Member | undefined }) {
  if (!member) return null;
  const who = member.name ?? member.email;
  const initial = (who ?? "?").trim().charAt(0).toUpperCase();
  return member.avatarUrl
    ? <img className="creator-avatar" src={member.avatarUrl} alt={who ?? ""} title={who ?? ""} />
    : <span className="creator-avatar fallback" title={who ?? ""}>{initial}</span>;
}

function memberDisplayName(member: Member): string {
  return member.name?.trim() || member.email;
}

function CardArticle({ c, ctx }: { c: TaskCard; ctx: BoardCtx }) {
  const menuOpen = ctx.menuCardId === c.id;
  const assigneeMenuOpen = ctx.assigneeMenuCardId === c.id;
  const cctx = { hasPr: c.prNumber !== null, isPrOnly: false, isPrDraft: false };
  const menuTargets = COLUMNS
    .filter((mc) => mc.status !== c.cardStatus && isUserDragAllowed(c.cardStatus, mc.status, cctx))
    .map((mc) => mc.status);
  const creator = c.createdBy ? ctx.memberById.get(c.createdBy) : undefined;
  const canAutoMerge = c.prNumber !== null && c.cardStatus !== "done" && c.cardStatus !== "canceled" && c.prState !== "closed";
  const hasConflicts = c.prNumber !== null && c.mergeable === "CONFLICTING" && c.cardStatus !== "bot_working";
  const hasFailingChecks = c.prNumber !== null && c.checksStatus === "failing" && c.cardStatus !== "bot_working";
  const workerLive = c.workerActive && c.venueStatus === "active" && !["failed", "stalled"].includes(c.workerStatus);
  const workerVenueLabel = c.workerVenue === "daytona" ? "Cloud" : c.workerVenue === "laptop" ? "Local" : "Worker";
  const workerLiveTitle = `${workerVenueLabel} worker is connected and ${c.workerStatus}; venue ${c.venueStatus}`;
  return (
    <article
      draggable
      className={`card task ${ctx.selectedCardId === c.id ? "selected" : ""} ${ctx.dragSrcId === c.id ? "dragging" : ""} ${menuOpen || assigneeMenuOpen ? "menu-open" : ""}`}
      aria-selected={ctx.selectedCardId === c.id}
      onClick={() => { ctx.onSelectCard(c.id); openTask(c.id); }}
      onDragStart={() => { ctx.setDragSrcId(c.id); }}
      onDragEnd={() => { ctx.setDragSrcId(null); ctx.setDropTarget(null); }}
    >
      <div className="task-header">
        <span className="task-id">
          <span className="task-emoji">{c.characterEmoji ?? "🤖"}</span>
          {taskDisplayId(c)}
          {workerLive && <span className="worker-live-dot" title={workerLiveTitle} aria-label={workerLiveTitle} />}
          {c.autoMergeEnabled && <span className="auto-merge-icon" title="Auto-merge enabled" aria-label="Auto-merge enabled">⚡</span>}
        </span>
        <div className="card-header-actions">
          {ctx.memberById.size > 0 && (
            <div className="assignee-menu-wrap" onClick={(e) => e.stopPropagation()}>
              <button
                className="assignee-menu-btn"
                title={`Assign card${creator ? ` — currently ${memberDisplayName(creator)}` : ""}`}
                aria-label="Assign card"
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.setMenuCardId(null);
                  ctx.setAssigneeMenuCardId(assigneeMenuOpen ? null : c.id);
                }}
              >
                {creator ? <CreatorAvatar member={creator} /> : <span className="assignee-placeholder">?</span>}
              </button>
              {assigneeMenuOpen && (<><div className="menu-backdrop" onClick={() => ctx.setAssigneeMenuCardId(null)} /><div className="menu card-menu assignee-menu">
                <div className="menu-label">Assign to</div>
                {[...ctx.memberById.values()].map((member) => {
                  const isCurrent = c.createdBy === member.userId;
                  return (
                    <button
                      key={member.userId}
                      className="menu-item reassign-menu-item"
                      disabled={isCurrent}
                      onClick={() => { ctx.setAssigneeMenuCardId(null); ctx.handleReassignCard(c, member); }}
                    >
                      <span className="reassign-user-line">
                        <CreatorAvatar member={member} />
                        <span>{memberDisplayName(member)}{isCurrent ? " (current)" : ""}</span>
                      </span>
                      <span className={`reassign-worker-line ${member.localWorkerCount > 0 ? "online" : "offline"}`}>
                        {member.localWorkerCount > 0 ? `● ${member.localWorkerCount} local worker${member.localWorkerCount === 1 ? "" : "s"}` : "○ no local worker"}
                      </span>
                    </button>
                  );
                })}
              </div></>)}
            </div>
          )}
          <div className="card-menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="card-menu-btn" title="Card actions" onClick={(e) => { e.stopPropagation(); ctx.setAssigneeMenuCardId(null); ctx.setMenuCardId(menuOpen ? null : c.id); }}>···</button>
            {menuOpen && (<><div className="menu-backdrop" onClick={() => ctx.setMenuCardId(null)} /><div className="menu card-menu">
            {canAutoMerge && (
              <button className="menu-item" onClick={() => { ctx.setMenuCardId(null); ctx.handleAutoMergeToggle(c, !c.autoMergeEnabled); }}>
                {c.autoMergeEnabled ? "⚡ Disable auto-merge" : "⚡ Enable auto-merge"}
              </button>
            )}
            <button className="menu-item" onClick={() => { ctx.setMenuCardId(null); ctx.handleLinkPr(c); }}>
              🔗 {c.prNumber ? "Change linked PR…" : "Link PR…"}
            </button>
            {menuTargets.length > 0 && <div className="menu-separator" />}
            {menuTargets.map((s) => (<button key={s} className="menu-item" onClick={() => { ctx.setMenuCardId(null); ctx.handleMenuTransition(c.id, s); }}>{COLUMNS.find((mc) => mc.status === s)?.emoji} {STATUS_LABELS[s as CardStatus]}</button>))}
            </div></>)}
          </div>
        </div>
      </div>
      <div className="task-title">{c.title}</div>
      <div className="task-meta">
        {c.linearIssueIdentifier && (c.linearIssueUrl
          ? <a className="pill pill-linear" href={c.linearIssueUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{c.linearIssueIdentifier}</a>
          : <span className="pill pill-linear">{c.linearIssueIdentifier}</span>
        )}
        {c.prNumber && <PrBadge card={c} />}
        {hasConflicts && (
          <button
            className="btn small fix-conflicts-btn"
            disabled={ctx.fixingConflictsCardId === c.id}
            onClick={(e) => { e.stopPropagation(); ctx.handleFixConflicts(c.id); }}
          >
            {ctx.fixingConflictsCardId === c.id ? "Fixing…" : "Fix conflicts"}
          </button>
        )}
        {hasFailingChecks && (
          <button
            className="btn small fix-checks-btn"
            disabled={ctx.fixingChecksCardId === c.id}
            onClick={(e) => { e.stopPropagation(); ctx.handleFixChecks(c.id); }}
          >
            {ctx.fixingChecksCardId === c.id ? "Fixing…" : fixChecksLabel(c)}
          </button>
        )}
        <span className="task-date">{c.hidden && c.backgroundMode ? `Run ${dateTime(c.createdAt)}` : relativeDate(c.createdAt)}</span>
        {ctx.showCreator && <CreatorAvatar member={creator} />}
      </div>
    </article>
  );
}

function GithubPrCard({ pr, ctx }: { pr: GithubPr; ctx: BoardCtx }) {
  return (
    <article
      className={`card task github-pr ${ctx.trackingPr === pr.number ? "tracking" : ""}`}
      onClick={() => { if (ctx.trackingPr === null) ctx.trackPr(pr); }}
    >
      <div className="task-header">
        <span className="task-id">⬡ {pr.repo.split("/")[1]}</span>
        {ctx.showCreator && pr.author && <img className="creator-avatar" src={pr.author.avatarUrl} alt={pr.author.login} title={`@${pr.author.login}`} />}
      </div>
      <div className="task-title">{pr.title}</div>
      <div className="task-meta">
        <a className="pill pill-pr checks-unknown" href={pr.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><span className="pr-dot" />PR #{pr.number}</a>
        <span className="task-date">{relativeDate(pr.updatedAt)}</span>
      </div>
      <div className="github-pr-hint">{ctx.trackingPr === pr.number ? "Creating card…" : "Click to track"}</div>
    </article>
  );
}

function LinearTicketRow({ ticket, ctx }: { ticket: LinearTicket; ctx: BoardCtx }) {
  return (
    <div className="linear-ticket-row" onClick={() => ctx.onOpenLinearTicket(ticket)}>
      <span className="linear-ticket-dot" />
      <span className="linear-ticket-id">{ticket.identifier}</span>
      <span className="linear-ticket-title">{ticket.title}</span>
    </div>
  );
}

const COLUMN_PAGE_SIZE = 15;
const LINEAR_BACKLOG_LIMIT = 10;

function LimitedColumnItems<T>({
  items,
  renderItem,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(COLUMN_PAGE_SIZE);
  const visibleItems = items.slice(0, visibleCount);
  const hiddenCount = items.length - visibleItems.length;
  const nextCount = Math.min(COLUMN_PAGE_SIZE, hiddenCount);

  return (
    <>
      {visibleItems.map(renderItem)}
      {hiddenCount > 0 && (
        <button className="column-load-more" onClick={() => setVisibleCount((count) => count + COLUMN_PAGE_SIZE)}>
          Load {nextCount} more
        </button>
      )}
    </>
  );
}

function LinearBacklog({ tickets, ctx }: { tickets: LinearTicket[]; ctx: BoardCtx }) {
  const [expanded, setExpanded] = useState(false);
  const states = orderedLinearStates(tickets);
  const allRows: Array<{ stateId: string; ticket: LinearTicket }> = states.flatMap((s) =>
    tickets.filter((t) => t.state.id === s.id).map((t) => ({ stateId: s.id, ticket: t }))
  );
  const visible = expanded ? allRows : allRows.slice(0, LINEAR_BACKLOG_LIMIT);
  const hidden = allRows.length - LINEAR_BACKLOG_LIMIT;

  const rowsByState = new Map<string, LinearTicket[]>();
  for (const { stateId, ticket } of visible) {
    if (!rowsByState.has(stateId)) rowsByState.set(stateId, []);
    rowsByState.get(stateId)!.push(ticket);
  }

  return (
    <div className="linear-backlog">
      <div className="linear-backlog-title">📋 Linear — my backlog</div>
      {states.map((state) => {
        const stateTickets = rowsByState.get(state.id);
        if (!stateTickets?.length) return null;
        return (
          <div key={state.id} className="linear-status-group">
            <div className="linear-status-heading">
              <span className={`linear-state-dot state-${state.type}`} />
              {state.name.toUpperCase()} <span className="count">{tickets.filter((t) => t.state.id === state.id).length}</span>
            </div>
            {stateTickets.map((ticket) => <LinearTicketRow key={ticket.id} ticket={ticket} ctx={ctx} />)}
          </div>
        );
      })}
      {!expanded && hidden > 0 && (
        <button className="linear-show-more" onClick={() => setExpanded(true)}>Show {hidden} more</button>
      )}
      {expanded && allRows.length > LINEAR_BACKLOG_LIMIT && (
        <button className="linear-show-more" onClick={() => setExpanded(false)}>Show less</button>
      )}
    </div>
  );
}

interface RepoLane {
  repo: string;
  cards: TaskCard[];
  prs: GithubPr[];
  linearTickets: LinearTicket[];
}

const UNKNOWN_REPO = "__unknown_repo__";

function repoLaneLabel(repo: string) {
  return repo === UNKNOWN_REPO ? "No repo" : repoShort(repo);
}

function repoCanonicalizer(repoOrder: string[]) {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();
  const shortName = new Map<string, string | null>();
  for (const repo of repoOrder) {
    const trimmed = repo.trim();
    if (!trimmed) continue;
    exact.set(trimmed, trimmed);
    lower.set(trimmed.toLowerCase(), trimmed);
    const short = trimmed.split("/").pop()?.toLowerCase();
    if (short) shortName.set(short, shortName.has(short) ? null : trimmed);
  }
  return (repo: string | null) => {
    const trimmed = repo?.trim();
    if (!trimmed) return UNKNOWN_REPO;
    const normalized = trimmed.toLowerCase();
    const requestedName = normalized.split("/").pop() ?? normalized;
    return exact.get(trimmed) ?? lower.get(normalized) ?? shortName.get(requestedName) ?? trimmed;
  };
}

function buildRepoLanes(cards: TaskCard[], githubPrs: GithubPr[], linearTickets: LinearTicket[], repoOrder: string[]): RepoLane[] {
  const lanes = new Map<string, RepoLane>();
  const canonicalRepo = repoCanonicalizer(repoOrder);
  const canonicalRepoOrder = Array.from(new Set(repoOrder.map(canonicalRepo).filter((repo) => repo !== UNKNOWN_REPO)));
  const repoIndex = new Map(canonicalRepoOrder.map((repo, index) => [repo, index] as const));
  const bucket = (repo: string | null) => {
    const key = canonicalRepo(repo);
    let lane = lanes.get(key);
    if (!lane) { lane = { repo: key, cards: [], prs: [], linearTickets: [] }; lanes.set(key, lane); }
    return lane;
  };
  for (const repo of canonicalRepoOrder) bucket(repo);
  for (const c of cards) bucket(c.repo).cards.push(c);
  for (const pr of githubPrs) bucket(pr.repo).prs.push(pr);
  for (const ticket of linearTickets) bucket(ticket.repo).linearTickets.push(ticket);
  const sortRank = (repo: string) => repo === UNKNOWN_REPO ? Number.MAX_SAFE_INTEGER : repoIndex.get(repo) ?? canonicalRepoOrder.length;
  return [...lanes.values()]
    .filter((lane) => lane.cards.length > 0 || lane.prs.length > 0 || lane.linearTickets.length > 0)
    .sort((a, b) => sortRank(a.repo) - sortRank(b.repo) || repoLaneLabel(a.repo).localeCompare(repoLaneLabel(b.repo)));
}

function RepoSwimlaneBoard({ cards, githubPrs, linearTickets, ctx, empty }: { cards: TaskCard[]; githubPrs: GithubPr[]; linearTickets: LinearTicket[]; ctx: BoardCtx; empty?: ReactNode }) {
  const repos = useStore($repos);
  const lanes = buildRepoLanes(cards, githubPrs, linearTickets, repos.map((r) => r.orgRepo));
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const toggleRepo = (repo: string) =>
    setCollapsedRepos((prev) => { const next = new Set(prev); next.has(repo) ? next.delete(repo) : next.add(repo); return next; });

  return (
    <div className="board-swimlanes repo-swimlanes">
      {lanes.length === 0 && empty}
      {lanes.map((lane) => {
        const collapsed = collapsedRepos.has(lane.repo);
        return (
          <section key={lane.repo} className={`swimlane repo-swimlane ${collapsed ? "collapsed" : ""}`}>
            <div className="swimlane-head repo-swimlane-head">
              <button
                type="button"
                className="repo-swimlane-toggle"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${repoLaneLabel(lane.repo)}`}
                onClick={() => toggleRepo(lane.repo)}
              >
                <span className="repo-swimlane-icon">⬡</span>
                <span className="repo-swimlane-chevron" aria-hidden="true">{collapsed ? "▶" : "▼"}</span>
                <span className="swimlane-name">{repoLaneLabel(lane.repo)}</span>
                <span className="count">{lane.cards.length + lane.prs.length + lane.linearTickets.length}</span>
              </button>
              {lane.repo !== UNKNOWN_REPO && (
                <button
                  type="button"
                  className="btn ghost repo-new-card-btn"
                  title={`New card in ${lane.repo}`}
                  aria-label={`New card in ${lane.repo}`}
                  onClick={() => ctx.onNewCardForRepo(lane.repo)}
                >
                  +
                </button>
              )}
            </div>
            {!collapsed && (
              <div className="board swimlane-board">
                <BoardColumns cards={lane.cards} githubPrs={lane.prs} linearTickets={lane.linearTickets} ctx={ctx} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Renders the status columns (+ external backlog columns) for a given card subset. */
function BoardColumns({ cards, githubPrs, linearTickets, ctx }: { cards: TaskCard[]; githubPrs: GithubPr[]; linearTickets: LinearTicket[]; ctx: BoardCtx }) {
  const TERMINAL = new Set(["done", "canceled"]);
  const byStatus = (s: string) => cards.filter((c) => c.cardStatus === s);
  const columnCount = (s: string) => byStatus(s).length + (s === "backlog" ? linearTickets.length : 0);
  const alwaysOpen = new Set(["bot_working"]);
  const nonEmpty = COLUMNS.filter((c) => (columnCount(c.status) > 0 || alwaysOpen.has(c.status)) && !TERMINAL.has(c.status));
  const empty = COLUMNS.filter((c) => columnCount(c.status) === 0 && !alwaysOpen.has(c.status) && !TERMINAL.has(c.status));
  const terminalColumns = COLUMNS.filter((c) => TERMINAL.has(c.status));
  const terminal = terminalColumns.filter((c) => byStatus(c.status).length > 0 && !ctx.expandedTerminal.has(c.status));
  const expandedTerminalCols = terminalColumns.filter((c) => byStatus(c.status).length > 0 && ctx.expandedTerminal.has(c.status));

  const dropCls = (status: string) => ctx.dropTarget === status ? (ctx.canDrop(status) ? "drop-valid" : "drop-invalid") : "";
  const colHandlers = (status: string) => ({
    onDragOver: (e: DragEvent) => { if (ctx.dragSrcId) { e.preventDefault(); ctx.setDropTarget(status); } },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) ctx.setDropTarget(null); },
    onDrop: (e: DragEvent) => { e.preventDefault(); ctx.handleDrop(status); },
  });

  return (
    <>
      {nonEmpty.map((col) => (
        <section key={col.status} className={`column ${dropCls(col.status)}`} {...colHandlers(col.status)}>
          <h2>
            {col.emoji} {col.title} <span className="count">{columnCount(col.status)}</span>
            {col.status === "investigation_complete" && byStatus(col.status).length > 0 && (
              <button
                type="button"
                className="btn ghost clear-col-btn"
                title="Mark these investigations done and clear the column"
                onClick={() => ctx.clearInvestigationComplete(byStatus(col.status).map((c) => c.id))}
              >
                Clear
              </button>
            )}
          </h2>
          <LimitedColumnItems items={byStatus(col.status)} renderItem={(c) => <CardArticle key={c.id} c={c} ctx={ctx} />} />
          {col.status === "backlog" && linearTickets.length > 0 && (
            <LinearBacklog tickets={linearTickets} ctx={ctx} />
          )}
        </section>
      ))}
      {githubPrs.length > 0 && (
        <section className="column github-prs-col">
          <h2>⬡ GitHub PRs <span className="count">{githubPrs.length}</span></h2>
          <LimitedColumnItems items={githubPrs} renderItem={(pr) => <GithubPrCard key={`${pr.repo}#${pr.number}`} pr={pr} ctx={ctx} />} />
        </section>
      )}
      {expandedTerminalCols.map((col) => (
        <section key={col.status} className={`column terminal-expanded ${dropCls(col.status)}`} {...colHandlers(col.status)}>
          <h2>{col.emoji} {col.title} <span className="count">{byStatus(col.status).length}</span> <button className="btn ghost collapse-btn" onClick={() => ctx.toggleTerminal(col.status)}>✕</button></h2>
          <LimitedColumnItems items={byStatus(col.status)} renderItem={(c) => <CardArticle key={c.id} c={c} ctx={ctx} />} />
        </section>
      ))}
      {(empty.length > 0 || terminal.length > 0) && (
        <div className="collapsed-rail">
          {empty.map((col) => (
            <div key={col.status} className={`collapsed-col ${dropCls(col.status)}`} title={`${col.title} (empty)`} {...colHandlers(col.status)}>
              {col.emoji} {col.title} <span className="count">0</span>
            </div>
          ))}
          {terminal.map((col) => (
            <div key={col.status} className={`collapsed-col terminal-col ${dropCls(col.status)}`} title={`${col.title} — click to expand`} onClick={() => ctx.toggleTerminal(col.status)} {...colHandlers(col.status)}>
              {col.emoji} {col.title} <span className="count">{byStatus(col.status).length}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Board({
  selectedCardId,
  onSelectCard,
  onStartLinearTicket,
  onNewCardForRepo,
}: {
  selectedCardId: string | null;
  onSelectCard: (id: string) => void;
  onStartLinearTicket: (ticket: LinearTicket) => void;
  onNewCardForRepo: (repo: string) => void;
}) {
  const cards = useStore($cards);
  const githubPrs = useStore($githubPrs);
  const linearTickets = useStore($linearTickets);
  const me = useStore($me);
  const members = useStore($members);
  const mode = useStore($boardMode);
  const activeWorkspaceId = useStore($activeWorkspaceId)!;
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [trackingPr, setTrackingPr] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menuCardId, setMenuCardId] = useState<string | null>(null);
  const [assigneeMenuCardId, setAssigneeMenuCardId] = useState<string | null>(null);
  const [fixingConflictsCardId, setFixingConflictsCardId] = useState<string | null>(null);
  const [fixingChecksCardId, setFixingChecksCardId] = useState<string | null>(null);
  const [expandedTerminal, setExpandedTerminal] = useState<Set<string>>(new Set());
  const [selectedLinearTicket, setSelectedLinearTicket] = useState<LinearTicket | null>(null);

  const toggleTerminal = (status: string) =>
    setExpandedTerminal((prev) => { const next = new Set(prev); next.has(status) ? next.delete(status) : next.add(status); return next; });

  const dragSrc = dragSrcId ? cards.find((c) => c.id === dragSrcId) ?? null : null;

  const canDrop = (toStatus: string) => {
    if (!dragSrc) return false;
    return isUserDragAllowed(dragSrc.cardStatus, toStatus as CardStatus, {
      hasPr: dragSrc.prNumber !== null,
      isPrOnly: false,
      isPrDraft: false,
    });
  };

  const doTransition = async (cardId: string, toStatus: string) => {
    const snapshot = $cards.get();
    const previous = snapshot.find((c) => c.id === cardId);
    $cards.set(snapshot.map((c) => c.id === cardId ? { ...c, cardStatus: toStatus as CardStatus } : c));
    try {
      const doneReason = toStatus === "done" ? (previous?.cardStatus === "investigation_complete" ? "completed" : "abandoned") : undefined;
      await api.transitionStatus(activeWorkspaceId, cardId, toStatus, doneReason);
      await refreshTasks();
    } catch (err) {
      // Revert only the moved card so we don't clobber other updates that may
      // have landed (live ws pushes, concurrent transitions) since the snapshot.
      const prev = snapshot.find((c) => c.id === cardId);
      if (prev) $cards.set($cards.get().map((c) => c.id === cardId ? prev : c));
      addToast(err instanceof Error ? err.message : "Transition failed", "error");
    }
  };

  const handleDrop = (toStatus: string) => {
    if (!dragSrcId || !canDrop(toStatus)) return;
    const cardId = dragSrcId;
    setDragSrcId(null);
    setDropTarget(null);
    void doTransition(cardId, toStatus);
  };

  const handleMenuTransition = (cardId: string, toStatus: string) => {
    void doTransition(cardId, toStatus);
  };

  // Clear a (repo-lane) Investigation Complete column: mark exactly the cards the
  // member sees as done. Confirms first; optimistically drops them to done, reverts
  // the touched cards on failure.
  const handleClearInvestigationComplete = async (cardIds: string[]) => {
    const n = cardIds.length;
    if (n === 0) return;
    if (!window.confirm(`Mark ${n} investigation card${n === 1 ? "" : "s"} as done? ${n === 1 ? "It" : "They"}'ll move to Done.`)) return;
    const ids = new Set(cardIds);
    const snapshot = $cards.get();
    $cards.set(snapshot.map((c) => ids.has(c.id) ? { ...c, cardStatus: "done" as CardStatus } : c));
    try {
      const { cleared } = await api.clearInvestigationComplete(activeWorkspaceId, cardIds);
      await refreshTasks();
      addToast(`Cleared ${cleared} investigation card${cleared === 1 ? "" : "s"}.`, "info");
    } catch (err) {
      $cards.set($cards.get().map((c) => ids.has(c.id) ? (snapshot.find((p) => p.id === c.id) ?? c) : c));
      addToast(err instanceof Error ? err.message : "Failed to clear the column", "error");
    }
  };

  const handleReassignCard = async (card: TaskCard, member: Member) => {
    if (card.createdBy === member.userId) return;
    const snapshot = $cards.get();
    $cards.set(snapshot.map((c) => c.id === card.id ? { ...c, createdBy: member.userId } : c));
    try {
      await api.reassignTask(activeWorkspaceId, card.id, member.userId);
      await refreshTasks();
      addToast(`Reassigned to ${memberDisplayName(member)}.`, "info");
    } catch (err) {
      const prev = snapshot.find((c) => c.id === card.id);
      if (prev) $cards.set($cards.get().map((c) => c.id === card.id ? prev : c));
      addToast(err instanceof Error ? err.message : "Failed to reassign card", "error");
    }
  };

  const handleAutoMergeToggle = async (card: TaskCard, enabled: boolean) => {
    const snapshot = $cards.get();
    $cards.set(snapshot.map((c) => c.id === card.id ? { ...c, autoMergeEnabled: enabled } : c));
    try {
      await api.setAutoMerge(activeWorkspaceId, card.id, enabled);
      await refreshTasks();
    } catch (err) {
      const prev = snapshot.find((c) => c.id === card.id);
      if (prev) $cards.set($cards.get().map((c) => c.id === card.id ? prev : c));
      addToast(err instanceof Error ? err.message : "Failed to update auto-merge", "error");
    }
  };

  const handleLinkPr = async (card: TaskCard) => {
    const prUrl = window.prompt("Paste the GitHub PR URL", card.prUrl ?? "")?.trim();
    if (!prUrl) return;
    try {
      await api.linkTaskPr(activeWorkspaceId, card.id, prUrl);
      await refreshTasks();
      addToast("Linked PR to card.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to link PR";
      addToast({
        invalid_github_pr_url: "Paste a GitHub PR URL like https://github.com/org/repo/pull/123",
        pr_repo_mismatch: "That PR belongs to a different repo than this card.",
        pr_already_linked: "That PR is already linked to another card.",
      }[message] ?? message, "error");
    }
  };

  const handleFixConflicts = async (cardId: string) => {
    const snapshot = $cards.get();
    setFixingConflictsCardId(cardId);
    $cards.set(snapshot.map((c) => c.id === cardId ? { ...c, cardStatus: "bot_working" } : c));
    try {
      await api.fixConflicts(activeWorkspaceId, cardId);
      await refreshTasks();
      addToast("Asked the bot to fix conflicts and push.", "info");
    } catch (err) {
      const prev = snapshot.find((c) => c.id === cardId);
      if (prev) $cards.set($cards.get().map((c) => c.id === cardId ? prev : c));
      addToast(err instanceof Error ? err.message : "Failed to fix conflicts", "error");
    } finally {
      setFixingConflictsCardId(null);
    }
  };

  const handleFixChecks = async (cardId: string) => {
    const snapshot = $cards.get();
    setFixingChecksCardId(cardId);
    $cards.set(snapshot.map((c) => c.id === cardId ? { ...c, cardStatus: "bot_working" } : c));
    try {
      await api.fixChecks(activeWorkspaceId, cardId);
      await refreshTasks();
      addToast("Asked the bot to fix checks and push.", "info");
    } catch (err) {
      const prev = snapshot.find((c) => c.id === cardId);
      if (prev) $cards.set($cards.get().map((c) => c.id === cardId ? prev : c));
      addToast(err instanceof Error ? err.message : "Failed to fix checks", "error");
    } finally {
      setFixingChecksCardId(null);
    }
  };

  const trackPr = async (pr: GithubPr) => {
    setTrackingPr(pr.number);
    try {
      const result = await api.createCardFromPr(activeWorkspaceId, pr);
      await refreshTasks();
      onSelectCard(result.id);
      openTask(result.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to track PR", "error");
    } finally {
      setTrackingPr(null);
    }
  };

  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m] as const)), [members]);
  const visibleCards = cards.filter((c) => !c.hidden);
  const automatedCards = cards.filter((c) => c.hidden && (c.backgroundMode === "scheduled_slack" || c.backgroundMode === "spot_check" || c.backgroundMode === "linear_status_automation"));
  const ctx: BoardCtx = {
    selectedCardId, onSelectCard, dragSrcId, setDragSrcId, dropTarget, setDropTarget,
    menuCardId, setMenuCardId, assigneeMenuCardId, setAssigneeMenuCardId, canDrop, handleDrop, handleMenuTransition, clearInvestigationComplete: handleClearInvestigationComplete, handleReassignCard, handleAutoMergeToggle,
    handleLinkPr, handleFixConflicts, fixingConflictsCardId, handleFixChecks, fixingChecksCardId, trackPr, trackingPr,
    onOpenLinearTicket: setSelectedLinearTicket, onNewCardForRepo, expandedTerminal, toggleTerminal,
    memberById, showCreator: mode === "team",
  };

  const linearTicketModal = selectedLinearTicket && (
    <Modal title={`${selectedLinearTicket.identifier}: ${selectedLinearTicket.title}`} onClose={() => setSelectedLinearTicket(null)}>
      <div className="linear-ticket-detail">
        <div className="task-meta">
          <span className="pill pill-linear">{selectedLinearTicket.state.name}</span>
          {selectedLinearTicket.project && <span className="pill">{selectedLinearTicket.project.name}</span>}
          {selectedLinearTicket.team && <span className="pill">{selectedLinearTicket.team.key}</span>}
          {selectedLinearTicket.repo && <span className="pill">{repoShort(selectedLinearTicket.repo)}</span>}
        </div>
        <p className="muted small">Updated {relativeDate(selectedLinearTicket.updatedAt)}</p>
        {selectedLinearTicket.description?.trim() ? (
          <div
            className="linear-ticket-description markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedLinearTicket.description) }}
          />
        ) : (
          <div className="linear-ticket-description">No description.</div>
        )}
        <div className="modal-foot">
          <a className="btn" href={selectedLinearTicket.url} target="_blank" rel="noopener noreferrer">Open in Linear</a>
          <button className="btn primary" onClick={() => { const ticket = selectedLinearTicket; setSelectedLinearTicket(null); onStartLinearTicket(ticket); }}>
            Start work
          </button>
        </div>
      </div>
    </Modal>
  );

  // ── "Mine" — my cards + my PRs + assigned Linear tickets, separated into repo swimlanes ───────────────
  if (mode === "me") {
    const myCards = me ? visibleCards.filter((c) => c.createdBy === me.id) : visibleCards;
    const myLogin = me?.githubLogin?.toLowerCase();
    const myPrs = myLogin ? githubPrs.filter((pr) => pr.author?.login.toLowerCase() === myLogin) : [];
    return (
      <>
        <RepoSwimlaneBoard
          cards={myCards}
          githubPrs={myPrs}
          linearTickets={linearTickets}
          ctx={ctx}
          empty={(
            <div className="board-empty">
              <p>Nothing assigned to you yet.</p>
              <p className="muted">
                Press <kbd>c</kbd> or click <strong>+ New card</strong> to start something
                {me && !me.githubLogin ? <> — or link your GitHub account in <strong>Settings → Integrations</strong> to see your PRs here</> : null}.
              </p>
            </div>
          )}
        />
        {linearTicketModal}
      </>
    );
  }

  if (mode === "automated") {
    return (
      <>
        <RepoSwimlaneBoard
          cards={automatedCards}
          githubPrs={[]}
          linearTickets={[]}
          ctx={ctx}
          empty={<div className="board-empty"><p>No automated worker runs yet.</p></div>}
        />
        {linearTicketModal}
      </>
    );
  }

  // ── "All team" — all cards + PRs, separated into repo swimlanes ─────────────
  return (
    <>
      <RepoSwimlaneBoard
        cards={visibleCards}
        githubPrs={githubPrs}
        linearTickets={[]}
        ctx={ctx}
        empty={<div className="board-empty"><p>No cards yet.</p></div>}
      />
      {linearTicketModal}
    </>
  );
}
