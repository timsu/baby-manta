# Identity and Membership

How browser users authenticate, discover their identity, and join workspaces.

## Purpose

Defines the existing browser-facing identity behavior: sign-in (Google OAuth and passwordless
email), logout, current-user bootstrap, preference updates, and invitation preview/acceptance.

## Requirements

### Requirement: The browser can discover which sign-in methods are offered

The system SHALL expose, without authentication, which sign-in methods this deployment offers, so
the web app renders only methods that will actually work.

#### Scenario: Methods are queried

- **WHEN** an unauthenticated browser asks which sign-in methods are available
- **THEN** the system reports whether Google OAuth is configured
- **AND** reports whether passwordless email sign-in is enabled

### Requirement: Users can sign in with an email address alone

The system SHALL support passwordless sign-in in which an email address is sufficient to obtain a
session, creating the user account on first sign-in. Because this grants a session without proving
control of the address, it SHALL be disabled by default in production and enabled by default
outside it, so a fresh checkout is usable with no third-party OAuth client.

#### Scenario: A new address signs in

- **WHEN** a browser submits an email address that has no account
- **THEN** the system creates a user for that address
- **AND** creates a session cookie

#### Scenario: A known address signs in

- **WHEN** a browser submits an email address that already has an account
- **THEN** the system signs in as that existing user rather than creating a second account

#### Scenario: The address is malformed

- **WHEN** a browser submits something that is not a valid email address
- **THEN** the system rejects the request
- **AND** creates no session and no account

#### Scenario: Email sign-in is disabled

- **WHEN** a browser attempts passwordless sign-in on a deployment where it is disabled
- **THEN** the system refuses the request without creating a session

### Requirement: Users authenticate through Google OAuth

The system SHALL start Google OAuth from the browser API and complete the callback by creating a
Manta session cookie before redirecting the user back to the web app. When no OAuth client is
configured the system SHALL refuse the Google routes rather than fail to start.

#### Scenario: Google is not configured

- **WHEN** a browser starts Google login on a deployment with no OAuth client configured
- **THEN** the system refuses the request
- **AND** the rest of the application continues to serve normally

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
