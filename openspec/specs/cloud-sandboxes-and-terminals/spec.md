# Cloud Sandboxes and Terminals

How Manta exposes cloud task sandboxes and terminal connectivity for active tasks.

## Purpose

Defines existing Daytona/cloud sandbox controls, local-worker migration, and terminal endpoint
discovery/reconnection behavior.

## Requirements

### Requirement: Users can list visible cloud sandboxes

The system SHALL list live cloud sandboxes labeled for Manta and SHALL include only sandboxes whose
workspace label belongs to a workspace the current user is a member of. Provider-archived sandbox
records SHALL be omitted because they can no longer be resumed or controlled as workers.

#### Scenario: User lists sandboxes

- **WHEN** a user requests sandboxes
- **THEN** the system returns sandboxes only for workspaces the user belongs to
- **AND** includes task details when the labeled task still exists

#### Scenario: Provider retains an archived sandbox record

- **GIVEN** the cloud provider retains an archived sandbox until its automatic deletion window
- **WHEN** a user requests sandboxes
- **THEN** the archived sandbox is not returned in the worker list

### Requirement: Cloud sandbox controls are task and membership scoped

The system SHALL require both workspace membership and a task that belongs to that workspace before
stopping, removing, resuming, or moving a cloud sandbox.

#### Scenario: Task does not belong to workspace

- **WHEN** a user supplies a task id with a workspace it does not belong to
- **THEN** the system rejects the sandbox control request

### Requirement: Users can stop or remove task cloud sandboxes

The system SHALL support stopping a task's cloud sandbox and separately removing it for full cleanup.
Remove failures SHALL surface to the UI instead of being reported as success.

#### Scenario: Sandbox stop succeeds

- **WHEN** a workspace member stops a sandbox for an active task in that workspace
- **THEN** the system stops the cloud sandbox and revokes its worker credential

#### Scenario: Sandbox remove fails

- **WHEN** the system cannot delete the cloud sandbox
- **THEN** it returns a delete-failed error so the UI can surface the problem

### Requirement: Automation background runs are dispatched to the cloud venue

The system SHALL dispatch machine-initiated background/automation runs (those carrying a background
mode such as spot checks, pollers, and Linear/Slack automations) to the isolated cloud sandbox venue
rather than a workspace member's connected laptop daemon, even when the run carries a `createdBy` owner
for credential resolution. An explicit laptop-only (move-to-local) request SHALL still override this.

#### Scenario: Spot-check background run prefers the cloud sandbox

- **GIVEN** a background/automation task whose creator has a connected laptop daemon
- **WHEN** the system dispatches a worker for that task
- **THEN** the system selects the isolated cloud sandbox venue instead of the creator's laptop
- **AND** the task's credentials still resolve from its `createdBy` owner

#### Scenario: Human-authored task still prefers the creator's laptop

- **GIVEN** a task with no background mode whose creator has a connected laptop daemon
- **WHEN** the system dispatches a worker for that task
- **THEN** the system selects the creator's laptop daemon venue

### Requirement: Cloud sandbox resume only wakes existing eligible cloud tasks

The system SHALL resume only tasks that already use the cloud venue, are not complete/canceled, and
are not already active or provisioning.

#### Scenario: Resume requested for non-cloud task

- **WHEN** a user requests resume for a task whose worker venue is not cloud
- **THEN** the system rejects the request as not a cloud task

#### Scenario: Resume requested for sleeping cloud task

- **WHEN** a user requests resume for an eligible sleeping cloud task
- **THEN** the system wakes or reattaches the cloud worker without dispatching a new user turn

### Requirement: Cloud tasks can move back to a local worker when possible

The system SHALL move an eligible cloud task back to its creator's local worker only when the task
has an owner, a local worker is connected, and the cloud sandbox has been stopped successfully.

#### Scenario: Local worker unavailable

- **WHEN** a user requests move-to-local and the task owner has no connected local worker
- **THEN** the system rejects the request without stopping or redispatching the task

#### Scenario: Move-to-local succeeds

- **WHEN** an eligible cloud task is moved to local
- **THEN** the system stops the cloud sandbox
- **AND** redispatches the original user request to the local worker venue

### Requirement: Browser terminals can discover direct worker endpoints

The system SHALL provide direct terminal endpoint details when the worker holding a task exposes a
loopback terminal port, and SHALL otherwise return no direct endpoint so the browser can fall back to
the relay.

#### Scenario: Direct terminal available

- **WHEN** a member requests a terminal endpoint for a task with a worker terminal port
- **THEN** the system grants a short-lived terminal token to the worker
- **AND** returns host, port, token, and expiration details to the browser

#### Scenario: Direct terminal unavailable

- **WHEN** no worker terminal port is available for the task
- **THEN** the system returns a null direct endpoint

### Requirement: Local task terminals can reconnect without starting a turn

The system SHALL reconnect a local task terminal to an available local worker without starting a new
worker turn, and SHALL reject reconnect for cloud tasks or completed/canceled tasks.

#### Scenario: Local terminal reconnect succeeds

- **WHEN** the task is local, active, and its owner worker can be rebound
- **THEN** the system reconnects terminal routing and returns success

### Requirement: Task terminals preserve shell editing alignment

The system SHALL render task terminal prompts with shell-visible width that matches the browser
terminal grid, so command-line editing and completion redraws do not overwrite user input.

#### Scenario: User completes a command at the Manta prompt

- **WHEN** a user types at the task terminal prompt and invokes shell completion
- **THEN** the cursor remains after the prompt marker
- **AND** the partially typed command remains intact while completion redraws the line

### Requirement: Focused task terminals receive Escape input

The system SHALL not dismiss an open task card when Escape is pressed while a task terminal has
focus, so the terminal receives the key input.

#### Scenario: User presses Escape in a focused terminal

- **WHEN** a task card is open and its terminal has focus
- **AND** the user presses Escape
- **THEN** the task card remains open
- **AND** the terminal receives the Escape input
- **AND** the terminal retains focus
