# Model Providers

How Manta resolves the LLM credentials that power the in-server brain across a
workspace's team of subscription holders.

## Purpose

Defines how the brain selects and falls back across the workspace's pool of
member subscription credentials (e.g. OpenAI Codex, Claude) so a single dead or
rate-limited subscription does not take the brain down.

## Requirements

### Requirement: New-card models preserve workspace ordering

The new-card model picker SHALL display configured card models in the same order
as the workspace model list. The workspace default SHALL remain available even
when it is not explicitly present in that list, but being the default SHALL NOT
move it ahead of configured card models.

#### Scenario: Default model is not first in the configured list

- **GIVEN** a workspace model list places model A before the default model B
- **WHEN** a user opens the new-card picker
- **THEN** model A appears before model B

#### Scenario: Default model is absent from the configured list

- **GIVEN** the workspace default is not explicitly in the configured card model list
- **WHEN** a user opens the new-card picker
- **THEN** the configured models retain their order
- **AND** the workspace default is also offered

### Requirement: Brain turns draw from a pooled, round-robin credential set

The brain SHALL resolve its model credentials from the pool of subscription
credentials held by the workspace's members, choosing one credential per provider
per turn in round-robin order so load is distributed across the team rather than
always using a single member's subscription.

#### Scenario: Multiple members hold the same provider

- **GIVEN** several workspace members have a subscription for the brain's provider
- **WHEN** the brain runs successive turns
- **THEN** the system rotates across those members' credentials rather than always
  using one

### Requirement: A failed brain credential is skipped and retried

When a brain turn produces no output, or fails with an authentication error, the
system SHALL treat the backing subscription as unusable: it SHALL temporarily
blacklist that credential (scoped to the provider that failed) and retry the turn
with the next credential in the pool. The blacklist SHALL expire after a cooldown
so a recovered subscription is used again, and SHALL be scoped so a dead
subscription for one provider does not disable that member's working subscription
for another provider.

#### Scenario: One member's subscription is dead

- **GIVEN** the brain selects a member's subscription whose turn returns no output
- **WHEN** the turn completes empty
- **THEN** the system blacklists that credential for a cooldown period
- **AND** retries the same turn with another member's subscription in the pool
- **AND** subsequent turns skip the blacklisted credential until the cooldown ends

#### Scenario: A failure does not disable unrelated providers

- **GIVEN** a member holds subscriptions for two providers
- **WHEN** a brain turn on the first provider fails and is blacklisted
- **THEN** the member's credential for the other provider remains usable

### Requirement: Delegated read-only question runs carry vended credentials

When the brain delegates a read-only repo question to a worker, the system SHALL
vend workspace credentials for the requested model with the dispatch and the
worker SHALL run on those credentials. Because such a question may run on any
member's daemon — not necessarily the asker's — it SHALL NOT depend on that
daemon being logged into the model's provider locally, and applying the vended
credentials SHALL NOT overwrite the daemon owner's own stored login.

#### Scenario: Question runs on a daemon not logged into the model's provider

- **GIVEN** the workspace brain model is provider A
- **AND** the question is dispatched to a member's daemon that is not logged into provider A locally
- **WHEN** the worker runs the question
- **THEN** it uses the workspace-vended credentials for provider A
- **AND** the daemon owner's own stored credentials are left unchanged

#### Scenario: Empty question answer is recorded

- **WHEN** a delegated question run finishes without producing an answer
- **THEN** the system records the empty outcome with the model used, so the failure is diagnosable

### Requirement: Background brain runs select a member with a live subscription

A background brain-style run (e.g. a spot check) SHALL select its owner from the
pool of workspace members whose subscription credential is healthy — present, not
blacklisted, and not flagged for re-login — drawing across everyone who holds
either a Codex or a Claude subscription rather than always using the workspace
default provider. Such runs execute on a single owner's credential with no
per-turn failover across the pool, so choosing a live owner up front is what keeps
them from stalling on a dead subscription. The system SHALL run on whichever
provider the picked member holds, preferring Codex when that member has it and
otherwise their other subscription (e.g. Claude), and SHALL rotate the owner
across the pool over successive runs. When no member has a usable subscription,
the system MAY fall back to the requested backend and default owner selection.

#### Scenario: Only a Claude member is available

- **GIVEN** the picked member has a healthy Claude subscription but no Codex
- **WHEN** a spot check runs
- **THEN** the run is owned by that member and executes on their Claude provider

#### Scenario: Picked member has Codex

- **GIVEN** the picked member has a healthy Codex subscription
- **WHEN** a spot check runs
- **THEN** the run uses that member's Codex credential and provider

#### Scenario: Runs rotate across the pool

- **GIVEN** multiple members hold a healthy subscription
- **WHEN** spot checks run repeatedly
- **THEN** the owner rotates across those members rather than always the same one

#### Scenario: Spot-check history identifies the worker

- **WHEN** a member opens a completed spot check from history
- **THEN** the system opens its retained background card with the full worker trace
- **AND** the card identifies the worker owner when it belongs to another member
- **AND** the trace indicates when the worker returned the expired-subscription response

#### Scenario: A spot check exposes an expired subscription

- **GIVEN** a spot check returns the standard no-response message for an expired subscription
- **WHEN** the run is recorded
- **THEN** the run is graded as a warning
- **AND** the owning member's subscription is marked as needing re-login so it is excluded from subsequent background-run selection

### Requirement: An expired credential is surfaced, not silently stalled

When a turn produces no output because the backing subscription expired and could
not refresh, the system SHALL make the failure visible rather than ending
silently. After exhausting the credential pool with no output, the agent SHALL
emit a user-visible message naming the provider and the fix (re-login), so a card
shows why it stalled instead of an indefinite spinner.

#### Scenario: Every pooled credential returns an empty turn

- **GIVEN** all of a workspace's credentials for the turn's provider return no output
- **WHEN** the turn exhausts the pool without producing output
- **THEN** the system emits a visible message identifying the provider and that it
  needs re-login

### Requirement: A user is prompted to re-login an expired subscription

The system SHALL flag a user's subscription credential as needing re-login when a
turn fails because it expired and could not refresh, and SHALL surface that state
to the owning user so they can reconnect. The flag SHALL clear when the credential
is reconnected or successfully refreshes.

#### Scenario: A user's credential expires

- **GIVEN** a user's subscription credential fails a turn because it expired
- **WHEN** the user views their workspace
- **THEN** the system presents a prompt to re-login that subscription

#### Scenario: The user reconnects

- **GIVEN** a credential flagged as needing re-login
- **WHEN** the user reconnects the provider or the credential successfully refreshes
- **THEN** the system clears the re-login prompt

### Requirement: Worker token rotations persist back to the server

Subscription OAuth tokens refresh in place during a turn, and the provider rotates
the refresh token on each refresh. To prevent the server from stranding on an
already-rotated token, a worker that refreshes the **owning user's** credential
SHALL report the rotated credential back to the server so its stored copy stays
current. Credentials vended for another member's run (e.g. a delegated question)
are applied in memory only and SHALL NOT be reported back under the daemon
owner's identity.

#### Scenario: A worker refreshes its owner's vended credential

- **GIVEN** a worker runs a task on its owner's server-vended subscription credential
- **WHEN** the credential's OAuth token rotates during the turn
- **THEN** the worker reports the rotated credential back
- **AND** the server persists it so the next dispatch uses the current token
