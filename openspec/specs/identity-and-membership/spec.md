# Identity and Membership

How browser users authenticate, discover their identity, and join workspaces.

## Purpose

Defines the existing browser-facing identity behavior: Google login, logout, current-user bootstrap,
preference updates, and invitation preview/acceptance.

## Requirements

### Requirement: Users authenticate through Google OAuth

The system SHALL start Google OAuth from the browser API and complete the callback by creating a
Manta session cookie before redirecting the user back to the web app.

#### Scenario: Login starts

- **WHEN** an unauthenticated browser starts Google login
- **THEN** the system redirects the browser to Google's OAuth authorization flow
- **AND** stores the OAuth state needed to validate the callback

#### Scenario: Login completes

- **WHEN** Google redirects back with a valid authorization callback
- **THEN** the system resolves the Google profile to a Manta user
- **AND** creates a session cookie
- **AND** redirects to the web app

### Requirement: Users can clear their browser session

The system SHALL provide a logout operation that clears the Manta session cookie.

#### Scenario: Logout request

- **WHEN** a browser requests logout
- **THEN** the system clears the session cookie
- **AND** returns a successful JSON response

### Requirement: Current-user bootstrap includes memberships and linked-account status

The system SHALL return the authenticated user's profile fields, workspace memberships, worker
onboarding state, and linked account identifiers/status used by the web app bootstrap.

#### Scenario: Authenticated user loads the app

- **GIVEN** a browser has a valid Manta session
- **WHEN** it requests the current user
- **THEN** the system returns the user's id, email, optional profile fields, memberships, worker
  connection history, onboarding preference, and linked GitHub/Slack/Linear status

### Requirement: Users can update supported preferences

The system SHALL accept supported current-user preference updates and reject requests that contain no
valid preference field.

#### Scenario: Local worker onboarding is dismissed

- **WHEN** the user updates `localWorkerOnboardingDismissed` to a boolean value
- **THEN** the system persists the preference for that user
- **AND** returns the stored preference value

#### Scenario: No valid preference supplied

- **WHEN** the user submits a preferences update without any supported preference value
- **THEN** the system rejects the request as invalid

### Requirement: Workspace members can identify non-engineer members

The system SHALL let workspace members mark workspace users as non-engineers and SHALL
surface that classification in the workspace members list.

#### Scenario: Member marks a member as non-engineer

- **GIVEN** a workspace member is viewing the workspace members list
- **WHEN** they mark a member as a non-engineer
- **THEN** the system persists the member's non-engineer classification
- **AND** subsequent members-list responses include the updated classification

#### Scenario: Non-member cannot mark non-engineers

- **GIVEN** an authenticated user is not a member of the workspace
- **WHEN** they attempt to change a user's non-engineer classification in that workspace
- **THEN** the system rejects the request as forbidden

### Requirement: Authenticated users can preview and accept invitations

The system SHALL allow a logged-in user to preview a workspace invitation and accept it even when the
user is not already a member of that workspace.

#### Scenario: Invitation preview exists

- **WHEN** an authenticated user previews a valid invitation code
- **THEN** the system returns the invitation preview

#### Scenario: Invitation is accepted

- **WHEN** an authenticated user accepts a valid invitation code
- **THEN** the system adds or recognizes the user's workspace membership
- **AND** returns the workspace id and whether the user was already a member
