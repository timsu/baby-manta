# Workspace Board

How workspaces, cards, tasks, repositories, messages, and board metadata behave for browser users.

### Requirement: Card messages are durably accepted before dispatch

The system SHALL persist a card chat message before acknowledging it to the browser or dispatching
it to a worker. Browser delivery SHALL remain eligible to complete when the user navigates away or
closes the page immediately after sending. If worker dispatch fails after persistence, the message
SHALL remain in the transcript and the card SHALL surface the worker failure instead of appearing to
work indefinitely.

For a follow-up on a finished or review-ready card, the system SHALL move the card back to working
and confirm that a worker turn has been claimed before reporting the follow-up as delivered.

#### Scenario: Follow-up resumes a review-ready card

- **GIVEN** a Ready To Test or PR Review card with no active worker
- **WHEN** a member sends a follow-up message
- **THEN** the message is persisted and the card moves to bot working
- **AND** the member receives a delivery acknowledgement only after a new worker turn is claimed

### Requirement: Brain turns receive workspace repository inventory

The system SHALL include enabled workspace repositories and their default branches in every Brain
turn's context. When an issue identifies a relevant configured repository, the Brain SHALL use that
repository for worker work without asking the member to repeat it.

#### Scenario: Brain receives a repository-specific issue

- **GIVEN** the workspace has enabled repositories including `acme/web`
- **WHEN** a member reports an issue that identifies `acme/web`
- **THEN** the Brain context includes `acme/web` as an available repository
- **AND** the Brain can create or query work for `acme/web` without asking which repository to use

#### Scenario: User leaves immediately after sending

- **GIVEN** a member has typed a message in a card chat
- **WHEN** they send it and immediately navigate away or close the page
- **THEN** the request remains eligible to complete during page teardown
- **AND** the message is persisted before worker dispatch begins
- **AND** reopening the card shows the accepted message

#### Scenario: Dispatch fails after the message is accepted

- **GIVEN** a card message has been persisted
- **WHEN** preparing or dispatching its worker turn fails
- **THEN** the message remains in the card transcript
- **AND** the card moves to Needs Help with a visible failure notice

## Purpose

Defines existing workspace-scoped product behavior: workspace setup, board/task management,
repository configuration, model/provider settings, chat-driven work creation, uploads, and the
Black Manta board commentary helper.

## Requirements

### Requirement: Workspace access is membership-scoped

The system SHALL require workspace membership before returning workspace-scoped data or mutating a
workspace-scoped resource.

#### Scenario: Non-member requests workspace data

- **WHEN** an authenticated user requests a workspace resource for a workspace they do not belong to
- **THEN** the system rejects the request as not a member or forbidden

### Requirement: Workspaces expose board bootstrap data

The system SHALL return workspace details and board-related collections needed by the web app,
including tasks, members, invitations, repository metadata, integration status, available skills, and
model/provider settings.

#### Scenario: Member opens a workspace

- **GIVEN** the user is a workspace member
- **WHEN** the web app requests workspace board data and supporting collections
- **THEN** the system returns only resources scoped to that workspace

### Requirement: Workspace configuration can be updated by authorized users

The system SHALL support updates to workspace settings, model settings, provider settings,
regular member invitations, and repository configuration for workspace members. Privileged
membership changes, such as creating or exposing admin invite links, SHALL require an owner or admin.

#### Scenario: Workspace provider configuration changes

- **WHEN** an authorized workspace user sets or removes a provider configuration
- **THEN** the system persists the change for that workspace
- **AND** subsequent workspace provider reads reflect the new state

#### Scenario: Repository configuration changes

- **WHEN** an authorized workspace user adds, updates, or removes a repository
- **THEN** the system persists the repository configuration for that workspace

#### Scenario: Member invitation changes

- **WHEN** a workspace member lists, creates, or revokes regular member invite links
- **THEN** the system performs the invitation operation for that workspace

#### Scenario: Privileged invitation changes

- **WHEN** a workspace member who is not an owner or admin attempts to create or expose an admin invite link
- **THEN** the system rejects or hides the privileged invite link

### Requirement: Users can maintain per-repository personal settings

The system SHALL allow a workspace member to read and update personal settings for a workspace
repository without changing the shared repository configuration.

#### Scenario: Personal repo preference changes

- **WHEN** a workspace member updates personal settings for a repository
- **THEN** the system stores those settings for that user and repository

### Requirement: Cards and tasks can be created and managed from the board

The system SHALL support creating cards directly, creating cards from GitHub pull requests, listing
and reading tasks, updating task metadata, changing task status, archiving tasks, resurrecting tasks,
and asking a worker to fix conflicts or failing checks.

#### Scenario: Task transcript permalink is opened

- **GIVEN** a user is a member of the task's workspace
- **WHEN** they open a standalone Manta transcript URL for that task
- **THEN** the system shows the task title, metadata, and conversation transcript without requiring the board view
- **AND** the transcript data remains scoped to that workspace membership

#### Scenario: Card is created from the board

- **WHEN** a workspace member creates a card with valid task information
- **THEN** the system creates a workspace-scoped task card
- **AND** returns the created task data

#### Scenario: Card metadata shows a concise identifier

- **GIVEN** a card has a canonical identifier containing more than six random characters
- **WHEN** a workspace member views the card's user-facing metadata
- **THEN** the web client shows the identifier prefix and first six random characters
- **AND** the full canonical identifier remains unchanged for links and system operations

#### Scenario: Manta receives a displayed card identifier

- **GIVEN** a displayed card identifier uniquely matches a card in the workspace
- **WHEN** a workspace member asks Manta to find or act on that identifier
- **THEN** Manta resolves it to the card's full canonical identifier

#### Scenario: Manta receives an ambiguous displayed card identifier

- **GIVEN** a displayed card identifier matches multiple cards in the workspace
- **WHEN** a workspace member asks Manta to find or act on that identifier
- **THEN** Manta does not select a card
- **AND** Manta reports that the full card identifier is required

#### Scenario: Card creation starts from the board

- **WHEN** a workspace member submits the new-card dialog with valid task information
- **THEN** the web client closes the dialog immediately while creation continues
- **AND** the member can continue using the board without waiting for the create request to finish

#### Scenario: New card defaults to an available subscription model

- **GIVEN** a workspace member has a Claude subscription but does not have a ChatGPT subscription
- **AND** the workspace's preferred new-card models are unavailable to that member
- **WHEN** the member opens the new-card dialog
- **THEN** the dialog defaults to an available Claude model

#### Scenario: File mention autocomplete finds fuzzy path matches

- **GIVEN** the new-card prompt has repository file suggestions available
- **WHEN** a workspace member types an `@` file mention query
- **THEN** the web client suggests files whose full path contains the query characters in order,
  even when the characters are not contiguous
- **AND** selecting a suggestion inserts the complete file path mention into the prompt

#### Scenario: Investigation card is completed

- **GIVEN** a workspace task card has card type `investigation`
- **WHEN** its worker finishes and reports final findings
- **THEN** the system moves the card to the `investigation_complete` status
- **AND** the board shows an expanded Investigation Complete column for unread investigation results
- **AND** the card remains reconnectable for worker terminal/chat follow-up until a user marks it done

#### Scenario: Investigation result is acknowledged

- **GIVEN** a workspace task card is in the `investigation_complete` status
- **WHEN** a workspace member marks the card done after reading it
- **THEN** the system moves the card to `done`
- **AND** the card is treated as terminal completed work

#### Scenario: Brain clears the Investigation Complete column

- **GIVEN** one or more task cards are in the `investigation_complete` status
- **WHEN** the requester asks the brain to clear the Investigation Complete column
- **THEN** the system moves the requester's own investigation-complete cards to `done`
- **AND** it leaves other members' investigation-complete cards untouched unless the requester explicitly asks to clear everyone's

#### Scenario: Brain will not dispose another member's card by default

- **GIVEN** a task card was created by a workspace member other than the requester
- **WHEN** the brain is asked to dispose cards (move them to `done` or `canceled`) on the requester's behalf
- **THEN** the system disposes only the requester's own cards
- **AND** it refuses to dispose the other member's card unless the requester explicitly asks to affect everyone's cards
- **AND** the brain can identify card ownership because listed and fetched cards expose their creator

#### Scenario: Brain force-moves a card to an otherwise-illegal status

- **GIVEN** a card whose desired status change is not a permitted kanban edge (e.g. pulling a wrongly-`done` card back to `needs_help`)
- **WHEN** the brain transitions the card with force enabled
- **THEN** the system performs the move despite the edge not being in the allow-list
- **AND** it still rejects a no-op move where the source and target status are the same
- **AND** the transition is recorded in the card's audit history

#### Scenario: Task status changes

- **WHEN** a workspace member changes a task's card status
- **THEN** the system persists the status change
- **AND** returns the updated task state

#### Scenario: Member drags a card to any column

- **GIVEN** a real task card on the board (not a tracked-PR-only card)
- **WHEN** a workspace member drags it to any other column, including a move that is not a permitted kanban edge for the automated actors
- **THEN** the board offers every other column as a valid drop target and the system performs the move
- **AND** the status route still runs the side effects for the resulting status (worker dispatch, terminal/sandbox cleanup, PR-status reset)
- **AND** a tracked-PR-only card may still only be dragged into active work

#### Scenario: Brain archives active worker work

- **GIVEN** a task has active worker work or is in an active worker-facing status
- **WHEN** the brain requests that the task be archived
- **THEN** the system marks the task canceled before archiving it
- **AND** the archived task is no longer treated as still-running visible board work

#### Scenario: Archived task is resurrected

- **WHEN** a workspace member resurrects an archived task
- **THEN** the system restores the task to the active board state

#### Scenario: Automated worker runs are inspected

- **GIVEN** scheduled Slack, spot-check, or Linear automation worker runs have created hidden debug cards
- **WHEN** a workspace member switches the board scope to Automated
- **THEN** the board shows those hidden worker cards together without mixing them into Mine or All team
- **AND** each automated-run card includes the run date and time in its metadata

### Requirement: Board task notifications expose matching cards

The web client SHALL show notification indicators for the signed-in user's cards that need
attention and SHALL let the user choose which matching card to open before navigating away from the
board.

#### Scenario: User opens a task notification

- **GIVEN** the signed-in user has one or more cards in a notified status
- **WHEN** the user activates that status notification indicator
- **THEN** the web client shows a popup menu of matching cards
- **AND** selecting a card opens that card's task detail view

### Requirement: Workspace chat can dispatch work

The system SHALL accept a workspace chat message from a member and route it through the configured
brain/worker flow to produce workspace messages and task activity. Browser brain chat history and
brain session continuity SHALL be scoped to the signed-in member within the workspace so one
member's conversation is not shown to other members.

The board SHALL expose workspace and repository chat from a floating launcher when no task card is
open. Opening the launcher SHALL present a chat window that can expand to the available viewport
and, on viewports that support freeform windows, can also be moved and resized. The chat UI SHALL
distinguish Brain chat, for planning and managing board tasks, from Repo chat, for exploring a
repository checkout and creating cards from that exploration.

#### Scenario: Member opens floating chat from the board

- **GIVEN** no task card is open
- **WHEN** a workspace member activates the chat launcher
- **THEN** the web client opens a chat window above the board
- **AND** the member can expand, restore, or close the window
- **AND** on viewports that support freeform windows, the member can move and resize it
- **AND** the window explains the purpose of Brain chat and Repo chat

#### Scenario: Mobile board actions are positioned consistently

- **GIVEN** a workspace member views the board on a mobile viewport
- **THEN** the chat launcher is available in the bottom-left corner
- **AND** the new-card launcher is available in the bottom-right corner

#### Scenario: Chat launcher is hidden in task detail

- **WHEN** a workspace member opens a task card
- **THEN** the floating chat launcher and window are not shown
- **AND** the task card's own worker chat remains available

#### Scenario: Member sends workspace chat

- **WHEN** a workspace member sends a chat message
- **THEN** the system records or processes the message in the workspace context
- **AND** returns the resulting chat/task response data

#### Scenario: Member sends a follow-up while the brain is thinking

- **GIVEN** a workspace member has a brain chat turn in progress
- **WHEN** the member types and sends another chat message
- **THEN** the web client accepts the follow-up without waiting for the active turn to finish
- **AND** the follow-up is sent to the workspace brain chat

#### Scenario: Member starts a new brain chat session

- **WHEN** a workspace member sends `/new` in the browser brain chat
- **THEN** the system clears that member's browser brain chat history for the workspace
- **AND** starts subsequent browser brain turns without resuming the prior session
- **AND** does not clear other members' browser brain chat histories

### Requirement: Workspace spot checks are configurable by members

The system SHALL let workspace members list and replace workspace spot check configuration. Each
spot check SHALL include a display name, natural-language instructions, enabled state, optional
cadence schedule, and the configuration SHALL be scoped to the workspace.

#### Scenario: Member lists spot checks

- **GIVEN** the user belongs to the workspace
- **WHEN** the web app requests workspace spot checks
- **THEN** the system returns the spot checks configured for that workspace

#### Scenario: Member replaces spot checks

- **GIVEN** the user belongs to the workspace
- **WHEN** the user saves a list of spot checks
- **THEN** the system persists the list for that workspace
- **AND** subsequent spot check reads reflect the saved list

#### Scenario: Member schedules a spot check cadence

- **GIVEN** the user belongs to the workspace
- **WHEN** the user enables an hourly, daily, or weekly spot check schedule in a local time zone
- **THEN** the system persists that schedule with the spot check
- **AND** background polling runs hourly checks within their configured local window, daily checks once on each configured day, and weekly checks once on their configured weekday

#### Scenario: Spot check editors are collapsed by default

- **GIVEN** the workspace has configured spot checks
- **WHEN** the user opens the spot checks panel
- **THEN** each check is shown as a compact summary
- **AND** the user can expand an individual check to edit its details without expanding the other checks

#### Scenario: Member starts creating a spot check

- **WHEN** a workspace member adds a spot check in the board UI
- **THEN** the new spot check starts with blank name and instruction fields
- **AND** it is not runnable until required spot check details are filled in

#### Scenario: Invalid spot check payload is rejected

- **WHEN** a workspace member saves spot check settings without a spot check list
- **THEN** the system rejects the request instead of clearing the existing configuration

### Requirement: Workspace spot checks can dispatch investigation work

The system SHALL let a workspace member run an enabled spot check. Running a spot check SHALL route
the configured natural-language instructions through worker execution so the check can inspect
workspace repositories, local environment context, and connected services, while retaining a way to
ask the workspace brain for brain-only context such as Slack or Linear scans. The run SHALL use a
local eligible worker when one is available and otherwise MAY use a cloud worker. Spot-check worker
execution SHALL NOT create a visible kanban card for the spot-check run itself. The structured report
format can include findings, evidence links, recommended owners, and follow-up card prompts. When the
worker identifies actionable issues, it MAY request workspace orchestration to create follow-up cards.
Cloud workers SHALL be instructed to use sandbox-scoped encrypted service credentials rather than
requiring broad development credentials. If a requested Linear issue cannot be created, orchestration
SHALL preserve the actionable finding in a standalone Manta investigation card.

#### Scenario: Cloud spot check decrypts scoped service credentials

- **GIVEN** a cloud worker receives the workspace's encrypted service-credential bootstrap key
- **WHEN** the worker runs a service command through that encrypted environment file
- **THEN** the sandbox provides the bootstrap key only under the label that file actually declares
- **AND** the system does not publish that key under any other environment's dotenvx label, because a key-gated
  repo loader would then decrypt that other environment with a key that cannot work and fail the run
- **AND** the spot check can query the connected service without broad development or database credentials

#### Scenario: Cloud spot check reads production data through a read-only replica

- **GIVEN** repository tooling validates its whole environment at startup and aborts without a database URL
- **WHEN** the worker runs that tooling through the scoped encrypted environment file
- **THEN** the file supplies a read-only database replica under the database variable the tooling expects
- **AND** the sandbox never receives a writeable production connection string
- **AND** the spot check prompt tells the worker the connection is read-only and must not be written to

#### Scenario: Member runs an enabled spot check

- **GIVEN** the user belongs to the workspace
- **AND** the workspace has an enabled spot check
- **WHEN** the user runs the spot check
- **THEN** the system executes the spot check from worker context without adding the run to the kanban board
- **AND** immediately adds an in-progress entry to the spot-check runs table
- **AND** links that entry to the hidden task where the user can inspect live progress and details
- **AND** returns the worker's structured report response
- **AND** instructs the worker that the final response must begin with `VERDICT: <pass|warn|fail>` and `SUMMARY: <text>` lines
- **AND** records the run with a green, yellow, or red grade when the report includes an equivalent verdict or grade line or recognizable outcome language
- **AND** reads that verdict line even when the worker emits it without a preceding line break

#### Scenario: A blocked spot check is not graded green

- **GIVEN** a spot check report says the check could not reach the service it was asked to inspect
- **WHEN** the system grades the run without an explicit verdict line
- **THEN** the run is graded yellow
- **AND** accompanying statements that no actionable issues were found do not make it green

#### Scenario: A not-green spot check is visible from the board

- **GIVEN** the latest run of an enabled spot check is yellow or red
- **WHEN** a workspace member views the board
- **THEN** the spot checks control is badged with the worst of those grades
- **AND** the badge names the affected checks
- **AND** a check whose latest run is green contributes no badge

#### Scenario: Spot check avoids duplicate follow-up cards

- **GIVEN** the workspace has previous runs for the same spot check
- **WHEN** the spot check runs again
- **THEN** the worker prompt includes recent prior run summaries and report excerpts
- **AND** instructs the worker not to request follow-up orchestration for findings that match already-reported history

#### Scenario: Disabled or missing spot check is not run

- **WHEN** a workspace member attempts to run a disabled or unknown spot check
- **THEN** the system rejects the run request

#### Scenario: Spot check creates investigation cards

- **GIVEN** a spot check report identifies actionable issues
- **WHEN** the worker requests follow-up orchestration for those issues
- **THEN** the created cards are workspace-scoped investigation cards
- **AND** their descriptions can include the spot check's evidence links and follow-up instructions

#### Scenario: Linear issue creation is unavailable

- **GIVEN** a spot check identifies an actionable issue and requests follow-up orchestration
- **WHEN** orchestration cannot create the requested Linear issue
- **THEN** orchestration creates a standalone Manta investigation card without a Linear link
- **AND** the actionable finding is not dropped

### Requirement: Uploaded card images are stored and retrievable

The system SHALL allow a workspace member to upload card images and SHALL serve stored images by
unguessable image id without requiring browser authentication for the image fetch.

#### Scenario: Image upload and fetch

- **WHEN** a workspace member uploads an image for a card
- **THEN** the system stores the image bytes and content type
- **AND** a later image request by id returns the image bytes with that content type

### Requirement: Board commentary is workspace-scoped

The system SHALL generate Black Manta commentary only for a workspace the user belongs to and SHALL
return an empty or fallback text when external model configuration or calls are unavailable. The web
client SHALL keep Black Manta hidden by default and show it only after the user opts in.

#### Scenario: Commentary requested for member workspace

- **GIVEN** the user belongs to the workspace
- **WHEN** the user requests board commentary
- **THEN** the system returns short commentary text or a safe fallback

#### Scenario: Commentary requested for another workspace

- **WHEN** the user requests commentary for a workspace they do not belong to
- **THEN** the system rejects the request as forbidden

#### Scenario: Black Manta is hidden until enabled

- **GIVEN** the user has not previously enabled Black Manta
- **WHEN** the user opens the board
- **THEN** the web client does not show Black Manta or request Black Manta commentary

#### Scenario: User enables Black Manta

- **WHEN** the user chooses to show Black Manta
- **THEN** the web client may show Black Manta and request commentary for the active workspace

#### Scenario: User dismisses current Black Manta commentary

- **GIVEN** Black Manta is showing generated commentary that is not yet due to refresh
- **WHEN** the user dismisses that commentary
- **THEN** refreshing the page does not restore the dismissed commentary
- **AND** the existing commentary refresh timer is not reset
