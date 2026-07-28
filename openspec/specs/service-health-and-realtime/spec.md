# Service Health and Realtime

How Manta exposes operational health, versioning, and websocket entry points.

## Purpose

Defines existing operational endpoints used by load balancers, clients, workers, and terminal
sessions.

## Requirements

### Requirement: Liveness is always available without authentication

The system SHALL expose an unauthenticated liveness response for infrastructure health checks and
offline detection.

#### Scenario: Liveness requested

- **WHEN** a client requests the liveness endpoint
- **THEN** the system returns a successful response indicating the process is alive

### Requirement: Readiness reflects startup and draining state

The system SHALL expose readiness separately from liveness and SHALL return unavailable when startup
checks have not passed or the server is draining.

#### Scenario: Server is ready

- **WHEN** readiness dependencies have passed
- **THEN** the system returns a successful readiness response with the current time

#### Scenario: Server is not ready

- **WHEN** readiness dependencies have not passed
- **THEN** the system returns an unavailable readiness response

### Requirement: Build version is visible to the web app

The system SHALL expose the current server git hash so the browser UI can show the deployed build
version.

#### Scenario: Version requested

- **WHEN** the browser requests server version
- **THEN** the system returns the current git hash value

### Requirement: Authenticated users can inspect recent server logs

The system SHALL provide a browser-accessible debugging view for authenticated users to inspect
recent sanitized structured server log summaries captured by the running process. The response SHALL
NOT include raw log metadata, error stacks, or tenant-scoped identifiers from log details.

#### Scenario: User opens the debugging view

- **GIVEN** the user is authenticated in the web app
- **WHEN** the user chooses the server logs debugging menu item
- **THEN** the web app opens a debugging view showing recent server log entries

#### Scenario: Anonymous user requests server logs

- **WHEN** an unauthenticated client requests recent server logs
- **THEN** the system rejects the request as unauthenticated

### Requirement: Browser websocket endpoint supports workspace updates

The system SHALL expose a browser websocket endpoint for authenticated realtime app state updates.

#### Scenario: Browser opens realtime connection

- **WHEN** the browser opens the websocket endpoint with valid session context
- **THEN** the system accepts the connection and can publish workspace/task updates to that client

### Requirement: Card chat transcripts are isolated per card

Each card's worker chat transcript and in-flight ("thinking") state SHALL be addressed by that
card's task id, independent of which card is currently open. A streamed event for one card SHALL
NOT appear in, modify, or clear another card's transcript, and switching between cards SHALL NOT
mix their messages. The brain chat SHALL remain separate from every card transcript.

#### Scenario: A background card keeps streaming while another card is open

- **GIVEN** card A has an in-flight worker turn and the user opens card B
- **WHEN** card A's worker streams further events
- **THEN** those events accumulate in card A's transcript only
- **AND** card B's transcript shows none of card A's messages

#### Scenario: Switching back to a card preserves its own transcript

- **GIVEN** the user sent a message on card A and then opened card B
- **WHEN** the user returns to card A
- **THEN** card A still shows its own conversation, unaffected by card B

#### Scenario: Brain chat stays separate from card chats

- **WHEN** brain events and a card's worker events are received while that card is open
- **THEN** brain output appears only in the brain chat and the card's output only in that card

### Requirement: Streamed worker replies survive reload and worker disconnect

A worker reply that has been streamed to the browser SHALL be persisted to the card's chat
transcript so it survives a page reload, even when the worker turn does not end with a clean
completion event. If the worker socket drops mid-turn — including a follow-up turn on a card that
is not in a "bot working" state — the system SHALL persist whatever the worker streamed before the
drop rather than discard it. The system SHALL NOT persist a duplicate copy of a reply that already
completed normally, and SHALL NOT write an empty message when nothing was streamed.

#### Scenario: Text-only worker reply completes normally

- **GIVEN** a member sends a follow-up message on a task
- **WHEN** the worker responds with assistant text and completes the turn without using tools
- **THEN** the assistant reply is persisted to the task transcript
- **AND** leaving and reopening the task still shows that reply

#### Scenario: Worker disconnects after streaming a reply

- **GIVEN** a worker streamed a reply on a card and the user saw it live
- **WHEN** the worker socket drops before the turn emits a completion event
- **THEN** the streamed reply is persisted to the card's transcript
- **AND** reloading the card still shows that reply

#### Scenario: Follow-up reply on a reactivated card survives disconnect

- **GIVEN** a card in a completed state (e.g. Ready To Test) whose follow-up moved it back to
  "bot working" and re-activated the worker
- **WHEN** the worker streams a reply and then disconnects before completing the turn
- **THEN** the streamed reply is persisted and survives a reload

#### Scenario: Mid-turn follow-ups retain visible chronology after reopening

- **GIVEN** a worker has already streamed assistant output for a task
- **WHEN** a member sends one or more follow-up messages before that worker turn finishes
- **AND** the member closes and reopens the task
- **THEN** the durable transcript shows each assistant segment and user follow-up in the same order they appeared live

### Requirement: Answering a worker's question always settles, and resumes the card

A question menu shown to a member SHALL always be settled when they act on it: the system SHALL
return a terminal response for every answer or dismissal, including when the prompt is no longer
known to the server, so the menu can never hang on a pending state.

A prompt outlives the turn that asked it — the asking turn may have ended or been abandoned, or the
process holding it may have been replaced — so an answer that cannot be handed to a waiting turn
SHALL NOT be discarded. The system SHALL deliver it to the card as an ordinary follow-up message,
re-dispatching a worker if none is attached, so the member's answer resumes the work the question was
blocking. A dismissal SHALL NOT resume the card, since the member declined to answer.

A prompt belonging to another member SHALL NOT be answered on their behalf; retracting it from a
viewer who cannot use it SHALL leave it answerable by its owner.

#### Scenario: The asking turn is gone by the time the member answers

- **GIVEN** a question menu is on screen for a card
- **AND** the turn that asked it has ended, been abandoned, or was lost to a server restart
- **WHEN** the member submits an answer
- **THEN** the menu is retracted rather than left pending
- **AND** the answer is delivered to the card as a follow-up message that resumes the worker

#### Scenario: The member dismisses a stale question

- **GIVEN** a question menu whose asking turn is gone
- **WHEN** the member dismisses it
- **THEN** the menu is retracted and no follow-up turn is started

#### Scenario: A prompt owned by another member

- **GIVEN** a question menu owned by a different member
- **WHEN** this member acts on it
- **THEN** their copy is retracted without answering
- **AND** the prompt remains answerable by its owner

### Requirement: A briefly dropped worker is given time to return before its card fails

A worker socket dropping is not by itself proof that the work stopped: a server deploy or an
intermediary proxy restart drops every worker socket at once while the daemons keep running their
turns locally and reconnect seconds later. When a worker with an in-flight turn disconnects and no
other worker can take the card over, the system SHALL hold the card in its current state for a
bounded grace window instead of immediately moving it to Needs Help, and SHALL move it to Needs Help
only if that window elapses without the worker returning. The grace window SHALL be configurable.

A reconnecting worker's own account of what it is running SHALL be authoritative: tasks it still
claims SHALL be released from the hold, and held tasks it does not claim SHALL fail immediately
rather than waiting out the remainder of the window. Any streamed turn activity for a held task
SHALL also release the hold.

#### Scenario: Worker reconnects after a deploy while still running the turn

- **GIVEN** a card is bot-working and its worker socket drops during a server deploy
- **AND** no other worker of the task owner is available to take it over
- **WHEN** the worker reconnects within the grace window and still reports the task as running
- **THEN** the card is never moved to Needs Help and no disconnect note is posted
- **AND** the turn's output continues to stream onto the card

#### Scenario: Worker never returns

- **GIVEN** a card is bot-working and its worker socket drops
- **WHEN** the grace window elapses with no reconnect and the card is still bot-working
- **THEN** the card moves to Needs Help with a note that the worker did not come back
- **AND** the note includes the worker's last output when it is available

#### Scenario: Worker reconnects without the task

- **GIVEN** a held card whose worker dropped mid-turn
- **WHEN** that worker reconnects but no longer reports the task as running
- **THEN** the card moves to Needs Help immediately rather than waiting out the window

#### Scenario: Card finished while the window was open

- **GIVEN** a held card whose worker dropped mid-turn
- **WHEN** the card leaves the bot-working state before the window elapses
- **THEN** the card is left alone

### Requirement: Worker websocket endpoint supports daemon presence and task routing

The system SHALL expose a worker websocket endpoint for worker daemons to register presence and
receive task/control messages.

#### Scenario: Worker daemon connects

- **WHEN** a worker daemon opens the worker websocket with valid worker credentials
- **THEN** the system records worker presence and can route task/control messages to the daemon

### Requirement: Terminal websocket endpoint relays browser terminal sessions

The system SHALL expose a terminal websocket relay for browser terminal sessions when direct worker
terminal access is unavailable or unsuitable.

#### Scenario: Browser uses terminal relay

- **WHEN** the browser opens the terminal websocket for an authorized task terminal
- **THEN** the system relays terminal traffic between browser and worker according to task routing
