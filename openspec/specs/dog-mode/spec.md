# Dog Mode

How the opt-in 3D game view of the workspace board behaves for browser users.

## Purpose

Defines dog mode: a three.js "boardwalk" world rendered in place of the 2D board, where a
player character (the corgi) walks between status districts and performs board operations.
Dog mode is a view, not a fork — every object derives from the same client stores the 2D
board reads, and every interaction dispatches the same API calls the 2D UI uses. Design
rationale and module map live in `docs/GAME_MODE.md`.

## Requirements

### Requirement: Dog mode is opt-in and isolated from the default experience

The system SHALL render the standard 2D board by default. Dog mode SHALL activate only via
the user-menu toggle, the `?game=1` query parameter, or a persisted local preference, and
SHALL be deactivatable by the same paths. The game module and its assets SHALL NOT load
unless dog mode is entered.

#### Scenario: Default users are unaffected

- **WHEN** a user who has never enabled dog mode opens a workspace
- **THEN** the 2D board renders with unchanged behavior
- **AND** no game code or model assets are downloaded

#### Scenario: Toggling round-trips cleanly

- **WHEN** the user enables dog mode and later disables it
- **THEN** the 3D view replaces only the board area, and disabling restores the 2D board
- **AND** the preference persists across sessions

### Requirement: The world mirrors board state through the same data layer

The system SHALL derive every world object from the same client stores the 2D board uses
(cards, members, untracked PRs, Linear tickets, pending worker questions), applying the same
board-mode visibility rules (Mine / All team / Automated). World layout SHALL be a pure,
deterministic function of that state.

#### Scenario: Board scope applies in-world

- **GIVEN** board mode "Mine"
- **WHEN** the world is built
- **THEN** only the user's visible cards appear as kiosks, matching the 2D board's filter

### Requirement: The boardwalk layout encodes the kanban flow

The system SHALL lay out one district per board column along a street in board order
(alternating sides), with intake (PR depot, Linear yard, workspace portals) west of the
first district. Districts SHALL show at most a fixed cap of the most recently updated
cards, with a "+N more" indicator and a true count on the district banner.

#### Scenario: A column exceeds the kiosk cap

- **GIVEN** a column with more cards than the cap
- **WHEN** the world is built
- **THEN** the freshest cards (by update time) appear as kiosks
- **AND** the remainder is represented by a "+N more" totem while the banner shows the full count

### Requirement: Interactions reuse 2D operations exactly

The system SHALL route every game interaction through the same client operations as the 2D
UI: tap-interact opens the real task view or performs the target's default action; the
hold-interact radial wheel exposes card operations (open, carry, reassign, auto-merge,
link PR, fix conflicts/checks) near a card and all app-level operations (new card, refresh,
board scope, workers, spot checks, settings, server logs, brain chat) elsewhere; operations
SHALL use the same endpoints, optimistic updates, and error surfacing as the 2D board.

#### Scenario: Reassigning via the wheel

- **WHEN** the player confirms a reassignment in the card wheel
- **THEN** the same assignee endpoint is called as from the 2D board's card menu
- **AND** failures roll back optimistically-updated state and surface a toast

### Requirement: Carrying a card is drag-and-drop parity

The system SHALL let the player pick up a card, walk it into another district, and drop it,
producing the same status transition as dragging on the 2D board. Allowed targets SHALL be
validated with the shared drag-affordance rule; invalid drops SHALL be rejected with
feedback and valid target districts SHALL be visually telegraphed while carrying. Canceling
SHALL restore the card without any API call.

#### Scenario: Dropping in a valid district

- **GIVEN** the player is carrying a card whose status may transition to the target column
- **WHEN** they drop it inside that district
- **THEN** the status-transition endpoint is called with the target status

#### Scenario: Canceling a carry

- **WHEN** the player cancels while carrying
- **THEN** no API call is made and the card remains unchanged

### Requirement: Labels use distance-based level of detail

The system SHALL keep production-sized boards readable by showing full detail faces only
near the player (or on the current target), compact identifier plates at mid range, and
geometry only beyond that; a fixed HUD inspector SHALL always show full details of the
nearest object in legible DOM text.

#### Scenario: Standing far from a district

- **WHEN** the player is far from a kiosk
- **THEN** that kiosk renders without a readable text label
- **AND** approaching it fades in its identifier plate, then its full face

### Requirement: Intake aggregates PRs and Linear tickets

The system SHALL represent untracked PRs and the user's Linear tickets as intake yards: a
bounded number of sample item kiosks carrying full item details (PR number/title/repo/
branch/author; ticket identifier/title/state/priority), plus a depot whose browse wheel
lists a bounded set of items. Confirming an item SHALL track the PR as a card or open the
prefilled new-card flow for a ticket.

#### Scenario: Tracking a PR from the depot wheel

- **WHEN** the player confirms a PR in the depot's browse wheel
- **THEN** the same create-card-from-PR endpoint is called as from the 2D board

### Requirement: The Linear yard filters by workflow state name

The system SHALL display one Linear workflow state at a time in the yard, keyed by state
name (not type), defaulting to the state literally named "Todo", then the first
unstarted-type state, then the first available. The active state and its count SHALL be
prominently indicated, and the yard's wheel SHALL offer switching between all states
present with counts. The chosen filter SHALL persist locally.

#### Scenario: Multiple unstarted-type states

- **GIVEN** tickets in states "Todo", "Upcoming", and "On call triage" (all type unstarted)
- **WHEN** the yard renders with the default filter
- **THEN** only "Todo" tickets appear, and the switcher lists the three states separately

### Requirement: Navigation aids scale to large boards

The system SHALL provide a minimap of the street (districts in board order plus the player),
click-to-travel on the minimap, a whistle search that matches identifiers first and then
title substrings and auto-runs the player to the match with a visible beacon, and
edge-of-screen markers for off-screen pending worker questions.

#### Scenario: Whistling for a card

- **WHEN** the player searches for a card's display id
- **THEN** the matching kiosk is beaconed and the player auto-runs toward it
- **AND** a non-matching query produces feedback and no movement

### Requirement: Shipping progress is visible in-world

The system SHALL display a trophy row at the Done district with one marker per card merged
within the last seven days (bounded), labeled with the count.

#### Scenario: Cards merged this week

- **GIVEN** cards completed with done-reason "merged" within seven days
- **WHEN** the world is built with a current clock
- **THEN** the Done district shows that many trophies (up to the display cap)

### Requirement: Production data can back local dev without deployment

The system SHALL support an explicitly env-gated dev-server mode that proxies API and
websocket traffic to production with a user-supplied session cookie, and SHALL leave
default local development behavior unchanged when the gate is unset.

#### Scenario: Gate unset

- **WHEN** the dev server runs without the prod-proxy env vars
- **THEN** API and websocket traffic proxies to the local server as before
