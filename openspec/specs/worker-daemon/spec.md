# Worker Daemon

How local or cloud worker daemons authenticate, receive task context, and report task progress back
to Manta.

## Purpose

Defines existing worker-facing behavior: browser pairing, worker token access, websocket presence,
worker-owned task updates, provider credential access, Linear/GitHub helper operations, and browser
visibility into connected workers.

## Requirements

### Requirement: Users can pair a worker daemon from the browser

The system SHALL redirect daemon pairing requests into the web app and SHALL mint per-user worker
tokens after the browser user confirms pairing.

#### Scenario: Daemon starts pairing

- **WHEN** a daemon opens the pairing endpoint with callback state
- **THEN** the system redirects to the web app pairing view with the callback state preserved

#### Scenario: Browser confirms pairing

- **GIVEN** the browser user is authenticated
- **WHEN** the user pairs a worker name
- **THEN** the system returns a worker token and user identity details for the daemon

### Requirement: Worker API access uses worker credentials

The system SHALL authenticate worker daemon HTTP and websocket access with worker credentials rather
than browser session cookies.

#### Scenario: Worker calls a task endpoint

- **WHEN** a worker calls a worker API endpoint with a valid worker token
- **THEN** the system authorizes the request according to the token principal and task/workspace
  scope

### Requirement: Workers can report task state changes

The system SHALL let an authorized worker report a pull request, update a checklist, rename a card,
recreate a wrong-repo card in another enabled workspace repository, or move a card to Needs Help for
a task the worker is authorized to operate on.

#### Scenario: Worker reports a pull request

- **GIVEN** the worker is authorized for the task and workspace
- **WHEN** it reports pull request metadata
- **THEN** the system records the pull request on the task

#### Scenario: Worker requests Needs Help

- **GIVEN** the worker is authorized for the task and workspace
- **WHEN** it sends a Needs Help reason
- **THEN** the system moves the task to the Needs Help state with that reason

#### Scenario: Worker switches a wrong-repo card

- **GIVEN** the worker is authorized for the task and workspace
- **AND** the target repository is enabled in the same workspace
- **AND** the task has not reported a pull request
- **WHEN** the worker switches the card to the target repository with a reason
- **THEN** the system creates a replacement task in the target repository using the original title,
  instructions, and embedded image references
- **AND** the replacement task gets a task number for the target repository
- **AND** the system attempts to start the replacement task with the copied instructions
- **AND** the original task is canceled with an audit note pointing to the replacement task
- **AND** the original task's worker runtime is stopped

#### Scenario: Worker cannot switch to an unavailable repository

- **GIVEN** the worker is authorized for the task and workspace
- **WHEN** it requests a repository switch to a repository that is not enabled in the workspace
- **THEN** the system rejects the switch and leaves the task repository unchanged

### Requirement: Terminal card states dispose worker task runtime

When a user moves a card to a terminal board state, the system SHALL dispose the task runtime held
by any connected worker for that card.

#### Scenario: User marks a task done or canceled

- **GIVEN** a task has an active worker turn or open task terminals
- **WHEN** a workspace member moves the task to Done or Canceled
- **THEN** the system asks the worker holding the task to abort task work and close all task terminals
- **AND** terminal child processes started from those shells are terminated
- **AND** the system clears active worker routing for that task

### Requirement: Workers can request scoped external-service helpers

The system SHALL provide worker endpoints for workspace listing, provider credentials, Linear issue
lookup/enumeration/commenting/assignment, GitHub token retrieval, and GitHub pull request creation, constrained by the worker
principal's authorized workspaces and tasks. Linear enumeration SHALL cover both listing a team's open
issues and enumerating a Linear custom view by its UUID, so a worker can triage a saved set of issues
rather than only single tickets it already knows by identifier.

Workers SHALL also be able to post Slack messages through enabled bots configured for the task's
workspace without receiving those bots' credentials. A worker MAY select a configured bot by name or
ID; when exactly one bot is enabled, the system SHALL use it by default.

#### Scenario: Worker enumerates a Linear custom view

- **WHEN** an authorized worker requests the issues of a Linear custom view by its UUID
- **THEN** the system proxies the read through the workspace Linear token and returns the view's issues
  (identifier, title, state, assignee, description)
- **AND** the worker never receives the Linear token
- **AND** read-only background runs (e.g. spot checks) are granted the enumeration tools alongside single-issue lookup

#### Scenario: Worker requests a GitHub token

- **WHEN** an authorized worker requests a token for a repository it needs for a task
- **THEN** the system returns a short-lived or scoped GitHub credential when available

#### Scenario: Worker creates a pull request

- **WHEN** an authorized worker submits pull request creation details
- **THEN** the system creates the pull request using the linked user or app credentials available
  for that workspace/repository
- **AND** the pull request body includes a permalink to the Manta task conversation transcript

#### Scenario: Worker posts to a Slack channel or thread

- **GIVEN** an authorized worker task belongs to a workspace with an enabled Slack bot
- **WHEN** the worker posts to a channel ID, optionally with a parent message timestamp
- **THEN** the system posts the message as the selected configured bot
- **AND** a parent message timestamp causes the message to be posted as a thread reply
- **AND** the worker never receives the Slack bot token

#### Scenario: Worker sends a Slack direct message

- **GIVEN** an authorized worker task belongs to a workspace with an enabled Slack bot
- **WHEN** the worker posts to a Slack user ID
- **THEN** the system opens that bot's direct-message conversation with the user and posts the message

#### Scenario: Worker must disambiguate configured Slack bots

- **GIVEN** a workspace has more than one enabled Slack bot
- **WHEN** a worker posts without selecting a bot
- **THEN** the system rejects the post and identifies the configured bots that can be selected

#### Scenario: Non-engineer PR gets engineer review routing

- **GIVEN** the task creator is marked as a non-engineer
- **AND** another workspace member is marked as an engineer and has a linked GitHub login
- **WHEN** an authorized worker creates a pull request for that task
- **THEN** the system prefers an engineer whose linked GitHub login appears in recent history for
  the pull request's changed files
- **AND** falls back to another eligible engineer when history does not identify a reviewer
- **AND** requests review from the selected engineer's GitHub login
- **AND** posts a pull request comment tagging that engineer for review

#### Scenario: Worker requests brain orchestration

- **WHEN** an authorized worker sends a handoff message for its task
- **THEN** the system queues the message in the workspace brain inbox
- **AND** the message includes the originating task and linked Linear/PR context when available
- **AND** the system starts a brain turn to process worker handoff inbox items when brain runtime is available
- **AND** the worker does not receive direct permission to create Manta cards

#### Scenario: Worker assigns a linked Linear issue

- **WHEN** an authorized worker lists Linear members and assigns its linked Linear issue to a member
- **THEN** the system proxies the assignment through the workspace Linear app OAuth token
- **AND** moves the issue to the workflow state named "Todo" so the new assignee's review work has not started
- **AND** the worker never receives the Linear token

### Requirement: Browser users can see connected workers

The system SHALL list connected worker daemons owned by the current browser user by default, SHALL
allow the user to expand the worker panel to workers owned by members of any workspace the user
belongs to, and SHALL enrich active task information only for workspaces the user belongs to.

#### Scenario: User opens worker menu

- **WHEN** the current user requests connected workers
- **THEN** the system returns only workers owned by that user
- **AND** includes active task details only when the user is a member of the task's workspace

### Requirement: Users can chat with an agent in a repository checkout

The system SHALL let a workspace member select an enabled repository and available model, then chat
with an agent running in a checkout on one of that member's local worker daemons. The repo-chat agent
SHALL have read-only checkout tools and a curated set of workspace orchestration tools, including the
ability to create a card. Repo chat SHALL NOT fall back to a teammate's daemon or a cloud sandbox.

#### Scenario: User starts repo chat

- **GIVEN** the user has a compatible local worker connected
- **WHEN** they select an enabled repository and available model and send a message
- **THEN** the system runs the turn in a checkout of that repository on the user's worker
- **AND** streams agent reasoning, tool activity, and the answer into the repo chat
- **AND** includes prior visible user and assistant messages as conversation context

#### Scenario: Repo chat initializes the model picker

- **GIVEN** the workspace default model is available to the user
- **WHEN** they open repo chat
- **THEN** the model picker selects the workspace default model

#### Scenario: Repo chat creates a card

- **WHEN** the repo-chat agent calls its create-card tool
- **THEN** the system creates the card in the same workspace as the requesting user
- **AND** constrains the target to an enabled workspace repository
- **AND** starts work according to the requested card type

#### Scenario: No compatible local worker is connected

- **GIVEN** the user has no live local worker advertising repo-chat support
- **WHEN** they open repo chat
- **THEN** the UI explains that a local worker is required
- **AND** sending is unavailable
- **AND** the system does not start a cloud worker

#### Scenario: Connected worker predates repo-chat support

- **GIVEN** the user has a connected local worker that does not advertise repo-chat support
- **WHEN** the worker registers with the server
- **THEN** the server requests a worker update to a repo-chat-capable version

#### Scenario: User shows team workers

- **GIVEN** the current user belongs to a workspace with other members
- **WHEN** the user enables team-wide workers in the worker panel
- **THEN** the system returns workers owned by members of the user's workspaces
- **AND** identifies each worker's owner for display
- **AND** includes active task details only when the user is a member of the task's workspace

### Requirement: Task chat surfaces worker routing state

The system SHALL expose whether a task owner's local worker is online, recently disconnected and
expected to reconnect, or offline, SHALL expose a cloud task's sandbox lifecycle, and the task chat
SHALL show a bottom-of-chat notice describing the worker endpoint that messages will target,
including when sending would wait for a reconnecting worker, wake an asleep cloud sandbox, or fall
back to cloud.

#### Scenario: Worker endpoint is connected

- **GIVEN** a task has a connected local worker or active cloud sandbox
- **WHEN** a workspace member views the task chat
- **THEN** the chat shows a bottom notice identifying whether messages go to the local worker or cloud sandbox

#### Scenario: Local worker is reconnecting

- **GIVEN** a task owner had a local worker present within the reconnect grace window
- **AND** no live local worker connection is currently available
- **WHEN** a workspace member views the task chat for a non-cloud task
- **THEN** the chat shows "Worker is reconnecting... please give it a moment"

#### Scenario: Local worker is offline

- **GIVEN** a task owner has no live local worker and no recent reconnect presence
- **WHEN** a workspace member views the task chat for a non-cloud task
- **THEN** the chat shows "No local worker - messaging will spin up a cloud worker"
- **AND** sending a message uses the existing cloud fallback path when no local worker reconnects

#### Scenario: Cloud sandbox is reconnecting or asleep

- **GIVEN** a task uses the cloud worker venue
- **WHEN** the cloud sandbox is provisioning, stopped, or failed
- **THEN** the chat shows a bottom notice describing whether the sandbox is reconnecting, asleep and wakeable, or unavailable

### Requirement: Users can request worker self-update

The system SHALL allow a user to request an update for one of their connected workers and SHALL
return not found when no matching worker is available for that user.

#### Scenario: Worker update requested

- **WHEN** a user requests update for a connected worker they own
- **THEN** the system signals that worker to update

### Requirement: Outdated workers stay connected and self-update

The system SHALL enforce a minimum worker protocol version without locking out
older daemons: an outdated worker SHALL be allowed to register and serve tasks
while being signaled to update, and the daemon SHALL update itself rather than
re-pairing.

#### Scenario: Outdated worker registers

- **GIVEN** a worker reports a protocol version below the server minimum
- **WHEN** it registers over the worker websocket
- **THEN** the system registers it normally so it can keep serving tasks
- **AND** the system signals that worker to update

#### Scenario: Update deferred while worker is busy

- **GIVEN** a worker has been signaled to update
- **WHEN** the worker has active work
- **THEN** the daemon retries the update on a short cadence until it is idle, then restarts to update
- **AND** the daemon does not clear its stored credential or re-pair

### Requirement: Background workers get the user's interactive shell environment

The system SHALL run worker task commands with the environment the user gets in a terminal, even when
the worker was installed as a login service whose shell does not read interactive startup files. A
variable exported only from an interactive startup file SHALL therefore be available to task commands
without the user configuring anything per machine.

#### Scenario: Variable exported only from an interactive startup file

- **GIVEN** a user exports a variable from an interactive shell startup file
- **WHEN** the worker starts as a background login service
- **THEN** commands the worker runs for a task see that variable

#### Scenario: Explicit worker configuration wins

- **GIVEN** a variable is set both by the user's interactive shell and by explicit worker config
- **WHEN** the worker starts
- **THEN** the explicit worker config value is used

#### Scenario: Interactive startup files do not stall the worker

- **GIVEN** a user's interactive shell startup file hangs or waits for input
- **WHEN** the worker starts
- **THEN** the worker stops waiting for that environment and starts serving tasks anyway

### Requirement: Worker checkouts maintain remote-tracking refs

The system SHALL configure worker repo caches so plain Git fetches in Manta-created worktrees update
remote-tracking branch refs for origin.

#### Scenario: Agent fetches a worker worktree

- **GIVEN** a worker has provisioned a task or question worktree from a cached repo
- **WHEN** an agent runs `git fetch` or `git fetch origin` in that worktree
- **THEN** Git updates matching `refs/remotes/origin/*` refs such as `origin/main`
- **AND** the fetch does not only write the remote HEAD to `FETCH_HEAD`

### Requirement: Worker force pushes preserve unexpected remote changes

Worker task instructions SHALL prohibit unguarded force pushes while allowing
`git push --force-with-lease` when a requested operation intentionally rewrites branch history.
Before using the guarded force push, the worker SHALL fetch and verify the remote branch tip so the
lease protects changes it has not seen.

#### Scenario: A requested rebase rewrites a published branch

- **GIVEN** the user requested an operation such as a rebase that intentionally rewrites a published
  branch's history
- **WHEN** the worker needs to update that branch on the remote
- **THEN** its task instructions allow `git push --force-with-lease` after fetching and verifying the
  remote branch tip
- **AND** its task instructions continue to prohibit `git push --force` and `git push -f`

### Requirement: Each task gets an isolated worktree and branch

The system SHALL provision a distinct git worktree and branch per task so that concurrent tasks
never share a checkout or operate on each other's branch. A task SHALL only reuse an existing
worktree directory that it owns; a directory owned by a different task SHALL cause provisioning of
a fresh, uniquely named worktree and branch. Worktree ownership SHALL be recorded so that recovery
after a daemon restart binds a worktree to its owning task by identity rather than by parsing the
directory name. When an existing-PR branch is already registered to another worktree, the worker
SHALL still provision the card's distinct worktree on that fixed PR branch without requiring the
user to remove their existing checkout first.

A claude-bridge turn SHALL run with the process working directory set to the task's worktree, so
the underlying Claude CLI discovers the worktree's own project context (e.g. `CLAUDE.md`) and
operates inside the isolated checkout — not the daemon's launch directory, which would expose an
unrelated project's context and tempt the agent into a different checkout. The working directory
SHALL be restored after the turn. This relies on bridge turns being serialized per daemon (so at
most one such change is in effect at a time).

#### Scenario: An agent card's agent runs in the card's worktree

- **GIVEN** a worker daemon launched from one repo's directory provisions a worktree for a card in a different repo
- **WHEN** a claude-bridge turn runs for that card
- **THEN** the agent's working directory is the card's worktree, so it reads that repo's project context rather than the daemon launch directory's
- **AND** the daemon's working directory is restored after the turn completes, errors, or is aborted

#### Scenario: Two tasks resolve to the same canonical worktree name

- **GIVEN** a task's canonical worktree directory already exists and is owned by a different task
- **WHEN** the worker provisions the task's worktree
- **THEN** the worker provisions a fresh worktree on a uniquely named branch instead of adopting the existing directory
- **AND** the two tasks do not share a worktree or branch

#### Scenario: An existing PR branch is checked out in another worktree

- **GIVEN** a card tracks an existing PR whose branch is already registered to another worktree
- **WHEN** the worker provisions the card's worktree
- **THEN** the worker creates the card's distinct worktree on the existing PR branch
- **AND** provisioning does not require the user to remove the other worktree first

#### Scenario: Daemon recovers worktrees after restart

- **GIVEN** worktrees were provisioned and their ownership recorded
- **WHEN** the daemon restarts and recovers task state from disk
- **THEN** each worktree is bound to the task that provisioned it, per the recorded ownership
- **AND** a directory whose name slug resembles another task's id is not bound to that other task

### Requirement: A follow-up turn resumes the task's existing conversation

The system SHALL resume a task's in-progress agent conversation on a follow-up turn rather than
starting a blank session, even when the stored session key is missing on the current venue (for
example after a server redeploy or a daemon reconnecting under a different worker identity dropped
the not-yet-persisted key). Because a task's git worktree is a working directory unique to that one
card, the worker SHALL fall back to resuming the most-recent session that already exists for that
worktree. The recovered or newly created session SHALL be reported back so the durable session key
is re-persisted. This fallback SHALL NOT apply to the brain, whose channels share one process
working directory and must never cross-resume.

#### Scenario: Follow-up turn after the session key was lost

- **GIVEN** a task ran an agent turn that created a session in its worktree
- **AND** the stored session key is unavailable on this venue (e.g. a redeploy/reconnect dropped it before it persisted)
- **WHEN** a follow-up turn for the same task is dispatched to the worker
- **THEN** the worker resumes the most-recent session in that task's worktree instead of forking a blank one
- **AND** the resumed session is reported back so the session key is re-persisted

#### Scenario: First turn or a migrated venue has no session to resume

- **GIVEN** a task's worktree on this venue has no existing session
- **WHEN** the worker runs a turn for that task
- **THEN** the worker starts a fresh session

#### Scenario: Brain turns never cross-resume by working directory

- **GIVEN** the brain runs multiple channels from one shared process working directory
- **WHEN** a brain turn starts without an explicit session key
- **THEN** it starts a fresh session rather than resuming another channel's most-recent session

### Requirement: A near-full session compacts before a turn rather than overflowing

The system SHALL proactively compact a task's agent session before starting a turn when the session's
context usage is at or above a configurable threshold (default 80% of the model's context window).
The runtime only compacts automatically between turns and when a top-level prompt fails with a
context-full error; a session that begins a turn already near-full can grow past the window mid-turn —
inside the agent loop, where the context-full backstop never sees it — and wedge. Compacting first
keeps headroom so the turn does not overflow. Pre-turn compaction SHALL be best-effort: if it fails,
the turn still proceeds and the reactive context-full compaction remains the backstop.

#### Scenario: A near-full session is compacted before the next turn

- **GIVEN** a task's agent session is at or above the proactive-compaction threshold of the context window
- **WHEN** a new turn is about to start for that task
- **THEN** the session is compacted before the prompt is sent, freeing context headroom
- **AND** if that compaction fails the turn still proceeds and relies on the reactive context-full backstop

### Requirement: A wedged turn is abandoned so the task stays responsive

The system SHALL give up on an agent turn that has stopped making progress, so a single hung turn
cannot leave a card stuck on "working…" indefinitely or block later messages to that task. A turn is
treated as wedged when either it was aborted (by a newer message) and does not unwind within a short
grace, OR it streams no events at all for a prolonged inactivity window (a silent wedge with no new
message to abort it — for example an over-context model call that cannot proceed, or a subagent that
never returns). On either condition the worker SHALL abandon the wedged turn: stop streaming its
events, best-effort tear down its underlying agent stream, and continue the task's single drain loop
so a subsequent message or re-dispatch starts a fresh turn rather than queueing behind the wedge. A
turn abandoned this way SHALL start its replacement on a brand-new session rather than resuming the
wedged one. The inactivity window SHALL be generous enough not to kill a legitimately long-quiet
tool (a large test run, a slow subagent) and SHALL be configurable.

A turn that is blocked on an outstanding question to the user SHALL NOT be treated as inactive: it is
waiting on a person, not wedged, and the inactivity window SHALL NOT elapse while any prompt for that
task is awaiting an answer. Because that suspends the wedge protection, the wait itself SHALL be
bounded by a configurable, generous timeout after which the question returns control to the turn, so
a question nobody answers cannot pin the task indefinitely.

Because an abandoned turn suppresses its own completion event (a replacement turn owns the
terminator), the worker SHALL report the abandonment to the server whenever no replacement message is
queued — otherwise the server would believe the turn is still running indefinitely.

#### Scenario: A turn waiting on the user is not abandoned

- **GIVEN** a task's agent turn has asked the user a question and is awaiting the answer
- **AND** it streams no events while it waits
- **WHEN** the inactivity window would otherwise elapse
- **THEN** the turn is not abandoned and the question remains answerable
- **AND** the turn resumes when the user answers

#### Scenario: A question is never answered

- **GIVEN** a turn is waiting on an outstanding question to the user
- **WHEN** the unanswered-question timeout elapses
- **THEN** the question returns control to the turn so the task is not pinned indefinitely

#### Scenario: An abandoned turn with nothing queued is reported

- **GIVEN** a turn is abandoned as wedged
- **AND** no further message is queued for that task
- **WHEN** the drain loop finishes
- **THEN** the worker reports the abandonment to the server so the card leaves "working…" and the worker's
  task slot is released

#### Scenario: A turn that goes silent is abandoned without a new message

- **GIVEN** a task's agent turn is running and stops streaming any events
- **AND** no new message arrives to abort it
- **WHEN** the inactivity window elapses with no progress
- **THEN** the worker abandons the wedged turn and tears down its agent stream
- **AND** the task's drain loop is free to run a fresh turn on a new session for the next message or re-dispatch

#### Scenario: An aborted turn that refuses to unwind is abandoned

- **GIVEN** a newer message aborts the running turn
- **AND** the turn does not unwind within the abort grace
- **WHEN** the grace elapses
- **THEN** the worker abandons the wedged turn and folds the queued message into a fresh turn on a new session

### Requirement: Foreground Agent calls use a known-compatible lifecycle runtime

The worker SHALL load its Agent/subagent extension from a Manta-pinned version rather than inheriting
an arbitrary version from the venue's global Pi settings. The extension's Pi runtime peers SHALL match
the Pi runtime used by Manta so foreground Agent completion, failure, and abort signals are delivered
back to the parent turn reliably. A stale global package entry SHALL NOT override Manta's tested pin;
an explicit worker environment override MAY replace it for development.

#### Scenario: A venue has an older global subagent package

- **GIVEN** the venue's global Pi settings name an older Agent/subagent extension
- **WHEN** the worker loads its configured Pi extensions
- **THEN** it uses Manta's pinned Agent extension and matching Pi runtime peers
- **AND** a foreground Agent completion or failure returns control to the parent turn

### Requirement: Turns never share agent conversation state across tasks

The system SHALL ensure that turns for different tasks running on the same worker daemon do not
share or cross-contaminate agent conversation state — neither when turns overlap NOR across
strictly sequential turns. Each task runs in its own working directory. Because the claude-bridge
backend keeps process-global provider, active-query, Claude CLI session, and working-directory
state, the worker SHALL run each claude-bridge task or question turn in a fresh isolated process.
The child process SHALL start in that turn's worktree and SHALL terminate after the turn. Different
claude-bridge turns MAY run concurrently because no bridge process state is shared between them.
Non-bridge backends MAY continue to run in the daemon process.

Serialization alone does not prevent SEQUENTIAL bleed: a stale bridge session pointer left over
from a previous task's turn can pass the bridge's history-reuse check on a new task's first turn
(zero prior messages look like nothing was missed) and resume the previous card's conversation —
putting several cards' work on one card's branch/PR. The system SHALL therefore ensure that each
claude-bridge turn runs against bridge session state keyed to that task's own conversation (e.g.
by making a freshly loaded bridge instance authoritative at the start of every bridge turn, whose
pointer is restored only from the current pi session's own persisted markers). A child process
SHALL host at most one bridge turn, so provider registration cannot be replaced while another
bridge query is in flight in that process. Session continuity between disposable processes SHALL
come only from the task's persisted Pi session.

The daemon SHALL proxy control-plane tools, session updates, and credential callbacks between the
isolated child and their existing parent-side handlers. It SHALL pass per-turn credentials in
memory rather than requiring concurrent children to read credentials from a daemon-global mutable
file. Aborting a turn SHALL terminate its isolated process tree within a bounded grace period so a
wedged bridge or Claude CLI descendant cannot interfere with a replacement turn.

As a further guard against SEQUENTIAL bleed, the bridge SHALL rotate to a fresh session whenever
the turn's working directory differs from the one the stored session was created in, or whenever
the incoming conversation history is shorter than the stored session's cursor (a brand-new
conversation can never be "in sync" with a longer stored one). Rotation SHALL leave the other
task's persisted session file untouched.

#### Scenario: Two cards run on one daemon at the same time

- **GIVEN** two tasks are dispatched to the same worker daemon using the claude-bridge backend
- **WHEN** their turns are queued to run concurrently on one daemon
- **THEN** the daemon runs the claude-bridge agent turns concurrently in separate child processes
- **AND** each child process starts in its own task's worktree
- **AND** neither card's agent resumes or sees the other card's conversation

#### Scenario: A new card's first turn follows another card's turn

- **GIVEN** a claude-bridge turn for one card has completed on a daemon
- **WHEN** a different card's first turn runs next on that daemon
- **THEN** the new card starts a fresh conversation in its own worktree and on its own branch
- **AND** it does not resume, continue, or commit onto the previous card's conversation, branch, or PR
- **AND** the previous card's persisted session file is left untouched

#### Scenario: A wedged bridge turn is replaced

- **GIVEN** a claude-bridge child process stops responding during a task turn
- **WHEN** the turn is aborted or exceeds the inactivity deadline
- **THEN** the worker terminates that child process and its descendants within a bounded grace period
- **AND** a replacement turn does not reuse the wedged process's in-memory bridge state

### Requirement: Task turns only expose tools the turn model can service

Worker task turns are one-shot: the turn ends when the agent stops, and nothing re-invokes the
agent afterwards until the next user message. Extension-provided tools that arm a later re-wake of
the agent (background monitors, scheduled loops, task backlogs driven by a scheduler) assume a
persistent agent session and can never fire in this model. The worker SHALL NOT expose such
session-resumption tools to task turns: an agent offered a "monitor and wake me" tool will arm it
and end its turn waiting for a wake that never comes, leaving the card permanently stalled and the
backing CLI session wedged mid-query (which also breaks tool-result delivery on follow-up turns).

#### Scenario: The agent wants to wait on a long-running command

- **GIVEN** a task turn whose agent needs to wait for a long-running command (e.g. a dev server
  becoming ready)
- **WHEN** the agent selects a tool to wait with
- **THEN** no background-monitor / re-wake tool is available to it
- **AND** the agent waits in-turn (e.g. polling via the shell tool) or reports what remains,
  instead of ending its turn to be woken later

### Requirement: Agent turns can adjust their reasoning effort

The worker SHALL load an automatic-reasoning Pi extension for task and ephemeral question turns.
The extension's `change_reasoning` tool SHALL be available to both turn types so an agent can
adjust the reasoning effort used by subsequent model calls as the work's complexity changes.

#### Scenario: A task becomes more complex during a turn

- **GIVEN** a worker task turn is running with Pi extensions enabled
- **WHEN** the agent determines that the remaining work needs more reasoning
- **THEN** the agent can call `change_reasoning` with a supported reasoning level
- **AND** subsequent model calls use the reasoning level applied by Pi

#### Scenario: A read-only question needs deeper investigation

- **GIVEN** an ephemeral question turn is running with Pi extensions enabled and its restricted
  extension-tool allowlist
- **WHEN** the question agent needs to increase reasoning effort
- **THEN** `change_reasoning` is available without exposing write-capable extension tools
