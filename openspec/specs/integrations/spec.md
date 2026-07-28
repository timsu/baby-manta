# Integrations

How Manta connects workspaces and users to GitHub, Linear, Slack, and Notion.

## Purpose

Defines existing integration behavior for GitHub App installation and user linking, Linear
bring-your-own-app OAuth and mappings, Slack event ingestion and bot settings, and integration
status surfaced to workspaces.

## Requirements

### Requirement: Notion is a workspace-scoped integration

The system SHALL let a workspace member connect and disconnect a Notion workspace from Manta
Settings. The OAuth credential SHALL be encrypted at rest, scoped to the Manta workspace, and used
server-side so agents never receive the raw credential.

#### Scenario: Workspace connects Notion

- **GIVEN** the current user is a workspace member
- **WHEN** the user completes Notion OAuth from the Notion settings page
- **THEN** the connection is stored for that workspace
- **AND** Settings reports Notion as connected

#### Scenario: Workspace disconnects Notion

- **WHEN** an authorized workspace user disconnects Notion
- **THEN** Manta removes the workspace credential
- **AND** subsequent Notion tool calls report that Notion is not connected

### Requirement: Notion tools are available across Manta agent surfaces

The system SHALL expose workspace-scoped tools for searching and fetching Notion content and for
creating pages, updating pages, and adding comments. These tools SHALL be available to Manta brain
turns and normal workers, with server-side authorization and credential resolution. Read-only
background workers SHALL receive only read-oriented Notion tools, except scheduled Slack workers
MAY use Notion write tools when their configured prompt requests Notion work.

#### Scenario: Agent reads Notion

- **GIVEN** the workspace has connected Notion
- **WHEN** a brain or worker calls a Notion search or fetch tool
- **THEN** Manta runs the request against that workspace's Notion connection
- **AND** returns the Notion result without exposing the OAuth token

#### Scenario: Agent writes Notion

- **GIVEN** the workspace has connected Notion
- **WHEN** an authorized brain, normal worker, or scheduled Slack worker calls a Notion write tool
- **THEN** Manta performs the requested page or comment mutation in the connected Notion workspace

### Requirement: Workspaces maintain Notion instructions

The Notion settings page SHALL provide editable workspace-level “Notion instructions” for durable
guidance such as important documentation links. Manta SHALL expose a read-only tool that returns
these instructions to brain turns and workers on demand.

#### Scenario: Agent reads configured Notion guidance

- **GIVEN** a workspace member saved important document links in Notion instructions
- **WHEN** an agent calls the Notion instructions tool
- **THEN** the tool returns the current workspace instructions verbatim

### Requirement: GitHub App installation is workspace-scoped

The system SHALL support starting and completing a GitHub App installation for a workspace, listing
repositories available through the installation, refreshing pull request/status data, and
disconnecting the installation.

#### Scenario: Workspace installs GitHub

- **GIVEN** the current user is a workspace member
- **WHEN** the user starts and completes GitHub App installation for that workspace
- **THEN** the system stores the installation for that workspace
- **AND** repository listing for the workspace uses that installation

#### Scenario: GitHub installation is disconnected

- **WHEN** an authorized workspace user disconnects GitHub
- **THEN** the system removes the workspace installation link

#### Scenario: Pull request title changes

- **GIVEN** a Manta card is linked to a GitHub pull request
- **WHEN** Manta refreshes pull request state and GitHub reports a changed pull request title
- **THEN** the system updates the card's stored pull request title
- **AND** the card title shown on the board matches the latest pull request title

### Requirement: Users can link a personal GitHub account

The system SHALL support per-user GitHub OAuth linking so worker actions can use the user's linked
GitHub identity when available.

#### Scenario: User links GitHub

- **WHEN** the authenticated user completes the GitHub user OAuth callback
- **THEN** the system stores the linked GitHub identity and token status for that user

### Requirement: GitHub webhooks update Manta state

The system SHALL accept GitHub webhook events, verify them, and use them to update relevant Manta
workspace/task state.

#### Scenario: Valid GitHub webhook received

- **WHEN** GitHub sends a valid webhook payload for a known installation or repository
- **THEN** the system processes the event and returns success

### Requirement: Manta auto-merge follows GitHub PR readiness

The system SHALL attempt Manta-managed auto-merge for enabled pull request cards once the pull
request is open, approved, checks are passing, and GitHub has not reported explicit merge conflicts.
Unknown mergeability from GitHub SHALL NOT by itself block an auto-merge attempt because the merge
endpoint is the authoritative source for whether the pull request can be merged.

#### Scenario: Mergeability is temporarily unknown

- **GIVEN** a pull request card has Manta auto-merge enabled
- **AND** the pull request is open, approved, and checks are passing
- **AND** GitHub reports unknown mergeability rather than explicit conflicts
- **WHEN** Manta refreshes pull request state
- **THEN** it attempts to merge the pull request

### Requirement: Linear connection is workspace-scoped

The system SHALL let a workspace member save Linear app configuration, run Linear OAuth, inspect
connection status, list Linear members/projects/teams, map Linear projects and teams, link the
current Manta user to a Linear member, list assigned issues, and disconnect Linear.

The assigned issue list SHALL omit an issue only when it has an unarchived Manta card owned by the
requesting user. A card owned by another member or left unassigned SHALL NOT hide the requester's
assigned Linear issue.

#### Scenario: Linear OAuth completes

- **GIVEN** the user is a workspace member
- **WHEN** the user completes Linear OAuth for that workspace
- **THEN** the system stores the Linear connection for the workspace
- **AND** status requests report the workspace as connected

#### Scenario: Linear mappings are replaced

- **WHEN** an authorized workspace user saves project or team mappings
- **THEN** the system replaces the workspace mappings with the submitted mapping set

#### Scenario: Assigned issue has another member's Manta card

- **GIVEN** a Linear issue is assigned to the requesting user
- **AND** an unarchived Manta card linked to that issue is owned by another workspace member
- **WHEN** the requester loads their assigned Linear issues
- **THEN** the linked Linear issue remains visible for the requester

### Requirement: Linear webhooks are accepted per workspace

The system SHALL receive Linear webhook events on a workspace-specific endpoint and apply valid
issue/project/team changes to the corresponding workspace.

Webhook events authored by Manta's own Linear app identity SHALL NOT be added to the brain inbox
or trigger a new Linear assignment brain turn. These events are treated as side effects of Manta's
own actions, not as new external user activity.

Linear comment webhooks SHALL NOT be added to the brain inbox as passive activity. A Linear
comment SHALL trigger Manta only when it explicitly mentions the connected Linear bot, and mirrored
comments from synced Slack threads SHALL NOT trigger a Linear mention brain turn because Slack
Events are the source of truth for Slack-originated requests.

#### Scenario: Linear webhook received

- **WHEN** Linear sends a valid webhook for a workspace
- **THEN** the system processes the payload in that workspace context

#### Scenario: Self-authored Linear webhook is not re-ingested

- **GIVEN** a workspace has a connected Linear app identity
- **WHEN** Linear sends a webhook authored by that app identity
- **THEN** the system does not enqueue the event for the brain as new activity

#### Scenario: Slack-synced Linear comment is not re-ingested

- **GIVEN** a Slack thread is synced to a Linear issue
- **WHEN** Linear sends a comment webhook for a Slack reply in that thread
- **THEN** the system does not enqueue the mirrored Linear comment for the brain
- **AND** the mirrored comment does not trigger a Linear mention brain turn

#### Scenario: Unmentioned Linear comment is passive

- **WHEN** Linear sends a comment webhook that does not mention the connected Linear bot
- **THEN** the system does not enqueue the comment for the brain
- **AND** the comment does not trigger a Linear mention brain turn

#### Scenario: Direct Linear mention triggers Manta

- **WHEN** Linear sends a comment webhook that mentions the connected Linear bot directly in Linear
- **THEN** the system triggers a Linear mention brain turn
- **AND** the system posts Manta's response as a threaded reply to the mentioning comment

### Requirement: Linear-originated investigations report back to Linear

The system SHALL keep Linear-originated work linked to the source Linear issue and provide workers
with a workspace-scoped way to post investigation results back to that issue.

#### Scenario: Worker card is created from a Linear issue

- **WHEN** Manta creates a worker card while handling a Linear issue
- **THEN** the system instructs the brain to pass the issue identifier when creating the card
- **AND** if the issue's project or team has a workspace repo mapping, the card uses that mapped repo even if another repo was requested
- **AND** the worker can read and comment on the linked Linear issue without receiving the Linear token
- **AND** Linear comments are posted using the workspace app OAuth token, not a human user token

#### Scenario: Worker finishes an investigation for a linked issue

- **GIVEN** a worker card is linked to a Linear issue
- **WHEN** the worker finishes an investigation, plan, or fix
- **THEN** the worker is instructed to post a concise outcome comment to the linked Linear issue
- **AND** an investigation card without a pull request is marked completed after the Linear outcome comment is posted
- **AND** Manta does not post an additional generic card-completion comment when the card closes
- **AND** the board groups completed Linear investigations into an auto-collapsed terminal section

### Requirement: Slack support issues are labeled for on-call triage

The system SHALL automatically apply the workspace Linear labels used for support triage when
creating a Linear issue during a Slack-originated turn after Manta has performed the support-triage
duplicate lookup. These labels SHALL include Bug, Support, and On-call triage so bugs filed from the
support channel show up in the on-call triage Linear view while preserving any additional labels
requested by the brain. Slack-originated issue creation that has not performed support triage SHALL
NOT receive these labels solely because it came from Slack.

#### Scenario: Slack support request creates a Linear issue

- **GIVEN** Manta is handling a Slack-originated support request
- **AND** it has checked for duplicate Linear issues as part of support triage
- **WHEN** it creates a Linear issue for the request
- **THEN** the issue creation request includes Bug, Support, and On-call triage labels
- **AND** any explicitly requested labels are preserved without duplicates

#### Scenario: Non-triaged Slack issue creation is not mislabeled

- **GIVEN** Manta is handling a Slack-originated request that has not performed support triage
- **WHEN** it creates a Linear issue for the request
- **THEN** the issue creation request does not add Bug, Support, or On-call triage by default

### Requirement: Linear status automation is configurable

The system SHALL let a workspace configure a Linear workflow status to auto-handle, store custom
instructions for that status, and trigger Manta when a Linear issue enters the configured status.
Triggered runs SHALL include the issue identifier and configured instructions so Manta can create a
linked worker card or otherwise handle the issue through the workspace's Linear connection.

The system SHALL also provide status-maintenance actions for existing Linear issues in a configured
status: moving issues older than a user-selected number of months to another status, and starting a
bounded batch triage worker for issues in that status. Batch triage SHALL remember the Linear issue
identifiers it already queued for each configured status so a later batch request avoids reprocessing
the same issues unless their identifiers have not yet been recorded.

#### Scenario: Issue enters an auto-handled status

- **GIVEN** a workspace has Linear connected
- **AND** Linear status automation is enabled for status "To Validate" with custom instructions
- **WHEN** Linear sends an issue update showing the issue moved into "To Validate"
- **THEN** Manta starts handling that issue with the configured instructions
- **AND** the issue identifier is included so any spawned worker card remains linked to Linear
- **AND** the background worker card is marked done when its worker turn completes successfully
- **AND** Manta does not post a generic card-completion comment when the automation card closes

#### Scenario: Batch triage avoids prior items

- **GIVEN** a workspace has already queued Linear issues from a configured status for batch triage
- **WHEN** a member starts another batch triage for that status
- **THEN** the system excludes issue identifiers remembered from previous batches
- **AND** records the identifiers newly queued in the batch

#### Scenario: Stale issues are moved out of a status

- **WHEN** a member asks Manta to move issues older than a selected number of months from one Linear status to another
- **THEN** the system moves only issues whose last update is older than that cutoff
- **AND** returns the count of moved issues

### Requirement: Slack Events API callbacks are handled

The system SHALL accept Slack Events API callbacks, including URL verification and event callbacks,
when Slack integration dependencies are configured.

#### Scenario: Slack URL verification

- **WHEN** Slack sends a URL verification challenge
- **THEN** the system responds with the challenge response expected by Slack

### Requirement: Slack-originated card outcomes are posted to the source thread

The system SHALL post card outcome updates back to the originating Slack thread when a card was
spawned from Slack and the originating bot is still available.

Slack-originated investigation cards SHALL use the explicit `investigation` card type and provide workers with a workspace-scoped way to post
their final findings back to the originating Slack thread without exposing Slack channel IDs or bot
tokens to the worker. When such an investigation posts final findings and has no pull request, the
system SHALL move the card to the `investigation_complete` status rather than requiring the worker
to move it to Needs Help or marking the result as fully done before a user has read it.

#### Scenario: Slack-originated card PR is merged

- **GIVEN** a card was spawned from a Slack thread and has an associated pull request title and URL
- **WHEN** the pull request is merged and the card is marked done for that merge
- **THEN** the system posts a follow-up in the originating Slack thread saying the linked PR was merged

#### Scenario: Worker finishes a Slack-originated investigation

- **GIVEN** a worker card was spawned from a Slack thread
- **AND** the investigation does not produce a pull request
- **WHEN** the worker posts its final findings for the card
- **THEN** the system posts those findings in the originating Slack thread using the originating bot
- **AND** the card is moved to the `investigation_complete` status

### Requirement: Workspace Slack bot settings are manageable by members

The system SHALL let workspace members list, create, update, and delete Slack bot settings and list
channels visible to a configured bot.

#### Scenario: Slack bot is configured

- **WHEN** a workspace member saves Slack bot settings
- **THEN** the system stores those settings for the workspace
- **AND** subsequent bot listings include the configured bot

### Requirement: Slack bots can post scheduled AI-generated messages

The system SHALL let workspace members create, list, update, and delete daily or weekly schedules
that run an AI prompt and post the generated message into a Slack channel using a configured
workspace Slack bot. Each schedule SHALL be scoped to its workspace and bot, SHALL expose its next
planned run time in the configured local timezone, SHALL skip weekends and US holidays by default,
and SHALL stop posting when disabled or deleted. Scheduled prompts SHALL be allowed to use
read-oriented brain tools, including repository question delegation, but SHALL NOT be allowed to
create or mutate cards, Linear issues, or memory.

Workspace members SHALL be able to edit existing scheduled messages and test the current draft of a
scheduled message before saving it. A test run SHALL execute the same AI prompt flow in a
user-visible debug card owned by the testing member, stream a preview of the tools used and final
generated message as it runs, and expose that debug card to the member for troubleshooting, but
SHALL NOT post to Slack or change the schedule's next planned run.

After a test finishes with a generated message, the member SHALL be able to explicitly post that
preview to the draft's selected Slack channel using the selected bot. Posting the preview SHALL NOT
save the draft or change the schedule's next planned run, and the action SHALL report whether the
message was posted successfully.

Editing a draft while a test is running SHALL abort that test and clear its preview. Members SHALL
also be able to abort a running test explicitly, and saving SHALL remain available while a test is
running; saving aborts the in-flight test before persisting the schedule. Repository question
delegation used by scheduled prompts SHALL run only with local read-only checkout tools, not web
search or background monitor tools.

#### Scenario: Daily scheduled prompt posts to Slack

- **GIVEN** a workspace has an enabled Slack bot and a daily schedule with a prompt, channel, timezone, and local time
- **WHEN** the schedule becomes due
- **THEN** the system runs the prompt from worker context without adding the run to the kanban board
- **AND** posts the generated text to the configured Slack channel with that bot
- **AND** advances the next planned run to the following day

#### Scenario: Business-day default skips weekends and US holidays

- **GIVEN** a daily schedule does not include weekends and holidays
- **WHEN** the next local occurrence would fall on a Saturday, Sunday, or configured US holiday
- **THEN** the system advances the next run to the next non-holiday weekday

#### Scenario: Weekly scheduled prompt posts on its selected days

- **GIVEN** a workspace has a weekly schedule with one or more selected days and a local time
- **WHEN** the schedule becomes due
- **THEN** the system posts the AI-generated message to the configured channel
- **AND** advances the next planned run to the next occurrence of any selected day at that time

#### Scenario: Scheduled message draft is tested

- **GIVEN** a workspace member is creating or editing a scheduled Slack message
- **WHEN** they test the current draft
- **THEN** the system runs the prompt from worker context in a user-visible debug card owned by that member
- **AND** streams process details and generated Slack message preview to the member as the run progresses
- **AND** exposes the debug card identifier so the member can open the full worker transcript
- **AND** does not post the generated text to Slack
- **AND** does not update the schedule's next planned run

#### Scenario: Scheduled message test is aborted by editing or saving

- **GIVEN** a workspace member is testing a scheduled Slack message draft
- **WHEN** they edit the draft, click Abort test, or save the schedule
- **THEN** the running test is aborted
- **AND** stale streamed test output is not applied to the edited draft
- **AND** saving is not blocked by the running test

#### Scenario: Completed scheduled message preview is posted

- **GIVEN** a workspace member has completed a scheduled Slack message test with generated text
- **WHEN** they choose to post the preview to Slack
- **THEN** the system posts that exact generated text to the draft's selected channel with its selected bot
- **AND** confirms that the preview was posted
- **AND** does not save the draft or update the schedule's next planned run

### Requirement: Auto-respond channels are triaged regardless of author account status

The system SHALL triage messages in a bot's configured auto-respond channels for any author,
whether or not the author has a linked Manta account or workspace membership. In auto-respond
channels the bot SHALL NOT stay silent merely because a message is not addressed to it by name;
it SHALL follow the channel's per-channel instructions to decide what to act on and lean toward
acting (answering or filing/triaging) when in doubt, ignoring only messages with no question,
problem, or request. Authors without a linked Manta account or workspace membership are served
with the full toolset — their questions are answered and they may file/comment on Linear issues
and use other side-effecting tools — with the single exception that spawning a worker task/card
requires a linked account (worker tasks run real compute on a member's board and need an owner to
attribute and route to). This account-linking policy is not specific to auto-respond channels: it
applies to all Slack surfaces (channels, DMs, and mentions).

Auto-respond fires on top-level channel messages only. The system SHALL NOT auto-respond to
replies within an existing thread; once a thread is underway the bot stays out of the
back-and-forth unless a reply explicitly @-mentions it (which is handled as a mention).

A top-level message that carries a file or screenshot attachment SHALL be triaged like any
other message, even though Slack delivers it with a distinct message subtype, and even when it
has no accompanying caption text. The attached image SHALL be made available to the brain as
context for the turn, and attachment context SHALL be included in the actual model turn so a
bare screenshot post does not run as an empty prompt.

#### Scenario: Screenshot post is triaged

- **GIVEN** a channel is configured as an auto-respond channel
- **WHEN** someone posts a top-level message with an attached screenshot, with or without a caption
- **THEN** the bot triages the message per the channel instructions instead of ignoring it
- **AND** the attached image is provided to the brain as context
- **AND** the model turn includes a non-empty request grounded in the attached screenshot

#### Scenario: Thread followup is not auto-responded

- **GIVEN** a channel is configured as an auto-respond channel
- **WHEN** someone posts a reply within an existing thread that does not @-mention the bot
- **THEN** the bot does not auto-respond to the followup

#### Scenario: Thread followup that mentions the bot is handled

- **GIVEN** a channel is configured as an auto-respond channel
- **WHEN** someone posts a reply within an existing thread that @-mentions the bot
- **THEN** the bot responds, handled via its mention flow

#### Scenario: Unaddressed support message is triaged

- **GIVEN** a channel is configured as an auto-respond channel with triage instructions
- **WHEN** someone posts a question or bug report that names another person rather than the bot
- **THEN** the bot acts per the channel instructions instead of ignoring the message

#### Scenario: Author has no linked Manta account

- **GIVEN** a Slack message from an author with no linked Manta account or workspace membership
- **WHEN** the message is a question or asks to file/comment on a Linear issue
- **THEN** the bot answers and performs the Linear write as usual
- **AND** the only capability withheld is spawning a worker task/card
- **AND** when the request specifically requires spawning a worker task, the bot still does what it can and explains that a linked Manta account is required to kick off tasks

### Requirement: Integration status is visible from the workspace

The system SHALL expose workspace integration status so the web app can show whether GitHub, Linear,
Slack, and related account links are configured.

#### Scenario: Workspace integration panel loads

- **WHEN** a workspace member requests integration status
- **THEN** the system returns the configured integration state for that workspace
