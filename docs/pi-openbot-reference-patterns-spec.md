# OpenBot reference patterns for Pi Agents

## Status

Implemented for the local process profile: slices 0 through 8 and 10. Slice 9 remains the explicitly optional container deployment profile. OpenBot remains a reference rather than a runtime dependency, and Pi's architecture and visual identity remain authoritative.

Reference baseline:

- Repository: `https://github.com/CopilotKit/openbot`
- Local review checkout: `C:\Users\bradj\Development\openbot`
- Branch: `main`
- Commit: `d293f2331bd5ff9ba4ad17af6ac94570a157d26d`
- License at the reviewed commit: MIT

Future comparisons must record the reviewed commit. They must not silently track OpenBot `main`.

## Goal

Adopt the strongest reusable interaction, governance, isolation, and lifecycle patterns from OpenBot while preserving the qualities that make Pi Agents distinct:

- `pi --serve` remains a lightweight local-first entry point.
- Pi sessions remain first-class and can run from any working directory.
- The existing Pi dark theme, calligraphic Pi background, compact controls, and responsive layout remain the visual foundation.
- Browser, agent, routine, capability, and provider features continue to use Pi's existing services and persistence.
- Container isolation remains an optional deployment profile, not a local prerequisite.

## Reference-only rule

OpenBot is design evidence, not an implementation dependency.

This work must not add OpenBot, CopilotKit, AG-UI, Bun, Hono, PostgreSQL, pgvector, React, or OpenBot's container supervisor to Pi merely to reproduce a pattern. Any copied code or new dependency requires a separate license, security, maintenance, and architecture review.

## Existing Pi foundations

The implementation must deepen existing Pi modules before creating parallel systems:

- `AgentRegistry`
- `AgentTaskService`
- `AgentRunManager`
- `AgentExecutor` and `ChildProcessAgentExecutor`
- `BrowserSessionManager`
- `BrowserPolicy`
- `CapabilityBroker`
- `CapabilityConnectionRegistry`
- `CapabilityApprovalService`
- `PluginManagementService`
- `ProviderEnvironmentStore`
- `WorkflowService`
- `AgentRoutineScheduler`

## Pattern assessment

| OpenBot pattern | Decision for Pi Agents | Reason |
| --- | --- | --- |
| One gateway for browser, filesystem, command, and connector actions | Adopt as a Pi-native service | Prevents policy and audit rules from drifting between execution paths. |
| Persist the authorization decision before the action | Adopt | A sensitive effect must not occur without a durable explanation. |
| Deny rules before allow rules; malformed policy fails closed | Adopt | Safe and predictable behavior is more important than permissive fallback. |
| Separate durable agent identity from conversations and task attempts | Adopt | Renaming or editing an agent must not corrupt run history. |
| One isolated computer per deployed agent | Adopt as an optional stronger profile | Local child workers are the default; containers become an enterprise profile. |
| Narrow supervisor API: ensure, stop, reset, list | Adopt | Keeps lifecycle authority small and auditable. |
| Human browser takeover refuses agent actions instead of queuing them | Adopt | Queued actions can become stale or unsafe after a person changes page state. |
| Write-only secret entry into a page | Adopt | Credentials must not enter chat, agent context, logs, or screenshots. |
| Transient live activity separate from durable audit | Adopt | Users need immediate feedback while operators need restart-safe evidence. |
| Administrator enables a connector; user authorizes an account; agent receives grants | Adopt | Separates deployment trust, personal authorization, and agent authority. |
| Tool narrowing after grants | Adopt only as optimization | Narrowing can reduce prompt size but must never be treated as authorization. |
| Generative UI components in chat | Defer | Useful later, but not required for the current agent, browser, and settings flows. |
| Mandatory Docker, PostgreSQL, and platform services | Reject as the default | Conflicts with the lightweight local Pi experience. |

## Chosen architecture

### Governed action service

All privileged effects must pass through one deep module, referred to in this specification as `GovernedActionService`. The public API should accept a typed action request and return a normalized result. Callers must not implement provider lookup, grants, policy evaluation, secret resolution, audit writing, and dispatch independently.

The ordered action flow is:

1. Validate and canonicalize the requested target.
2. Resolve the actor, session, agent, task, attempt, and computer identities.
3. Verify the capability or provider grant.
4. Evaluate policy and any required approval.
5. Persist a redacted decision record.
6. Stop if the decision is denied or if decision persistence fails.
7. Resolve credentials inside the trusted adapter boundary.
8. Dispatch the action.
9. Persist the redacted outcome, duration, and safe error classification.
10. Return a normalized result to the caller.

Initial action families are:

- browser navigation and interaction
- filesystem read, write, list, and attachment access
- shell command execution
- provider capability calls
- MCP tool calls

An action must not occur if its authorization decision cannot be recorded.

### Policy model

Pi should use typed rules rather than embedding a general expression language.

Rules must support:

- actor, session, agent, task, and attempt identity
- target family and canonical target
- local, LAN, and remote network classification
- working-directory and permitted-root boundaries
- provider account and capability grant
- explicit approval state
- human or agent browser-control ownership

Evaluation order is fixed: invalid request, explicit deny, missing grant, missing approval, allow, default deny. Local defaults may be convenient, but they must still be explicit and inspectable.

### Durable audit and live activity

OpenBot correctly treats live activity as a window and audit as the record. Pi must preserve this distinction.

The durable audit record contains:

- stable event id and timestamp
- actor, session, agent, task, attempt, and computer ids when applicable
- requested action family
- canonical redacted target
- policy and grant decision
- approval reference when required
- outcome, duration, and safe error classification
- correlation id linking decision and outcome

It must not contain access tokens, OAuth codes, client secrets, passwords, secret field values, raw authorization headers, or unredacted sensitive request bodies.

Live activity may show commands, files, browser steps, and tool names as they occur. It can be session-scoped and ephemeral. Durable audit must survive reload and restart.

### Worker and computer lifecycle

Introduce or deepen a `ComputerLifecycleService` with a deliberately narrow surface:

- `ensure`
- `stop`
- `reset`
- `list`

The first implementation uses isolated local child workers with separate process state, run queues, cancellation, working directories, and browser profiles. A later container implementation may satisfy the same interface for ECR/ECS or other sandbox deployments.

Closing a task, stopping an agent, disconnecting a session, and shutting down `pi --serve` must have explicit cleanup behavior. Orphan detection and restart recovery must be testable.

### Human browser control

Browser control has one explicit owner: `agent`, `human`, or `none`.

When a human takes control:

- new agent browser actions are refused, not queued
- the current owner is visible in the Browser toolbar
- takeover and release are durable audit events
- releasing control requires the agent to observe current page state before acting again
- secret fields use a direct write-only path and never enter conversation history

### Credential store

Provider adapters must receive credential references, never raw secrets from agent definitions or prompts. A `CredentialStore` abstraction should support:

- store or replace a secret
- resolve a secret only for an authorized adapter call
- revoke a secret
- report metadata without returning plaintext

The current `.env.local` mechanism can remain as a migration adapter. A later implementation may use an operating-system credential store or encrypted database without changing agent configuration.

### Connector authorization chain

The effective tool catalog is the result of this ordered chain:

1. The adapter or plugin is installed.
2. The provider is reviewed and enabled for this deployment.
3. Required deployment credentials are configured.
4. The user connects a provider account.
5. The agent is granted specific capabilities for that account.
6. Runtime policy and approvals permit the action.
7. Optional tool narrowing selects relevant tools from the already-authorized catalog.

The UI must never present an installed adapter as an authorized account or an available capability as an enabled agent tool.

### Identity boundaries

These records remain separate:

- `AgentDefinition`: durable persona, instructions, model policy, grants, and defaults
- `Conversation`: messages and selected agent context
- `Task`: user goal and lifecycle
- `Attempt`: one execution attempt with a fixed configuration snapshot
- `ComputerLease`: worker, browser profile, workspace boundary, and control owner

Editing an agent affects future attempts. Existing attempt evidence keeps the configuration snapshot it actually used.

## UI pattern adaptation

OpenBot provides useful information-architecture references, but Pi should not copy its visual treatment or route hierarchy.

| OpenBot UI pattern | Pi Agents adaptation | Explicitly not copied |
| --- | --- | --- |
| Agent cards with durable conversations | Keep persona image, name, role summary, status, and direct-chat entry in the Agents tab | OpenBot card proportions and avatar generator |
| Conversation centered around a stable channel | Open the selected agent in a Pi-style chat tab while preserving task and attempt links | AG-UI or CopilotKit chat components |
| Live computer screen next to activity | Keep Browser as the shared screen/control workspace and expose agent activity through compact, collapsible run details | Permanent verbose activity in the transcript |
| Full-size computer view | Allow the Browser panel to pop out as a child window tied to the session or agent lease | OpenBot's overlay implementation |
| Explicit human takeover and hand-back | Use compact toolbar icons with tooltips and a clear owner state | Large explanatory buttons or repeated instructional text |
| Connected-account settings | Show provider cards with account identity, authorization status, granted scopes, reconnect, and revoke actions | Raw provider ids, secret references, and grant strings as primary UI |
| Separate user settings and administrator controls | Use one Settings workspace with clear Basic and Advanced groupings for the local deployment | A full multi-tenant admin console for local mode |
| Live activity is newest-first and detailed on demand | Collapse tool activity by default; keep user and assistant messages expanded | Dumping command output or tool payloads into ordinary chat |

### Pi workspace map

The resulting Pi layout is:

- Left rail: `Sessions` with an inline `+` action and a gear icon immediately to its right.
- Center: Pi session or selected-agent conversation, using the same message and composer system.
- Right workspace tabs: `Browser | Agents | Agent Builder`.
- Settings: opened by the gear and defined by `docs/pi-settings-workspace-spec.md`.

`Agent Builder` configures an agent against models, provider accounts, capabilities, plugins, MCP servers, routines, and policies that already exist in Settings. It does not duplicate global connection or secret setup.

Selecting an agent opens or focuses its chat in the center. The Agents tab then shows compact identity, run status, active tasks, scheduled-run output, and management actions. Building a new agent may open an Agent Builder conversation, but durable settings remain structured and reviewable.

### Browser presentation

The Browser tab should feel like a browser, not a diagnostic form:

- conventional back, forward, reload, pop-out, record, take-control, and send-steps controls
- icon-first actions with accessible names, tooltips, and visible focus states
- one permitted URL bar
- no default source or network panes
- console and detailed diagnostics available only through an advanced inspection action
- compact owner/status indicator for Pi, agent, or human control
- recorded steps associated with the session, agent, task, attempt, URL, viewport, and entry state

The inline preview reserves stable space only when a live frame exists. Empty browser state must not dominate the conversation or right panel.

### Responsive behavior

The compact mobile presentation also applies to narrow desktop panes and an unfolded Pixel Fold-sized viewport. Breakpoints must be based on available panel width, not only device classification.

At compact widths:

- left and right workspaces become dismissible drawers
- the center chat remains primary
- tabs and toolbars scroll or collapse without clipping labels
- nested horizontal scroll areas are prohibited
- provider capabilities become a single-column list
- primary save actions remain visible without covering fields

### UI status language

Use a small common vocabulary:

- `Installed`: adapter code exists
- `Configured`: deployment settings are valid
- `Connected`: a user account is authorized
- `Available`: the capability can be granted
- `Enabled`: the agent has the grant
- `Blocked`: runtime policy or approval prevents use
- `Running`, `Stopping`, `Stopped`, `Failed`: task or worker lifecycle

Raw ids, secret references, and scope strings belong in an Advanced disclosure, not the default agent-building path.

## Security invariants

- Secrets never enter model context, chat history, audit payloads, screenshots, recorded browser steps, or client-readable configuration responses.
- Paths are canonicalized before boundary checks and must remain inside explicitly permitted roots.
- URLs are canonicalized before network-policy checks. Redirects are evaluated again.
- Loopback, RFC1918 LAN addresses, public addresses, and metadata endpoints are classified separately.
- Browser access and browser policy are enabled or disabled together.
- A capability grant does not bypass runtime policy or approval.
- Human browser control invalidates queued or in-flight assumptions; agent actions are refused until control is released and state is observed again.
- Child workers do not inherit unnecessary environment variables or credentials.
- A plugin manifest is metadata, not trusted code. Installation and activation remain separate decisions.

## Failure and recovery behavior

- Policy parse or validation failure: deny the action and expose a safe operator error.
- Audit decision write failure: do not execute the action.
- Outcome write failure after an external effect: report `outcome_unknown`, preserve correlation data, and require reconciliation rather than retrying blindly.
- Worker crash: mark the attempt failed or interrupted, release its lease, and preserve logs and audit evidence.
- Server restart: recover agent definitions, conversations, tasks, attempts, schedules, provider metadata, and durable audit records; do not silently resume destructive actions.
- Browser disconnect: retain the lease if the worker is healthy, expose reconnect state, and avoid creating a duplicate browser profile.
- Human takeover during an action: complete only an already-acknowledged atomic action; refuse subsequent actions.
- Revoked provider account: remove its tools from future catalogs immediately and fail active calls safely.

## Design alternatives

### Alternative A: adopt OpenBot as the application platform

This gives faster parity with its existing UI and container model but replaces Pi's lightweight runtime, duplicates existing services, and introduces a large framework and infrastructure commitment. Rejected.

### Alternative B: copy individual OpenBot flows into each Pi subsystem

This appears incremental but produces repeated policy, credential, audit, and lifecycle logic. The copies would drift and make future provider or container work harder. Rejected.

### Alternative C: extract stable patterns behind Pi-native deep modules

This preserves Pi's interface and services while centralizing the difficult decisions: authorization, effects, audit, credentials, lifecycle, and control ownership. Chosen.

## Implementation slices

### Slice 0: reference baseline and UX map

- Record the reviewed OpenBot commit and license.
- Capture behavior-level notes and test traces, not copied components.
- Map each adopted pattern to an existing Pi owner or a proposed deep module.
- Add fixtures for policy, audit, control ownership, and restart recovery.

### Slice 1: Settings and agent-builder separation

- Implement `docs/pi-settings-workspace-spec.md`.
- Place the gear beside `Sessions +`.
- Move global models, accounts, capabilities, plugins, MCP, and security controls into Settings.
- Replace raw connection fields in Agent Builder with friendly selectors and status summaries.
- Preserve an Advanced disclosure for diagnostics.

### Slice 2: durable audit

- Add the durable audit record and storage interface.
- Correlate decisions and outcomes.
- Add redaction and serialization tests.
- Keep live activity as a separate session-scoped stream.

### Slice 3: governed browser and provider actions

- Introduce `GovernedActionService` for browser and capability calls.
- Route existing browser and provider entry points through it.
- Enforce canonicalization, grants, approvals, policy, decision persistence, dispatch, and outcome persistence.
- Remove duplicate authorization logic only after parity tests pass.

### Slice 4: browser control ownership

- Persist and display `agent`, `human`, or `none` ownership.
- Refuse rather than queue agent actions during human control.
- Add take-control, hand-back, and state-reobservation flows.
- Add write-only secret entry with redaction tests.

### Slice 5: worker lifecycle

- Implement the narrow lifecycle interface for local child workers.
- Isolate run queues, cancellation, working directory, environment, and browser profile per worker.
- Define shutdown, stop, reset, orphan detection, and restart recovery.
- Expose compact status and detailed activity on demand.

### Slice 6: filesystem, shell, and MCP governance

- Route filesystem, shell, and MCP actions through the same governed action flow.
- Apply permitted-root, command, network, and provider policies.
- Preserve consistent audit and error behavior across action families.

### Slice 7: credential abstraction

- Put `.env.local` behind `CredentialStore`.
- Ensure client APIs return only safe metadata.
- Route OAuth refresh and provider calls through trusted adapters.
- Add revoke, replace, and restart-recovery tests.

### Slice 8: tool exposure and operator feedback

- Build the effective tool catalog from installation, deployment enablement, account connection, agent grant, and runtime policy.
- Apply optional relevance narrowing only after authorization.
- Show why a tool is unavailable, blocked, or awaiting configuration.
- Keep messages expanded and tool activity collapsed by default.

### Slice 9: optional container profile

- Implement the lifecycle interface with one container, workspace, and browser profile per agent lease.
- Keep container authority outside agent processes.
- Validate equivalent policy, audit, stop, reset, and cleanup behavior.
- Document ECR/ECS constraints separately from local defaults.

### Slice 10: end-to-end validation and documentation

- Run focused unit and integration tests for every affected module.
- Run `npm run check`.
- Run a live `pi --serve` smoke test from outside the repository.
- Validate desktop, narrow-pane, mobile, and unfolded Pixel Fold layouts.
- Validate Pi-session chat, selected-agent chat, agent-builder configuration, OAuth connection, browser takeover, recorded-step replay, parallel agents, stop, restart, and recovery.
- Update README and architecture documentation only after the behavior is verified.

## Validation matrix

| Scenario | Required result |
| --- | --- |
| Agent calls an allowed provider tool | Grant, policy decision, redacted audit, call, and outcome are correlated. |
| Agent calls an installed but ungranted tool | Call is denied before credential resolution. |
| Policy is malformed | Action is denied and no external effect occurs. |
| Audit storage is unavailable | Action is not dispatched. |
| Human takes browser control | Subsequent agent browser actions are refused and visible in activity. |
| Human releases control | Agent observes current state before its next action. |
| Secret is supplied to a page | Page receives it; chat, audit, screenshots, and recorded steps do not. |
| Two agents run in parallel | Each has isolated queue, process state, working directory boundary, and browser lease. |
| One agent is stopped | Its child work terminates without stopping unrelated sessions or agents. |
| Server restarts | Durable identities, conversations, tasks, attempts, schedules, accounts, and audit recover consistently. |
| Provider account is revoked | Its tools disappear and later calls fail safely. |
| Right panel is resized narrowly | Text wraps inside cards, controls remain reachable, and no horizontal page overflow appears. |
| Mobile attachment and browser flows | Native file selection, upload, live browser view, control, and pop-out alternatives remain usable. |

## Completion criteria

This specification is complete only when:

- adopted OpenBot patterns are implemented behind Pi-native interfaces
- Settings and Agent Builder have distinct ownership and no disconnected controls
- privileged actions use one governed decision-to-outcome path
- persistence and restart recovery are verified
- security, secret redaction, path validation, and network-policy tests pass
- parallel worker isolation and deterministic termination pass
- focused unit and integration tests pass
- `npm run check` passes
- live `pi --serve` smoke testing passes
- desktop and mobile browser interaction validation passes
- documentation explains both local and optional isolated deployment profiles

## Non-goals

- Recreating OpenBot's product or visual theme
- Replacing Pi's session model with OpenBot channels
- Adding multi-tenant billing or hosted administration to local mode
- Making Docker, PostgreSQL, or a cloud account mandatory
- Treating tool narrowing, model judgment, or UI state as an authorization boundary
- Importing OpenBot code without an explicit dependency and license review
