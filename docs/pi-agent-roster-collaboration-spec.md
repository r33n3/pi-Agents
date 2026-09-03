# Pi agent roster and collaboration specification

## Status

Implementation contract for the persistent agent roster, agent inboxes,
task-backed agent-to-agent delivery, and bounded collaboration rooms in
`pi --serve`.

This document refines the
[agent workspace specification](pi-agent-workspace-spec.md),
[durable work and attention specification](pi-durable-work-attention-spec.md),
and
[agent lifecycle hardening specification](pi-agent-lifecycle-hardening-spec.md).
Those specifications remain authoritative for definitions, tasks, attempts,
runs, approvals, routines, workflows, and artifacts.

Implementation is divided into separately reviewed goals by the
[agent collaboration implementation roadmap](pi-agent-collaboration-goals.md).
This document defines the complete architecture; it does not authorize treating
all sections as one implementation batch.

## Reference baseline

The product behavior is informed by the official
[Hermes Bot Mode documentation](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode),
reviewed on 2026-09-01. The corresponding Hermes repository `main` revision at
review time was `5fae0d243f98a81e49663d4c48b2ed871b9a14c2`.

Hermes is design evidence, not a runtime or source dependency. ForkPI does not
adopt Hermes profiles, gateways, Desktop relay, credential layout, or approval
model. A future comparison must record its own reviewed revision rather than
silently assuming current Hermes behavior.

## Goal

Make deployed ForkPI agents feel like persistent teammates while preserving
the existing execution and security boundaries:

```text
find agent -> send goal -> receive durable task receipt -> follow progress
           -> continue, retry, schedule, or delegate from the same inbox
```

An agent remains an `AgentDefinition`. Its inbox is a stable conversation
surface. Every unit of work remains an `AgentTask`, and every execution remains
an immutable run attempt. Collaboration adds routing and presentation; it does
not add another job queue, chat runtime, scheduler, or authority store.

## Existing behavior that remains authoritative

- `AgentRegistry` owns durable agent identity and configuration revisions.
- `AgentTaskService` owns conversations, tasks, attempts, events, results,
  attention, and artifacts.
- `AgentRunManager` owns live run authority and immutable run snapshots.
- `WorkflowService` owns multi-agent execution graphs.
- `AgentRoutineScheduler` owns scheduled task admission.
- `CapabilityBroker`, `CapabilityApprovalService`, and
  `GovernedActionService` own grants, exact approvals, live authority, audit,
  credentials, and consequential effects.
- Agent delegation remains constrained by `delegateAgentIds`, workflow limits,
  workspace leases, capability grants, and permission policy.
- The proof, acceptance, skill-promotion, and schedule-confirmation lifecycle
  is unchanged.
- The left pane owns Sessions and the persistent Agents roster. The center owns
  the selected session or agent inbox. The right drawer provides Browser,
  Workflow and Attention assistance, plus Agent Builder configuration when the
  user requests it. Collaboration does not add another top-level destination.

## Design principles

1. Reuse agent, conversation, task, attempt, workflow, and routine primitives.
2. Keep durable identity separate from presentation, conversation, and work.
3. Admit every delivery exactly once before starting recipient work.
4. Generate sender attribution from trusted runtime identity.
5. Transfer bounded results and references, not private transcripts or secrets.
6. Keep the relationship persistent while execution context stays explicit and
   versioned.
7. Derive presence, unread state, and delivery status from authoritative events.
8. Bound every collaborative loop by membership, depth, messages, cost, and
   time.
9. Treat remote federation as a protocol boundary, not a local UI shortcut.

## Reference pattern decisions

| Hermes Bot Mode pattern | ForkPI decision | ForkPI mapping |
| --- | --- | --- |
| Bot Mode is a view over an existing profile primitive | Adopt the intent | The Agents workspace remains a view over `AgentDefinition`, conversations, tasks, workflows, and routines. |
| Stable roster and canonical Bot Chat | Adapt | Add explicit agent inbox identity without making conversation history the execution context. |
| Active-now strip, search, hide, and unread state | Adopt | Store display-only metadata and derive activity from task events. |
| Routines beside the responsible Bot | Adopt | Project scheduler-owned routines and their task receipts into the target agent inbox. |
| Typed `message_agent` delivery with host attribution | Adapt | Admit an idempotent task envelope through `AgentCollaborationService`. |
| Typed delivery failure reasons | Adopt | Extend safe task errors with stable delivery codes. |
| At-most-once transient retry | Adapt | Retry only before observable work starts; require explicit retry otherwise. |
| Bounded group rounds and message caps | Adopt with stronger task evidence | Execute validated room turns through ordinary workflow tasks and immutable attempts. |
| One profile owns config, secrets, memory, sessions, and routines | Reject | Preserve separate registry, credential, conversation, task, approval, and scheduler owners. |
| Shared profile credential pool implies Bot access | Reject | Every recipient resolves its own grants, account references, approvals, and live authority. |
| Desktop relay and gateway peers | Defer | Use the A2A boundary only after remote identity and replay controls are specified. |

## Design alternatives

### Alternative A: make each agent a complete profile directory

A profile would contain configuration, model settings, credentials, memory,
skills, conversations, routines, and runtime state. The roster could launch a
profile directly.

This is convenient for whole-agent export, but it makes a profile appear to be
a security boundary when it is only a storage boundary. It also couples secret
placement, runtime state, deployment configuration, and conversation history.

### Alternative B: add a Bot runtime beside agents and tasks

A new service would own Bot identities, canonical chats, direct messages,
groups, retries, and schedules. This makes Bot Mode internally self-contained,
but creates two meanings for agent identity, conversations, work, and routines.

### Alternative C: add a collaboration facade over existing services

One `AgentCollaborationService` resolves roster identity, validates delivery,
builds a bounded envelope, and submits work through `AgentTaskService` or
`WorkflowService`. The browser renders projections of the resulting events.

**Decision:** use Alternative C. It gives ForkPI the persistent-teammate
experience while keeping lifecycle and security authority in existing deep
modules.

## Chosen architecture

```text
ServeHost
  ├─ AgentRegistry
  ├─ AgentPresentationStore
  ├─ AgentRosterProjection
  │    ├─ consumes registry, presentation, task, conversation, attention,
  │    │  and routine events
  │    └─ owns roster revision and safe roster snapshots
  ├─ AgentCollaborationService
  │    ├─ resolves AgentRegistry identities and delegate allowlists
  │    ├─ admits idempotent AgentDeliveryEnvelope records
  │    ├─ submits recipient work to AgentTaskService
  │    └─ projects delivery receipts from task events
  ├─ AgentTaskService
  │    ├─ explicit agent-inbox conversations
  │    ├─ task and attempt history
  │    └─ durable event stream and Attention
  ├─ AgentRoomService
  │    ├─ room definitions and presentation transcript
  │    └─ bounded rounds executed through WorkflowService
  ├─ WorkflowService
  └─ AgentRoutineScheduler
```

`AgentCollaborationService` is a facade, not a store of executable state.
`AgentPresentationStore` owns only display preferences. Room definitions own
membership and round limits, while room member work remains ordinary tasks.
`AgentRosterProjection` is the only owner of roster revision; source services
publish their existing domain events and do not increment a shared counter.

## Identity and vocabulary

- **Agent**: one stable `AgentDefinition.id` with revisioned configuration.
- **Handle**: a user-facing label used for autocomplete. It resolves to an
  agent ID at admission and is never persisted as execution identity.
- **Agent inbox**: the one stable direct conversation for an agent.
- **Task conversation**: an optional conversation scoped to a workflow,
  temporary specialist, imported request, or other isolated context.
- **Delivery**: one admitted request from a trusted sender to a recipient
  agent. It always maps to one durable task.
- **Receipt**: a safe projection of the recipient task state.
- **Room**: user-owned membership and presentation state for bounded group
  coordination.
- **Round**: one room orchestration pass that creates ordinary member tasks.

Display names may repeat. Agent IDs may not. The browser sends the selected
agent ID from autocomplete rather than asking the server to infer identity from
display text. Text-only callers may use a unique current handle or the exact
agent ID; ambiguous handles fail with candidates and perform no delivery.

Renaming an agent changes its label and current handle. Historical messages,
receipts, and task contracts continue to identify the immutable agent ID.

## Agent presentation and roster

Presentation state is separate from `AgentDefinition`, so hiding or pinning an
agent does not increment its executable revision or invalidate proof.

```ts
interface AgentPresentationMetadata {
  version: 1;
  agentId: string;
  pinnedOrder?: number;
  hidden: boolean;
  lastReadConversationSequence: number;
  updatedAt: number;
}

interface AgentRosterEntry {
  agentId: string;
  agentRevision: number;
  name: string;
  description: string;
  image?: AgentImageRef;
  inboxConversationId: string;
  status: "needs-attention" | "active" | "queued" | "idle" | "unavailable";
  currentTask?: { id: string; summary: string; status: AgentTaskStatus };
  latestMessage?: { sequence: number; preview: string; createdAt: number };
  activeUntil?: number;
  unreadCount: number;
  hidden: boolean;
  routines: { enabled: number; nextRunAt?: number };
}
```

The roster snapshot has a monotonically increasing `rosterRevision` owned by
`AgentRosterProjection`. Registry, presentation, task, conversation, attention,
and routine events invalidate and rebuild affected entries through that one
owner. Clients discard responses older than the last applied revision.

Status precedence is `needs-attention`, `active`, `queued`, `unavailable`, then
`idle`. Presence is derived from active tasks and durable task events. A
separate “Active now” strip may include agents with an active task or a
persisted activity event whose derived `activeUntil` is still in the future,
but it never reorders the main roster. Clients expire `activeUntil` locally;
the server does not persist timer-only events merely to remove an agent from
the strip.

Hiding is display-only. It does not stop work, disable routines, change room
membership, revoke grants, or suppress approvals, questions, and failures from
Attention. It may suppress routine-completion toast notifications. Unread
activity continues accumulating and is visible when hidden agents are shown.

## Explicit agent inboxes

### Problem

The current conversation index selects the most recently updated conversation
for an agent. A workflow conversation can therefore become the apparent direct
chat. A permanent agent surface needs an explicit identity rather than a
recency heuristic.

### Contract

Extend conversations to a versioned kind:

```ts
type AgentConversationKind = "agent-inbox" | "task" | "room";

interface AgentConversation {
  version: 2;
  id: string;
  kind: AgentConversationKind;
  agentId?: string;
  roomId?: string;
  contextEpoch: number;
  nextMessageSequence: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

interface AgentConversationMessage {
  version: 2;
  id: string;
  sequence: number;
  conversationId: string;
  author:
    | { kind: "user"; id: "local-user" }
    | { kind: "pi"; sessionId: string }
    | { kind: "agent"; agentId: string; agentRevision: number }
    | { kind: "routine"; routineId: string; revision: number }
    | { kind: "system" };
  kind: "message" | "task-result" | "delivery" | "room-turn" | "context-checkpoint";
  text?: string;
  taskId?: string;
  deliveryId?: string;
  artifactIds?: string[];
  contextEpoch: number;
  createdAt: number;
}
```

Exactly one non-archived `agent-inbox` conversation exists per deployed agent.
`ensureConversation(agentId)` becomes `ensureAgentInbox(agentId)` and uses the
explicit kind. Workflows and temporary specialists call
`createTaskConversation(agentId)` and can never replace the inbox mapping.

Messages receive a sequence number inside the conversation's serialized write
queue. The server appends the message before broadcasting it. Browser reconnect
requests messages after its last sequence.

### Persistent relationship and bounded execution context

The inbox is a durable presentation history, not an ever-growing model prompt.
For every task admission, the server builds and snapshots an
`AgentContextPackage` containing:

- the current context epoch;
- the current accepted summary, when one exists;
- a bounded number and size of user and final-agent messages from that epoch;
- explicitly referenced task results and artifacts; and
- the new goal.

```ts
interface AgentContextPackage {
  version: 1;
  conversationId: string;
  contextEpoch: number;
  summary?: { id: string; digest: string; text: string };
  messages: Array<{
    sequence: number;
    author: AgentConversationMessage["author"];
    text: string;
  }>;
  references: Array<{
    kind: "task-result" | "artifact" | "message";
    id: string;
    version?: string;
    digest: string;
  }>;
  goal: string;
  digest: string;
}
```

Canonical serialization produces the package digest. The exact package and
digest are part of the task contract and immutable run snapshot. Artifact
references resolve to an exact version before the package is persisted.

Tool activity, hidden reasoning, raw child transcripts, credentials, approval
receipts, and unrelated room history are excluded.

`New context` increments `contextEpoch` and appends a host-authored checkpoint.
Prior messages remain inspectable but are excluded from later context packages.
`Compact context` creates a candidate summary from visible messages, shows it
for review when it would alter standing context, then stores it as a versioned
summary bound to the epoch. Compaction never rewrites messages or attempt
evidence.

This preserves a recognizable long-term relationship without allowing an old
conversation to silently change a later run snapshot.

### Queued task configuration

#### Problem

A task may remain queued while its agent definition changes. Recording revision
4 in the task contract and later executing revision 5 would make admission and
delivery receipts inaccurate.

#### Contract

Use one shared non-secret execution configuration type for all newly admitted
tasks, including direct chat, delivery, routine, workflow, and room tasks:

```ts
type AgentTaskExecutionSeed = AgentExecutionConfigurationSeed;
```

`AgentTaskService` resolves and persists this seed with the task contract before
the task becomes visible to its scheduler. The lifecycle specification's single
configuration-snapshot builder creates the seed. `AgentRunManager` creates each
attempt snapshot from that exact seed and adds only attempt-specific identity.
It does not duplicate canonicalization or reload the latest agent definition
for a queued task.

An ordinary agent edit affects tasks admitted afterward. Explicit retry reuses
the task's seed and appends an attempt. `Retry with current agent` is a separate
operation that creates a new task and context contract after review. Provider
account, credential, grant, and owner revocation still applies immediately at
effect time; a seed is reproducible configuration, not retained authority.

Legacy tasks without a seed use their existing compatibility adapter. They may
be inspected and retried only under the durable-work migration rules; missing
fields are never guessed.

## Durable agent-to-agent delivery

### Admission contract

```ts
type AgentDeliverySender =
  | { kind: "user"; id: "local-user"; sessionId: string }
  | { kind: "pi"; sessionId: string }
  | { kind: "agent"; agentId: string; taskId: string; attemptId: string }
  | { kind: "routine"; routineId: string; revision: number }
  | { kind: "workflow"; workflowRunId: string; nodeId: string }
  | { kind: "a2a"; principalId: string; requestId: string };

type AgentDeliveryContextRef =
  | { kind: "task-result"; taskId: string }
  | { kind: "artifact"; artifactId: string; versionId?: string }
  | { kind: "message"; conversationId: string; sequence: number };

interface SubmitAgentDelivery {
  idempotencyKey: string;
  recipientAgentId: string;
  goal: string;
  contextRefs: AgentDeliveryContextRef[];
  expectedDeliverable?: DeliverableExpectation;
}

interface AgentDeliveryEnvelope {
  version: 1;
  id: string;
  idempotencyScope: string;
  idempotencyKey: string;
  sender: AgentDeliverySender;
  recipientAgentId: string;
  recipientRevision: number;
  conversationId: string;
  taskId: string;
  parentTaskId?: string;
  goal: string;
  contextRefs: AgentDeliveryContextRef[];
  expectedDeliverable?: DeliverableExpectation;
  createdAt: number;
}
```

The authenticated host derives `sender`, `idempotencyScope`, parent task,
attempt, and session identity. Browser and model callers cannot supply or
override those fields. The server validates the recipient and all context
references. One `AgentTaskService` admission call creates the execution seed,
copies its revision into the envelope, persists both in the recipient task
contract, and only then queues the task. The envelope and execution seed cannot
describe different recipient revisions.

An idempotency key is unique inside the derived sender scope. Repeating the
same key and identical canonical request returns the original delivery and
task. Repeating the key with different content fails as a conflict. Admission
persists no second message, task, or attempt.

The server resolves omitted artifact versions to an exact immutable version,
normalizes the goal and expected-deliverable contract, and computes a canonical
request digest before consulting the idempotency index. The digest covers the
recipient ID, resolved context references, goal, and deliverable. Caller object
key order does not affect it.

The goal is limited to 16 KiB of UTF-8 text. A delivery accepts at most 16
context references and 32 artifact references after expansion. Each referenced
message or result is resolved by the host and copied into the run's bounded
context snapshot. Absolute source paths, secret values, raw transcripts, and
private conversation ranges are rejected.

### Admission durability

Delivery admission is serialized per idempotency scope. It uses recoverable,
idempotent writes rather than claiming a multi-file transaction:

1. Resolve and canonicalize the request, then check the rebuilt idempotency
   index.
2. Allocate delivery and task IDs and atomically persist one queued task whose
   contract contains the complete envelope.
3. Append the recipient inbox message with deterministic ID
   `delivery:<delivery-id>:request` if that ID is absent.
4. Append the initial task event with deterministic ID
   `delivery:<delivery-id>:queued` if that ID is absent.
5. Update the rebuildable delivery index.
6. Expose the receipt and allow the scheduler to start the task.

The scheduler cannot observe the task until steps 2 through 4 complete during
normal admission. On restart, collaboration recovery scans queued delivery
tasks before task scheduling, completes any missing deterministic message or
event append, rebuilds the index, and then opens the listener. Exclusive
serve-directory ownership prevents another host from racing this recovery.

Conversation and task event stores therefore need append-if-absent operations
keyed by record ID. They retain append-only file order and reject an existing
ID with different canonical content.

### Authorization

An agent-originated delivery is allowed only when:

1. its source attempt is the caller's current live `AgentRunManager` authority;
2. the source task and attempt identities agree;
3. the recipient appears in the source run snapshot's `delegateAgentIds`;
4. delegation depth, fan-out, task, token, cost, and time limits remain;
5. referenced tasks, artifacts, and messages are readable by the source task;
6. the recipient is deployed and available; and
7. the recipient admission snapshot resolves its workspace, model, grants, and
   provider bindings successfully.

The recipient receives its own run authority, capability grants, approvals,
workspace lease, and immutable configuration snapshot. Parent credentials,
approvals, browser control, environment, and private transcript do not transfer.

User, Pi, routine, workflow, and A2A senders use their existing authorization
paths. Room membership authorizes participation only in that room and does not
add a direct `delegateAgentIds` grant.

### Execution and receipt

The delivery task is submitted with source `agent` for agent-originated direct
delivery and includes the envelope in `AgentTaskContractSnapshot`. Delivery
state is a projection of task events rather than a second mutable state machine:

```ts
interface AgentDeliveryReceipt {
  deliveryId: string;
  taskId: string;
  conversationId: string;
  recipientAgentId: string;
  status: AgentTaskStatus;
  latestEventSequence: number;
  resultSummary?: string;
  artifactIds: string[];
  error?: SafeTaskError;
}
```

A concrete trace is:

```text
researcher run calls delegate_agent(reviewer, goal, key=tool-call-42)
  -> host derives researcher task and attempt identity
  -> allowlist and limits pass
  -> envelope and reviewer task persist
  -> attributed delivery message appends to reviewer inbox
  -> tool returns deliveryId and taskId immediately
  -> reviewer runs under its own snapshot and authority
  -> completion appends a task-result reference to reviewer inbox
  -> researcher receives a delivery-completed event with bounded result data
```

The source may finish before the recipient. Completion still persists. When
the sender owns a conversation, the host appends a bounded delivery-result
reference there; other senders use Attention and their existing result path.
The completion does not automatically start another source-agent turn.
Coordinated work that must consume a child result in the same goal uses
`WorkflowService`; direct delivery remains asynchronous. Cancelling a source
task requests cancellation of its still-active direct children before the
source releases its workspace lease. A child whose provider outcome is unknown
follows the existing reconciliation path and is never blindly retried.

### Host tools

Only active agent attempts with declared delegates receive these host tools:

- `delegate_agent` — admit one delivery and return its receipt identity;
- `inspect_delegation` — read bounded status, final result, and artifacts for a
  child admitted by the current task; and
- `cancel_delegation` — request cancellation of that child.

The tool schemas accept agent IDs, goals, references, and idempotency keys.
They do not accept sender identity, grant state, approval IDs, credentials,
workspace paths, or arbitrary task IDs. Tool calls use real typed parameters;
no value is passed through a shell command.

### Retry and failure classification

Failures use stable codes:

```ts
type AgentDeliveryFailureCode =
  | "recipient_unavailable"
  | "recipient_busy"
  | "delegation_not_allowed"
  | "delegation_depth_exceeded"
  | "budget_exhausted"
  | "model_unavailable"
  | "provider_auth_or_access"
  | "provider_quota_limit"
  | "provider_rate_limit"
  | "provider_server_error"
  | "context_overflow"
  | "approval_required"
  | "cancelled"
  | "outcome_unknown"
  | "invalid_request"
  | "internal";
```

Human text is safe and bounded; callers branch on the code. Automatic retry is
permitted at most once and only when admission did not create an attempt or the
attempt proves that no model call, tool call, or external effect started.
Provider errors after work begins, context overflow, authentication, quota,
approval, cancellation, and outcome-unknown failures require explicit retry or
input. Explicit retry retains the task and envelope, appends a new immutable
attempt, and records the retrying actor and reason.

## Collaboration rooms

Rooms are implemented after direct delivery. A room is useful for deliberate
comparison or review, but it must not become an open-ended autonomous chat.

```ts
interface AgentRoomDefinition {
  version: 1;
  id: string;
  name: string;
  purpose: string;
  members: Array<{ agentId: string; role: string }>;
  limits: {
    maxRounds: number;
    maxMessages: number;
    maxConcurrency: number;
    maxDurationMs: number;
    maxTotalTokens: number;
    maxCostUsd: number;
  };
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

interface AgentRoomRound {
  id: string;
  workflowRunId: string;
  status: "completed" | "needs-user" | "failed" | "cancelled";
  number: number;
  turns: Array<{
    memberIndex: number;
    agentId: string;
    taskId?: string;
    status: "reply" | "pass" | "needs-user" | "failed" | "cancelled";
    message: string;
    requestAgentIds?: string[]; // Absent only on retained evidence from before this contract.
    totalTokens: number;
    costUsd: number;
  }>;
  startedAt: number;
  finishedAt: number;
}

interface AgentRoomRun {
  version: 1;
  id: string;
  roomId: string;
  status: "running" | "completed" | "needs-user" | "bounded" | "failed" | "cancelled";
  goal: string;
  rounds: AgentRoomRound[];
  workflowRunIds: string[];
  taskIds: string[];
  messageCount: number;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
  deadlineAt: number;
  finishedAt?: number;
}
```

Defaults and hard limits are:

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| Members | 2–8 | 8 |
| Rounds | 3 | 6 |
| Total room messages | 48 | 96 |
| Concurrent member turns | 3 | 4 |
| Duration | 10 minutes | 30 minutes |
| Total tokens | 200,000 | 500,000 |
| Estimated cost | $20 | $100 |

A user message with explicit mentions selects those members; a message without
mentions selects all members. Each round snapshots the visible room transcript
and starts eligible member tasks through a generated, non-deployed
`WorkflowService` run. Add one trusted-host-only `startAdHoc` workflow entry
point that runs the existing validated graph executor, records room provenance,
and persists the generated definition snapshot and digest with the run. It does
not add the generated definition to the deployable workflow registry. Member
turns within a round may execute concurrently. Their result order in the room
is the definition's stable member order, not completion timing.

Each member returns this validated result contract:

```ts
interface AgentRoomTurnResult {
  outcome: "reply" | "pass" | "needs-user";
  message: string;
  requestAgentIds: string[];
}
```

Every saved member participates in each round. `requestAgentIds` must be a
unique list of saved room member IDs, including the sender when it needs another
turn. An empty list explicitly requests no follow-up; missing or invalid lists
fail the output contract. Requests do not grant delegation authority or limit
the next round to only the named members. The next full-room round receives
both prior messages and their requested member IDs.

A run completes after a successful round when all request lists are empty,
regardless of whether members returned `reply` or `pass`. For example, a final
research finding plus a reviewer pass completes in one round if neither requests
follow-up. Concurrent members cannot see current-round peer output; a reviewer
that still needs new evidence must explicitly request a follow-up rather than
claiming to have reviewed unseen work.

The run pauses when user input is needed, fails when a turn is invalid, and
stops at configured safety bounds. Round and message limits block further work
when continuation is requested; an otherwise successful final round does not
need an extra all-pass round. Token, cost, and duration safety checks remain in
force. Reaching a bound finishes with a visible neutral `bounded` / "limit
reached" state and the limit reason, not failed-task styling. It does not
silently continue or discard useful evidence. Existing run history is retained
without inventing continuation requests for old turns.

Room turns use task conversations and their own immutable run snapshots. They
do not modify or inject messages into a member's direct inbox. The room
transcript stores user messages, validated member messages, passes, task
references, and final status. Raw member transcripts remain private task
evidence.

The room service owns membership and transcript projection. Workflow and task
services remain execution authorities. Room deletion archives the definition
and presentation transcript; referenced tasks, attempts, artifacts, approvals,
and audit evidence follow their normal retention rules.

## Routines and agent inboxes

Routines remain definitions owned by the scheduler. The Agents workspace shows
an agent's routines beside its inbox, next run, enabled state, and recent run
receipts.

Each invocation creates a new task with the saved routine revision and an
independent attempt snapshot. Its completion appends a `task-result` message to
the target agent inbox and creates Attention according to the durable-work
rules. A follow-up from that result creates a chat task; it does not edit the
routine. `Update routine from this result` is an explicit reviewed action.

Hiding an agent does not pause its routines. Archiving an agent requires its
routines to be paused or retargeted first.

## User experience

### Agents roster and inbox workspace

The persistent Agents roster below Sessions gains:

- a stable, searchable roster;
- an optional Active now strip;
- pinned and hidden presentation controls;
- unread and needs-attention indicators;
- current task summary and stop action;
- routine status beside the owning agent;
- direct task and artifact history; and
- room rows after room delivery is implemented.

Selecting an agent focuses its existing inbox conversation in the center. It
does not create another conversation, replace the underlying Pi session, or
move execution authority into the browser. Closing the view hides it without
stopping work. Workflow, Attention, approvals, and browser assistance remain in
the right drawer and can open over the conversation without requiring the user
to scroll chat history.

The roster keeps explicit user ordering. Activity may appear in the Active now
strip but does not reorder the roster. Search matches current name,
description, and exact agent ID. Hidden agents appear dimmed only while the
show-hidden control is active.

### Agent inbox header

The header shows image, name, description, model route, current status, unread
state, and compact actions:

- edit in Agent Builder;
- run a task;
- new context;
- compact context;
- routine management;
- duplicate; and
- archive.

Runtime details, grants, IDs, and diagnostics remain in disclosures. Stop is
visible only for current work. Red remains reserved for stop, errors, and
destructive confirmation.

### Creation and duplication

`Agents +` opens the existing compact Agent Builder path. It does not bypass
definition validation, capability review, proof, or automation gates. A
successful deployment calls `ensureAgentInbox` idempotently and focuses that
inbox. The UI uses the agent description as empty-state context rather than
spending a model call on an automatic introductory message.

Duplicate creates a Builder draft containing reviewed presentation,
instructions, model choice, and capability selections. It does not copy:

- conversation history or context summaries;
- task, run, workflow, or room history;
- approvals or live authority;
- credential values or connected-account authorization;
- accepted proof, promoted-skill authority, or enabled routines; or
- presentation unread state.

Capability selections are re-resolved and shown for review before deployment.

### Notifications

Direct and room results use the existing Attention projection. Toasts are
optional transient views of persisted events. They are never the only record.
Approvals and questions take precedence over failures and completions. Hidden
agents cannot suppress security-relevant Attention items.

## Authenticated API and event surface

Routes are illustrative and may use established repository naming:

```text
GET  /api/agents/roster?afterRevision=<n>
POST /api/agents/:agentId/presentation
GET  /api/agents/:agentId/inbox/messages?after=<sequence>
POST /api/agents/:agentId/inbox/tasks
POST /api/agents/:agentId/inbox/context-checkpoints
POST /api/agent-deliveries
GET  /api/agent-deliveries/:deliveryId
POST /api/agent-deliveries/:deliveryId/cancel
GET  /agent-rooms.json
POST /agent-rooms
POST /agent-rooms/:roomId/run
GET  /agent-room-runs/:runId
POST /agent-room-runs/:runId/resume
POST /agent-room-runs/:runId/cancel
```

Mutation requests require the serve capability token, bounded TypeBox schemas,
and idempotency keys. The server derives actor and ownership fields. Responses
contain safe metadata only.

New event families are:

```text
roster.updated
conversation.message.appended
conversation.context.checkpointed
delivery.admitted
delivery.updated
room.created | room.updated | room.archived
room.round.started | room.turn.completed | room.round.completed
```

Events contain IDs, sequences, safe summaries, and references. Full messages,
results, and artifacts are fetched through authenticated resource endpoints.
Reconnect uses persisted sequence numbers and never resubmits a task.

## Storage

Extend existing serve storage:

```text
~/.pi/agent/serve/
  conversations/<conversation-id>/conversation.json
  conversations/<conversation-id>/messages.jsonl
  conversations/<conversation-id>/summaries/<summary-id>.json
  tasks/<agent-id>/<task-id>/task.json
  tasks/<agent-id>/<task-id>/events.jsonl
  presentation/agents.json
  collaboration/delivery-index.json
  rooms/definitions/<room-id>.json
  rooms/runs/<run-id>/run.json
```

Delivery envelopes live in task contract snapshots. `delivery-index.json` is a
rebuildable idempotency and lookup projection, not authoritative state. Room
round records contain workflow and task references rather than copies of task
state. Presentation and room definition replacements use temporary files plus
atomic rename. Message and task events are append-only and sequence validated.

## Security and privacy

- Direct delivery requires a live source run and its snapshotted delegate
  allowlist.
- Sender attribution is host-generated and cannot be supplied in message text.
- Recipient tools come only from the recipient's immutable run snapshot.
- Parent approvals, credentials, session authority, browser ownership, and
  environment never transfer to a child.
- Context references are access checked, bounded, and resolved by the host.
- Private inbox or room history is never copied wholesale into another task.
- Agent-delivered text is untrusted input and is delimited and attributed in
  recipient context.
- Exact action approvals remain bound to the recipient attempt and canonical
  effect.
- Cancellation invalidates live authority before child cleanup and lease
  release.
- Duplicate delivery admission is prevented before task creation.
- Hidden, muted, or archived presentation state never hides pending approvals,
  questions, failures, or audit evidence.
- Room membership grants no tool, account, workspace, direct-delegation, or A2A
  permission.
- Agent and room previews are redacted and bounded before client delivery.
- Remote peers never receive the serve capability token or provider secrets.

## Failure and recovery behavior

- Invalid or ambiguous recipient: reject before persistence.
- Duplicate key with changed content: return conflict and preserve the original
  delivery.
- Failure after envelope persistence but before queue admission: recovery finds
  the task contract and completes admission exactly once.
- Source authority ends during admission: reject or cancel before recipient
  execution starts.
- Recipient startup fails: retain the task and typed failure receipt.
- Source task finishes first: recipient continues and completion remains
  discoverable.
- Source task is cancelled: request cancellation of active direct children and
  preserve their terminal or outcome-unknown state.
- Serve host restarts: rebuild inbox, roster, delivery, unread, and room
  projections from definitions, conversations, tasks, events, and room
  definitions.
- Corrupt projection: ignore and rebuild it; never infer completed external
  effects from presentation state.
- Deleted or archived agent: historical messages and task evidence remain
  readable; no new task is admitted.

## Migration

Conversation schema version 1 lacks an explicit kind and sequence. Migration
is restartable and idempotent. Before rewriting records, the host persists a
migration generation containing the complete validated conversation set and a
completed-record ledger. Collaboration mutations and the network listener stay
closed until that generation commits:

1. Load all legacy conversations and linked tasks without modifying them.
2. For each deployed agent, select the newest conversation containing a direct
   `chat` task as its inbox. If none exists, create an empty inbox.
3. Mark remaining agent conversations `task`; workflow-only conversations can
   never become the inbox.
4. Assign message sequences in existing file order and set `contextEpoch: 1`.
5. Persist each version 2 record through atomic replacement and record its ID in
   the migration ledger. A restart resumes missing IDs; loaders continue to
   understand untouched version 1 records during recovery.
6. Atomically mark the generation committed only after every expected record
   and link validates, then remove obsolete migration staging data.
7. Rebuild presentation unread counts and the delivery index from durable
   events.

If two legacy conversations are equally eligible, migration keeps the one
already returned by the prior index and records the decision. It does not merge
histories automatically. A migration failure leaves version 1 data intact and
prevents partial collaboration mutations. Partially converted files may exist
after a crash, but the uncommitted generation is not exposed and restart resumes
from its ledger rather than guessing migration state.

Existing tasks without delivery envelopes remain ordinary history. Existing
workflows and routines retain their definitions. No existing approval is
converted into delegation authority.

## Remote and cross-machine boundary

The first implementation is local to one `ServeHost` and its exclusively owned
serve directory. It does not copy Hermes Desktop relay or gateway peer
configuration.

External agents use the existing authenticated A2A adapter. A future federated
delivery design may map `AgentDeliveryEnvelope` to A2A task operations, but it
must separately define peer identity, trust, replay protection, TLS, key
rotation, availability, cancellation, and information disclosure. Local agents
must not route through HTTP merely to imitate remote delivery.

Cross-machine rooms are deferred until federated delivery provides durable
receipts and verified identities. The browser is never the sole courier or
room authority.

## Implementation sequence

The [agent collaboration implementation roadmap](pi-agent-collaboration-goals.md)
is authoritative for goal boundaries and review gates. Goal 2 contains these
delivery slices:

### Slice 1: explicit inbox identity and roster projection

- Add conversation version 2, kinds, sequences, and migration.
- Replace the most-recent-conversation heuristic with `ensureAgentInbox`.
- Add presentation metadata and roster revision projection.
- Add search, pin, hide, unread, current task, and Active now behavior.

### Slice 2: bounded task context

- Add context epochs, checkpoints, and reviewed summaries.
- Build and persist bounded context packages at task admission.
- Add the shared execution seed and construct attempt snapshots from it.
- Prevent queued tasks from silently switching agent revisions.
- Keep messages and attempt evidence immutable.
- Add New context and Compact context controls.

### Slice 3: durable direct delivery

- Add delivery schemas and `AgentCollaborationService`.
- Add idempotency admission and rebuildable delivery index.
- Extend task contract snapshots with delivery envelopes.
- Add typed failure codes and source completion events.

### Slice 4: agent delivery tools and lifecycle

- Add `delegate_agent`, `inspect_delegation`, and `cancel_delegation` as
  host-owned tools.
- Enforce live authority, allowlists, depth, fan-out, budget, and context access.
- Add child cancellation, explicit retry, restart recovery, and Attention.

### Slice 5: routine and inbox integration

- Show routines with their owning agent.
- Project scheduled task results into the stable inbox.
- Preserve saved routine revisions and explicit update-from-result behavior.

Bounded local rooms are Goal 3, not a Goal 2 slice:

### Goal 3: bounded local rooms

- Add room definitions, presentation transcripts, and validated turn results.
- Execute each round through generated WorkflowService runs and ordinary tasks.
- Enforce membership, round, message, concurrency, time, budget, and user
  escalation bounds.

Responsive UI and recovery validation are required in every affected slice,
not deferred until the end:

### Per-slice validation

- Validate desktop, resized-pane, phone, and unfolded Pixel Fold layouts.
- Validate reconnect during direct delivery and room rounds.
- Rebuild projections after simulated interruption and corruption.
- Run focused tests, `npm run check`, and authenticated `pi --serve` browser
  validation.

## Acceptance criteria

- Every deployed agent has exactly one explicit inbox across restart.
- A workflow or temporary-task conversation can never replace that inbox.
- Selecting an agent focuses the existing inbox without creating a task.
- Hiding or pinning an agent changes no executable agent revision.
- Hidden agents continue routines and still surface approvals and failures.
- Sending the same canonical delivery with the same scoped idempotency key
  creates exactly one recipient task.
- A changed request under the same idempotency key is rejected.
- Agent-originated delivery fails when source authority is inactive or the
  recipient is absent from the source snapshot's delegate allowlist.
- The recipient runs with its own model, workspace, grants, approvals, and
  immutable snapshot.
- Editing the recipient while a delivery is queued does not change that task's
  execution seed; a new task uses the new revision.
- No parent credential, approval, private transcript, or browser authority is
  transferred.
- Delivery completion remains inspectable after the source task finishes,
  browser disconnects, or the serve host restarts.
- Explicit retry appends an attempt and never repeats an outcome-unknown effect.
- New context excludes prior epochs without deleting their messages.
- Room execution creates ordinary correlated tasks, stops at its configured
  bounds, and cannot directly grant member-to-member delegation.
- Room passes and needs-user outcomes are represented explicitly rather than by
  parsing prose.
- Routines remain scheduler-owned definitions and their runs remain ordinary
  tasks visible from the target agent inbox.
- Remote federation is not enabled by local roster or room configuration.
- Focused conversation, task, collaboration, workflow, routine, serve-page,
  browser, migration, authority, and recovery tests pass with `npm run check`.

## Deliberate non-goals

- Replacing `AgentDefinition` with a profile directory.
- Treating an agent inbox as the execution or security boundary.
- Sharing credentials, operating-system home directories, or private memory
  between agents.
- A second queue, scheduler, run store, or workflow runtime.
- Unbounded autonomous conversations or recursive delegation.
- Automatically forwarding arbitrary user text to another agent without a
  durable attributed envelope.
- Parsing `@mentions` from model prose as authorization.
- Making room membership equivalent to direct delegation permission.
- A Desktop relay, peer key registry, distributed room store, or cross-machine
  presence service.
- Multi-user read state or notification preferences in the local serve profile.
- Copying Hermes source, avatars, visual treatment, or profile export format.
