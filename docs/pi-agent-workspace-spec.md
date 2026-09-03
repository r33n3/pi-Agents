# Pi agent workspace and orchestration specification

## Status

Implementation contract for the consolidated `pi --serve` agent workspace.
This document supersedes the former Preview, Activity, Routines, Capabilities,
and Builder workspace layout. Existing localhost authentication, Pi session
ownership, and managed-browser security invariants remain unchanged.

## Goal

Make locally deployed agents persistent participants beside the active Pi
session. An operator can create an agent through Pi or Agent Builder, chat with
it, assign recurring work, connect agents into workflows, inspect results, and
optionally expose the same task contract through an authenticated A2A adapter.

The system has one authoritative agent registry and one execution path. Agent
chat, scheduled routines, workflow delegation, Pi delegation, and A2A requests
must not create separate run models.

## User experience

The left pane owns Pi Sessions and the persistent Agents roster. The center
shows the selected live Pi session or agent inbox conversation. The right
drawer provides Browser and Workflow/Attention assistance; Agent Builder
configuration opens there when requested from the conversational build or edit
flow.

This ownership keeps agents formatted as persistent participants beside Pi
sessions without turning the right drawer into another navigation hierarchy.
Approvals, questions, workflow progress, and supporting browser state may open
in the drawer while the user continues the conversation in the center.

### Agents roster and inbox

Agents appear below Sessions as compact roster rows containing persona image,
agent name, status, unread or attention state, and current task summary.
Selecting a row focuses that agent's persistent conversation in the center.
Sending a message creates a task in that conversation; it does not open the old
isolated-run form or create a replacement inbox.

The selected-agent view contains:

- chat transcript and composer;
- queued, running, and recently completed tasks;
- scheduled routine runs and next-run state;
- workflow delegation and returned-result events;
- output and artifact links;
- stop, retry, and continue controls where valid; and
- a three-dot menu for edit, run task, pause/resume schedules, duplicate, and
  remove.

Tool activity and orchestration events are collapsed by default. Agent and user
messages remain expanded.

### Agent Builder workflow

Agent Builder begins as a conversation in the center. Its structured
configuration opens in the right drawer. The conversation-first creation,
selective clarification, in-chat testing,
feedback refinement, readiness review, exact yes/no approval, and later-edit
contract follows the
[conversation-first agent building specification](pi-conversation-first-agent-building-spec.md).
The structured drawer is a synchronized view of the authoritative build record,
not a separate draft or deployment path. It contains these internal sections:

- **Chat** — conversationally create or revise the definition.
- **Profile** — name, image, description, persona, and project folder.
- **Model & Tools** — provider/model, thinking level, local and remote tools,
  plugins, MCP and API connections, browser access, permissions, and executor.
- **Connections** — agents this agent may delegate to, workflow role, A2A
  exposure, concurrency, and delegation-depth limits.
- **Automation** — routines, cron schedules, timeout, enabled state, and target
  workflow.

Pi sessions discover their own tools. Explicit capability selection applies to
deployed agents only.

### Interaction design

The console remains conversation-first and preserves the existing dark Pi
theme, resizable sidebars, and faded calligraphic Pi background. Permanent
instructional text is avoided. Empty views use the background mark and compact
status rather than explanatory paragraphs.

- Familiar toolbar actions use 30–36 px icons with accessible labels and
  tooltips.
- The selected top-level destination may show its short label; inactive
  destinations may be icon-only when their meaning remains clear.
- Three-dot menus contain secondary actions such as Edit, Duplicate, Pause,
  Archive, and Delete.
- Red is reserved for Stop, active recording, destructive actions, and errors.
- Status is never communicated by color alone.
- Tool activity, thinking, workflow handoffs, and diagnostics are collapsed by
  default. User messages, agent messages, and final results remain expanded.
- Approval and destructive actions use explicit text inside their card or
  confirmation dialog; they are not represented by an ambiguous icon alone.
- Browser and selected-agent views may open in session-bound child windows.

## Design alternatives

### Alternative A: extend the current run manager

Add conversation IDs, workflow fields, cron state, and A2A metadata directly to
`AgentRunManager`. This minimizes the initial diff but makes every new source
aware of run storage and executor lifecycle. Chat and orchestration would also
need to reconstruct durable conversation state from independent run records.

### Alternative B: agent task service over execution attempts

Introduce an `AgentTaskService` that owns conversations, tasks, events,
delegation, and results. The existing executor becomes an implementation detail
that creates an attempt for a task. Routines, workflows, Pi, the browser client,
and A2A call the same small task interface.

**Decision:** use Alternative B. It adds a migration boundary now, but hides
executor, persistence, queue, and event details from every future caller. This
prevents chat, cron, workflows, and A2A from becoming four execution systems.

## Authoritative modules

```text
ServeHost
  ├─ AgentRegistry
  │    ├─ managed definitions
  │    ├─ Pi Markdown agent catalog
  │    └─ PersonaCatalog
  ├─ AgentTaskService
  │    ├─ ConversationStore
  │    ├─ TaskStore / EventStore
  │    ├─ AgentExecutor adapters
  │    └─ ArtifactStore
  ├─ WorkflowService
  │    └─ submits and observes AgentTaskService tasks
  ├─ CronRoutineService
  │    └─ submits AgentTaskService or WorkflowService tasks
  ├─ A2AAdapter
  │    └─ authenticated mapping to AgentTaskService
  └─ BrowserSessionManager
```

`AgentRegistry` owns deployed configuration. `AgentTaskService` owns runtime
work. `WorkflowService` owns dependency graphs. `CronRoutineService` owns time
calculation. `A2AAdapter` owns wire-protocol mapping and authentication. No
other module writes their persistence formats directly.

## Agent registry

### Definition

```ts
interface AgentDefinition {
  id: string;
  revision: number;
  source: "managed" | "pi-agent";
  name: string;
  description: string;
  image?: AgentImageRef;
  persona?: PersonaRef;
  personaInstructions: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  projectRoot: string;
  tools: AgentToolGrant[];
  browser: AgentBrowserPolicy;
  executor: "session" | "harness";
  permissionPolicy: AgentPermissionPolicy;
  delegateAgentIds: string[];
  a2a: { enabled: boolean };
}
```

The registry validates paths, tools, delegation references, browser policy,
and immutable identity before atomically replacing a definition. Runtime task
state is never stored in the definition.

### Pi-created agents

Pi receives one `agent_deploy` upsert operation backed by the registry. It
creates or updates a definition, validates and atomically persists it, emits a
registry event, and returns the deployed agent ID and revision.

Direct edits to supported Pi Markdown agent files remain visible because the
registry already reads that catalog. Managed JSON files are not a public write
API. Agent Builder and Pi use registry operations rather than constructing file
paths.

Once deployed, an agent appears in the left Agents roster on the next registry event;
no server restart is required.

## Persona catalog

The initial catalog source is the generated Personas project catalog. Resolve
it in this order:

1. explicit `PI_PERSONAS_DIR` configuration;
2. configured serve-host option; then
3. sibling `Personas` project discovery for local development.

The adapter consumes `site/src/personas.generated.json` and its public image
directory. It exposes persona ID, display name, category, description, compiled
instructions, version or source digest, and image. Agent definitions snapshot
the compiled instructions so an external catalog change cannot silently alter
a deployed agent. The persona reference supports an intentional refresh.

Persona affects communication and decision style only. Tools, filesystem
access, delegation authority, and safety policy remain separate grants.

## Plugins, connections, tools, and grants

Agent Builder > Model & Tools presents three compact capability groups:

1. **Built-in tools** — Pi tools supplied by the selected executor.
2. **Plugins** — installed Pi packages or extensions that contribute tools,
   skills, prompts, providers, or UI behavior.
3. **MCP & API connections** — configured remote servers, hosted connectors,
   and authenticated API endpoints.

These concepts remain distinct:

```text
plugin     installed code and packaged resources
connection authenticated configuration for an external system
tool       one callable capability contributed by a built-in, plugin, or connection
grant      permission for one deployed agent to use that tool
```

Pi sessions continue to discover their configured built-in, extension, and
custom tools. Deployed agents receive an explicit allowlist of grants. Installing
a plugin globally does not automatically enable its tools for every agent.

### Capability cards

A plugin or connection is represented by a compact card containing icon, name,
one-line description, tool count, and Installed, Connected, Unavailable, or
Needs approval state. Expanding the card shows individual tools, read/write or
external-action classification, connection health, source, version, and the
per-agent enable controls.

The browser console obtains tool names and source metadata from Pi's configured
tool catalog instead of maintaining a second tool inventory. Dynamic extension
tools become selectable after registration without requiring a serve restart.

### Inline chat setup

Pi, an agent, or Agent Builder may recommend a capability in chat. Agent
Builder performs lifecycle changes through its compact plugin card. The user
must explicitly approve each state-changing step:

1. install the plugin when absent;
2. authenticate or configure its connection;
3. grant selected tools to the requesting agent; and
4. approve consequential tool calls according to policy.

Authentication uses a secure handoff or browser takeover. Passwords, access
tokens, passkeys, one-time codes, and CAPTCHA answers are not inserted into the
conversation, agent definition, task events, or model context.

Plugin installation, removal, update, enablement, and authentication are served
through validated host operations. Models do not receive an unrestricted shell
path for package management.

### Capability lifecycle

- Plugin source and version are persisted with each installation.
- Updates that add tools or expand permissions require renewed review.
- Tool-name collisions fail validation and identify both contributing sources.
- Connection state records health and the last successful check without storing
  secrets in browser-visible data.
- Agent deployment fails when a required grant cannot be resolved.
- Routine and workflow validation reports missing or unhealthy required
  capabilities before enablement.
- A scheduled task encountering an unavailable connection records an explicit
  failure; it does not silently use stale data.

Canonical capability IDs, provider selection, trust review, conflict handling,
productivity connections, and the two delivery waves follow the
[capability platform specification](pi-capability-platform-spec.md).

## Persistent conversations and tasks

Stable agent inbox identity, roster presentation, bounded context, durable
agent-to-agent delivery, and collaboration rooms follow the
[agent roster and collaboration specification](pi-agent-roster-collaboration-spec.md).
That collaboration layer submits through `AgentTaskService` and
`WorkflowService`; it does not introduce another task or conversation runtime.

### Contract

```ts
interface AgentTaskService {
  ensureAgentInbox(agentId: string): Promise<AgentConversation>;
  submit(request: SubmitAgentTask): Promise<AgentTask>;
  continue(taskId: string, message: AgentMessageInput): Promise<AgentTask>;
  cancel(taskId: string): Promise<AgentTask>;
  getTask(taskId: string): AgentTask | undefined;
  listTasks(filter: AgentTaskFilter): AgentTask[];
  subscribe(filter: AgentEventFilter, listener: AgentEventListener): Unsubscribe;
}
```

Every task records:

```text
id, conversationId, agentId, parentTaskId, workflowRunId, source,
status, prompt, model, timestamps, attemptIds, result, artifacts, error
```

`source` is one of `chat`, `pi`, `agent`, `routine`, `workflow`, or `a2a`. A task may
have multiple attempts after explicit retry, but callers never manage executor
leases directly. The service guarantees at most one mutating attempt for an
agent project root unless the definition explicitly permits safe concurrency.

Conversation history and task events are durable. An agent chat can continue
after serve-host restart. Executor transcripts remain evidence attached to an
attempt; they are not the authoritative conversation model.

## Shared state and artifacts

Durable run recovery, operator attention, contract review, and permission modes
are defined by the
[durable work and attention specification](pi-durable-work-attention-spec.md).
Artifact identity, versioning, preview, refresh, provenance, and retention are
defined by the
[artifact workspace specification](pi-artifact-workspace-spec.md). Those
documents refine this section without creating a separate task or execution
model.

Agents do not implicitly share private memory or transcripts. Coordination uses
explicit state:

- parent task context supplied during delegation;
- immutable result messages;
- artifact references with validated paths and content metadata;
- an optional workflow scratch directory scoped to one workflow run; and
- the configured project root when agents intentionally share a workspace.

This makes cross-agent inputs reviewable and prevents accidental context or
credential leakage. Supervisor agents receive child status and result events,
not unrestricted access to child transcripts.

## Workflows and orchestration

### Definition

```ts
interface WorkflowDefinition {
  id: string;
  name: string;
  pattern: "sequential" | "parallel" | "supervisor";
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  maxConcurrency: number;
  maxDelegationDepth: number;
  failurePolicy: "stop" | "continue" | "supervisor-decides";
}
```

Initial patterns:

- **Sequential** — each completed result becomes bounded context for the next
  node.
- **Parallel** — independent nodes start up to `maxConcurrency`; a gather node
  receives their results.
- **Supervisor** — a designated agent decomposes a goal, delegates only to its
  allowed agents, monitors status, may request bounded revisions, and produces
  the final user report.

Workflow graphs are validated before deployment: referenced agents must exist,
cycles are rejected, fan-out and delegation depth are bounded, and output
collisions are rejected. Nested supervisor delegation is disabled by default.

The supervisor is a normal agent definition, commonly using a manager or
technical-lead persona. Its persona does not grant delegation. Its definition
must separately list allowed agents and limits. A supervisor's final response
must summarize outcome, completed work, unresolved issues, and artifact links.

## A2A adapter

The internal task contract is transport-neutral. The A2A adapter may publish
enabled agents and map authenticated external task lifecycle operations to
`AgentTaskService`.

### Conformance baseline

The authoritative source is the official
[A2A repository](https://github.com/a2aproject/A2A). The first implementation
targets the `v1.0.1` tagged specification and its checked-in
`specification/a2a.proto` definition. The negotiated protocol value is `1.0`,
not `1.0.1`: A2A uses only `Major.Minor` on the wire and treats patch releases
as compatible specification corrections.

The adapter uses the `HTTP+JSON` binding for the first implementation because
it fits the existing authenticated serve host. It must:

- publish an Agent Card at `/.well-known/agent-card.json` with an ordered
  `supportedInterfaces` entry declaring `HTTP+JSON`, its absolute endpoint URL,
  and `protocolVersion: "1.0"`;
- require and validate `A2A-Version: 1.0` on A2A operations, returning the
  specified version-not-supported error for unsupported versions;
- use `application/a2a+json` for request and response payloads;
- implement `POST /message:send`, `POST /message:stream`, `GET /tasks/{id}`,
  `GET /tasks`, `POST /tasks/{id}:cancel`, and
  `POST /tasks/{id}:subscribe`;
- deliver streaming task and artifact updates through Server-Sent Events in
  generation order;
- map conversation identity to A2A `contextId`, task identity to A2A `id`,
  communication to `Message`, and durable output to `Artifact`; and
- return protocol-defined task states and structured A2A errors rather than
  exposing internal executor errors directly.

The implementation may use the official `@a2a-js/sdk`, pinned to the exact
reviewed `1.0.1` release. Its exported types do not replace validation against
the tagged protocol definition. gRPC, JSON-RPC, push-notification webhooks,
extended Agent Cards, Agent Card signing, and protocol extensions are deferred
until separately declared, implemented, and tested; the Agent Card must not
advertise a deferred capability.

Upgrades do not silently follow the repository's `main` branch or the
documentation site's `latest` alias. Each upgrade pins a reviewed A2A tag,
regenerates or refreshes conformance fixtures from that tag, records any wire
version change, and passes client/server interoperability tests before the
declared Agent Card version changes.

Required controls:

- disabled by default;
- loopback binding by default;
- explicit per-agent exposure;
- capability authentication and request-size limits;
- no filesystem paths or private transcript data in public agent metadata;
- correlation IDs across parent, child, workflow, and A2A tasks;
- cancellation and terminal-state mapping; and
- audit events for all inbound and outbound requests.

Internal workflows call `AgentTaskService` directly rather than making local
HTTP requests through A2A. This keeps the wire protocol at the system boundary.

## Routines and cron schedules

Routines are created under Agent Builder > Automation and operated from the
responsible agent's roster/inbox views. A routine targets one agent or one
deployed workflow.

```ts
interface RoutineDefinition {
  id: string;
  name: string;
  target: { kind: "agent" | "workflow"; id: string };
  prompt: string;
  cron: string;
  timezone: string;
  maxDurationMinutes: number;
  enabled: boolean;
}
```

The simple scheduler exposes:

- preset frequency for hourly, daily, weekdays, and weekly schedules;
- start time;
- maximum run duration; and
- timezone.

It generates and previews a standard five-field cron expression. Advanced mode
allows direct cron editing using the same validator. The next three run times
are shown before save. A three-dot menu provides Run now, Pause/Resume, and
Duplicate; selecting the routine provides Edit and Delete.

Cron controls start time; `maxDurationMinutes` bounds task execution and is not
encoded into cron. Missed schedules after host downtime are recorded as missed
events rather than replayed in a burst. A routine never overlaps its own active
task unless explicitly configured in a later concurrency design.

The interval-based routine schema is replaced rather than maintained as a
second scheduling mode.

## Storage

```text
~/.pi/agent/serve/
  definitions/<agent-id>.json
  conversations/<conversation-id>/conversation.json
  conversations/<conversation-id>/messages.jsonl
  tasks/<agent-id>/<task-id>/task.json
  tasks/<agent-id>/<task-id>/events.jsonl
  tasks/<agent-id>/<task-id>/attempts/<attempt-id>/transcript.json
  tasks/<agent-id>/<task-id>/artifacts/
  workflows/definitions/<workflow-id>.json
  workflows/runs/<workflow-run-id>/run.json
  routines/<routine-id>.json
```

Writes that replace state use temporary files plus atomic rename. Append-only
events use validated records and recover an interrupted active task as failed
on startup. All artifact and workspace paths are resolved beneath their owned
roots before access.

## API and event surface

The browser uses authenticated HTTP for snapshots and commands, the Pi protocol
WebSocket for live Pi state, and authenticated Server-Sent Events for registry
and task changes. Implemented event families are:

```text
agent.created | agent.updated | agent.removed
task.queued | task.started | task.completed | task.failed | task.cancelled
```

Events contain IDs and bounded summaries. Large outputs and artifacts are
retrieved through authenticated resource endpoints.

## Security invariants

- The active Pi session retains exactly one writer.
- Registry, task, workflow, routine, and artifact mutations require the serve
  capability token.
- Project roots, workspaces, persona images, and artifacts are path validated.
- Agent tools and delegation targets are allowlists.
- Plugin installation and permission expansion require explicit approval.
- Connection credentials never enter agent definitions, transcripts, task
  events, browser snapshots, or A2A metadata.
- A2A exposure is opt-in per agent and does not inherit browser-console access.
- Supervisor status access does not imply child transcript or credential access.
- One task lease protects each mutating project root by default.
- Cancellation waits for executor cleanup before releasing the lease.
- Secrets are referenced through configured providers and never copied into
  definitions, messages, events, or A2A metadata.

## Implementation plan

### Slice 1: consolidated workspace navigation

- Rename Preview to Browser.
- Place the persistent Agents roster below Sessions in the left pane.
- Use the center for the selected session or agent inbox.
- Use the right drawer for Browser, Workflow/Attention, and requested Builder
  configuration.
- Remove separate Routines and Capabilities top-level tabs.
- Keep Agent Builder conversational and add its structured internal sections
  to the drawer.
- Move existing run and routine history into the selected-agent inbox view.

### Slice 2: personas and registry operations

- Add `PersonaCatalog` and authenticated image delivery.
- Add visual persona selection and custom-persona fallback.
- Add registry events and the supported Pi `agent_deploy` operation.
- Refresh Agents immediately after either Pi or Agent Builder deploys one.

### Slice 2A: plugins and capability grants

- Project Pi's configured built-in, extension, and custom tool catalog into
  Agent Builder.
- Add compact plugin and connection cards with icons, tool counts, health, and
  expandable per-agent grants.
- Add validated install, configure, authenticate, update, and grant operations.
- Require explicit confirmation for plugin installation, update, and removal;
  keep connector authentication in its secure handoff.
- Keep installed plugin state separate from per-agent tool grants and prevent
  harness agents from selecting tools their confined executor cannot provide.

### Slice 3: persistent agent chat

- Add conversation, message, task, event, and attempt persistence.
- Adapt the existing executors behind `AgentTaskService`.
- Replace isolated-run submission with selected-agent chat.
- Preserve stop, result, transcript, and artifact behavior.

### Slice 4: cron automation

- Replace interval schedules with validated cron definitions.
- Add preset schedule controls, advanced cron, timezone, timeout, previews, and
  three-dot actions.
- Route scheduled work through `AgentTaskService` and display it under Agents.

### Slice 5: workflows

- Add workflow registry and validation.
- Implement sequential and parallel execution.
- Implement supervisor delegation, bounded revision, progress events, and final
  reporting.
- Add workflow configuration to Agent Builder and monitoring to Agents.

### Slice 6: A2A boundary

- Pin the official A2A `v1.0.1` protocol definition and reviewed
  `@a2a-js/sdk` version.
- Add per-agent Agent Cards and an authenticated `HTTP+JSON` 1.0 adapter.
- Map message send/stream, task get/list/subscribe/cancel, ordered SSE events,
  states, artifacts, errors, and correlation IDs.
- Add version-negotiation, policy, malformed-request, task-state, and
  information-disclosure tests against the tagged protocol contract.

### Slice 7: hardening and documentation

- Add restart recovery, concurrency, cancellation, path, and event-order tests.
- Validate localhost and explicit LAN behavior.
- Update operator documentation and complete browser-based workflow testing.

## Acceptance criteria

- The left pane owns Sessions and Agents; the center owns the selected
  conversation; the right drawer owns Browser, Workflow/Attention, and
  requested Builder configuration.
- An agent deployed by Pi or Agent Builder appears in the Agents roster without restart.
- Selecting an agent opens a durable chat; sending a message creates a visible
  task and streams progress through completion.
- Persona cards use the configured Personas catalog image and compiled
  instructions, while custom personas remain supported.
- Plugin cards distinguish installation, connection, tool, and per-agent grant
  state; installing a plugin never grants it to every agent implicitly.
- A chat may recommend a plugin or connection, but no install, authentication,
  removal, update, or permission expansion occurs without explicit approval.
- Pi-created and Builder-created agents use the same validated registry.
- Manual chat, cron, workflow, Pi, and A2A requests use the same task records,
  executor leases, events, results, and artifacts.
- A routine created with simple controls produces a valid cron expression and
  shows accurate next-run previews in its configured timezone.
- Sequential, parallel, and supervisor workflows preserve parent/child
  correlation and produce one final user-visible result.
- Exposed Agent Cards and HTTP operations conform to the official A2A v1.0.1
  definitions while declaring wire protocol `1.0`; unsupported or deferred
  transports and capabilities are not advertised.
- Disabled or unauthorized A2A requests cannot enumerate or invoke agents.
- Restart recovery preserves completed conversations, task history, routine
  definitions, workflow state, and artifacts.
- Focused registry, persona, task, cron, workflow, A2A, serve-page, and browser
  tests pass together with `npm run check`.

## Deliberate non-goals for the first implementation

- Arbitrary cyclic or dynamically self-modifying workflow graphs.
- Unbounded recursive agent delegation.
- Implicit sharing of full transcripts, private memory, or credentials.
- Multi-user permissions or cloud control-plane hosting.
- A general distributed scheduler or guaranteed replay of missed schedules.
- OS-level isolation for the existing local harness executor.
