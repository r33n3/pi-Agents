# Pi durable work and attention specification

## Status

Implementation contract for durable background work, run recovery, approvals,
and operator attention in `pi --serve`.

This specification refines the task, routine, and workflow behavior in
[the agent workspace specification](pi-agent-workspace-spec.md). It does not
create a second run model. Pi sessions, direct agent chat, routines, workflows,
delegated ACP work, browser work, and A2A requests all project onto the existing
`AgentTaskService` task and attempt model.

## Goal

Let a user describe work, leave the page, reconnect from another device, and
reliably find one of three outcomes:

- the work is still progressing;
- the work needs a specific decision or piece of information; or
- the result is complete and available as a conversation and, when applicable,
  an artifact.

The interface remains conversation-first. Durable execution must not turn the
chat into a process monitor or add a permanent diagnostic workspace.

## Product principles

1. **Runs outlive views.** Closing a tab, resizing a panel, losing a WebSocket,
   or refreshing a browser does not own or terminate work.
2. **One task, one identity.** A run keeps the same task ID across reconnects.
   Retry creates a new attempt under that task rather than a duplicate task.
3. **Attention is exceptional.** Only work requiring action, reporting a
   terminal problem, or delivering a meaningful result enters Attention.
4. **Conversation and execution stay linked.** A task belongs to a durable
   conversation, and a routine run creates a conversation that can be
   continued after completion.
5. **Details are available, not dominant.** Plans, tool calls, subagents,
   commands, and diagnostics are collapsed by default.
6. **Consequential actions are legible.** Approval cards explain the action,
   target, account, and consequence in plain language.
7. **Configuration is snapshotted.** Every attempt records the agent revision,
   model route, permission policy, grants, workspace, and schedule revision it
   actually used.

## Reference patterns

The behavior is informed by, but does not copy, two current product patterns:

- Claude Cowork keeps cloud tasks running independently of the open client,
  exposes progress and steering, coordinates parallel work when appropriate,
  and delivers previewable outputs. See
  [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).
- Grok Automations turns each schedule or trigger execution into a real
  conversation with run history, manual `Run now`, and a resumable result. See
  [Automations in Grok](https://x.ai/news/grok-automations).

Pi remains local-first, model-neutral, and workspace-aware. These references
are behavioral baselines, not dependency or visual-design choices.

## Unified work model

### Task and attempt boundaries

`AgentTaskService` remains authoritative. Extend its durable records rather
than adding a background-job database beside it.

```ts
type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

interface TaskContractSnapshot {
  goal: string;
  actor: { kind: "pi" | "agent" | "user" | "routine" | "a2a"; id: string };
  conversationId: string;
  agentId?: string;
  agentRevision?: number;
  workspaceRoot: string;
  modelRoute: ModelRouteSnapshot;
  capabilityGrantIds: string[];
  permissionMode: "manual" | "safe_auto" | "unrestricted";
  expectedDeliverable?: DeliverableExpectation;
  routine?: { id: string; revision: number; scheduledFor: string };
}

interface AgentTask {
  id: string;
  contract: TaskContractSnapshot;
  status: TaskStatus;
  activeAttemptId?: string;
  attemptIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  resultSummary?: string;
  artifactIds: string[];
  error?: SafeTaskError;
}
```

An attempt is one executor invocation. Browser reconnects, UI navigation, and
event-stream reconnects do not create attempts. Explicit retry, approved model
fallback, and restart recovery may create a new attempt.

### State transitions

```text
queued -> running
running -> waiting_for_approval -> running
running -> waiting_for_input -> queued -> running
running -> stopping -> cancelled
running -> completed | failed | interrupted
interrupted -> queued only through explicit or policy-approved resume
failed -> queued only through explicit retry
```

Terminal states never transition in place. Retry appends an attempt and records
the initiating user or policy event.

### Durable event stream

Every task has an append-only event stream with a monotonically increasing
sequence number. At minimum it records:

```text
task.created
task.queued
attempt.started
progress.updated
approval.requested
approval.resolved
input.requested
input.received
artifact.created
artifact.version.created
attempt.completed
attempt.failed
attempt.interrupted
task.completed
task.failed
task.cancelled
```

Events contain bounded summaries and references. Full transcripts, command
output, and artifact bodies remain in their owned stores. The server writes an
event before broadcasting it. Client state is a projection of persisted events
and can be rebuilt after reconnect.

## Pre-run contract

Before consequential or configured work begins, Pi shows a compact review card:

```text
Goal
Workspace
Agent or executor
Model and billing route
Connected accounts and tools
Permission mode
Schedule or trigger, when present
Expected output
```

The review card is required when any of these change from the conversation's
last accepted contract:

- workspace root;
- executor, agent, or model billing route;
- write-capable or external-action grants;
- permission mode;
- routine or trigger activation; or
- expected destination for sent, published, or shared output.

Ordinary follow-up messages using the accepted contract do not produce another
modal. The current contract is available through a compact information action
in the composer status row.

The card never displays secret values. Provider account labels are shown with
the relevant capability summary, such as `Personal Gmail · read and draft`.

## Permission modes

### Manual

Read operations permitted by grants may run. Writes, sends, deletes, purchases,
publishing, external sharing, credential changes, permission changes, and new
network destinations pause for explicit approval.

### Safe Auto

Read-only operations and reversible local writes inside the permitted workspace
may proceed. The policy service evaluates each other action. It may approve a
bounded low-risk action or pause for the user. Money movement, purchases,
messages sent as the user, credential changes, permission expansion, and
permanent deletion always pause.

### Unrestricted

Granted actions may proceed without per-action prompts, except that permanent
deletion outside task-owned temporary data, money movement, and permission or
credential changes still require explicit confirmation. This invariant cannot
be disabled by an agent prompt.

Permission mode is not a capability grant. The action still requires a valid
grant, account, workspace/network policy, and durable audit decision.

## Attention Inbox

### Purpose

Attention is a compact projection of durable work that needs the operator or
has produced a meaningful terminal outcome. It is not another task store and
does not duplicate run history.

```ts
type AttentionKind =
  | "approval"
  | "question"
  | "failure"
  | "completed";

type AttentionStatus = "open" | "resolved" | "dismissed";

interface AttentionItem {
  id: string;
  taskId: string;
  attemptId?: string;
  eventSequence: number;
  kind: AttentionKind;
  status: AttentionStatus;
  title: string;
  summary: string;
  actionLabels: string[];
  createdAt: string;
  resolvedAt?: string;
}
```

An attention item points to the event that created it. Replaying events must
not create duplicates. Approval and question items resolve when their
underlying request resolves. Failure remains until viewed and dismissed or the
task succeeds on retry. Completion enters Attention only when the run was
backgrounded, scheduled, delegated, or produced an artifact; trivial foreground
chat replies do not create noise.

### Left-panel presentation

Attention is a collapsible section beneath Sessions and Agents. Its header
contains the label, unresolved count, and one compact filter action. The
collapsed header remains visible only while unresolved items exist; otherwise
it may reduce to an icon in the panel footer.

The default preview shows at most five items ordered by consequence and then
recency:

1. approvals;
2. questions;
3. failures;
4. completed work.

Each row shows status icon, short title, source identity, and relative time.
Selecting it focuses the existing conversation and task. It never opens a
duplicate chat tab. `View all` opens an overlay in the center, not a permanent
workspace tab.

On compact mobile layouts, Attention lives in the left drawer. A badge on the
drawer button reports unresolved approvals and questions only. Completion
notifications must not make the mobile navigation appear urgent.

### Actions

- Approval: `Allow once`, `Deny`, and, when policy permits, `Always allow`.
- Question: reply through the ordinary composer with the question context
  attached.
- Failure: `Open`, `Retry`, or `Dismiss` when the failure is terminal.
- Completion: `Open result` and artifact actions when artifacts exist.

Bulk approval is not supported. Bulk dismissal may apply only to viewed
completion items.

## Progress and activity presentation

The transcript shows one compact live task card containing current phase,
elapsed time, active worker count, and stop control. It updates in place.

The default expanded content is limited to:

- current plan step;
- a short progress sentence;
- a pending approval or question; and
- final result and artifact links.

Tool calls, shell commands, browser steps, subagent activity, retries, model
fallback, and diagnostics are grouped under collapsed disclosures. The eye
control for a subagent opens that child task's activity in the same center tab
or a temporary inspector; it does not permanently inject the child transcript
into the parent conversation.

Progress updates are rate-limited and coalesced before persistence. Terminal,
approval, question, artifact, and error events are never coalesced.

## Routine and trigger runs

A routine definition is configuration. Every invocation creates:

1. a new task;
2. a new or explicitly grouped run conversation;
3. a contract snapshot containing routine ID, revision, scheduled time, model,
   grants, account references, and expected output; and
4. an Attention item when it needs input, fails, or completes with a meaningful
   result.

`Run now` uses the currently saved routine revision. Unsaved edits cannot be
executed as though deployed. The UI therefore orders actions as `Save schedule`
followed by `Run now`.

Opening a historical run opens its complete conversation. A follow-up continues
that run's conversation but does not mutate the routine definition. `Update
routine from this conversation` is an explicit, reviewable action.

Email and future event triggers use the same task path. Trigger payloads are
stored as redacted input references, not copied secret-bearing provider events.

## Reconnect and restart recovery

### Browser reconnect

The client stores only selected IDs and the last received event sequence. On
reconnect it requests a current snapshot and then events after that sequence.
The server is authoritative. Reconnect does not restart a worker or replay a
command.

### Serve-host restart

At startup the recovery service:

1. validates task snapshots and event sequences;
2. reconciles non-terminal attempts with known child processes or remote
   executors;
3. reconnects to executors that support durable handles;
4. marks unresolvable local attempts `interrupted`;
5. releases stale workspace and browser leases only after reconciliation;
6. creates one failure Attention item when operator action is required; and
7. restarts schedulers without replaying missed runs in a burst.

Recovery never repeats an external write merely because its result was not
observed. Such attempts become `outcome_unknown` and require reconciliation.

### Client and worker isolation

Each Pi session, direct agent, delegated connection, and workflow attempt has
an independent outbound event queue. A slow client or verbose run cannot block
registry updates, settings saves, another chat, or another agent. Persistence
writes are serialized per task, not through one global UI or worker lock.

## Storage

Extend the existing serve storage without introducing a parallel database:

```text
~/.pi/agent/serve/
  tasks/<agent-id>/<task-id>/task.json
  tasks/<agent-id>/<task-id>/events.jsonl
  tasks/<agent-id>/<task-id>/attempts/<attempt-id>/attempt.json
  attention/projection.json
  routines/<routine-id>.json
```

`attention/projection.json` is a rebuildable index, not authoritative data.
Atomic replacement is required. If it is absent or corrupt, rebuild it from
task events.

Retention is configurable by completed task age and storage size. Open
attention items, active tasks, audit records, and referenced artifacts are not
removed by automatic retention.

## Authenticated API and events

The browser-facing API provides:

```text
GET  /api/work/snapshot
GET  /api/work/tasks/:taskId
POST /api/work/tasks/:taskId/stop
POST /api/work/tasks/:taskId/retry
POST /api/work/tasks/:taskId/approvals/:approvalId
POST /api/work/tasks/:taskId/input
GET  /api/work/attention
POST /api/work/attention/:itemId/dismiss
GET  /api/work/events?after=<sequence>
```

Routes are illustrative and may follow the repository's established route
naming. Semantics, authentication, bounded payloads, and idempotency are
required. Mutation requests carry an idempotency key. Event delivery may use
authenticated SSE or the established WebSocket, but it must support sequence
resume.

## Security and privacy

- Attention summaries are redacted server-side before persistence.
- The browser cannot supply actor, task, or account identity fields that the
  server can derive from authenticated state.
- Approval IDs are single-use and bound to the exact canonical action digest.
- A changed target, payload, account, workspace, or capability invalidates the
  approval.
- Model and provider names may be shown; API keys, OAuth tokens, subscription
  credentials, and raw authorization errors are excluded.
- Task contract paths are canonicalized and validated against permitted roots.
- Event payloads have size limits and safe error classifications.
- A completion notification does not expose artifact contents on a locked or
  unauthenticated surface.

## Migration

1. Read existing task, attempt, routine-run, ACP, and agent-run records through
   versioned adapters.
2. Assign stable task IDs where a durable ID already exists; record legacy IDs
   as aliases.
3. Build contract snapshots from the recorded agent revision, workspace,
   executor, model, and grants. Unknown fields are marked `legacy_unknown`, not
   guessed.
4. Convert recoverable run events into the unified event stream.
5. Build Attention only for currently actionable or recent terminal work.
6. Keep legacy data read-only for one migration window, then remove it only
   after parity validation and explicit cleanup.

Migration is idempotent. A failed migration leaves the original records intact
and prevents mutation of a partially migrated task.

## Implementation slices

### Slice 1: task contract and event durability

- Add versioned contract snapshots and lifecycle states.
- Add monotonic event sequences and idempotent append behavior.
- Separate task and attempt identity across all executors.
- Add projection rebuild tests.

### Slice 2: executor reconciliation

- Give local child workers and ACP adapters durable handles.
- Implement reconnect, interrupt detection, stop, and cleanup.
- Remove UI connection ownership from worker lifetime.
- Verify concurrent sessions and agents do not share blocking queues.

### Slice 3: Attention projection and API

- Derive attention items from task events.
- Add deduplication, resolution, dismissal, and bounded retention.
- Add authenticated snapshot, mutation, and resumed-event APIs.

### Slice 4: compact UI

- Add the collapsible Attention section and mobile badge.
- Add one in-place live task card.
- Keep activity and subagent details collapsed.
- Focus existing conversations instead of opening duplicate tabs.

### Slice 5: permission modes and contract review

- Implement Manual, Safe Auto, and Unrestricted policy mappings.
- Add canonical action-bound approvals.
- Add compact contract review and changed-contract detection.

### Slice 6: routine and trigger conversations

- Route scheduled, manual, and event-triggered runs through the same task path.
- Preserve routine revision snapshots and independent run conversations.
- Add `Save schedule`, `Run now`, and explicit update-from-run behavior.

### Slice 7: migration and recovery

- Add versioned legacy adapters and idempotent migration.
- Reconcile tasks, processes, leases, schedules, and projections at restart.
- Add outcome-unknown handling for unconfirmed external effects.

### Slice 8: responsive and end-to-end validation

- Validate desktop, resized pane, phone, and unfolded Pixel Fold widths.
- Validate refresh and reconnect during simultaneous Pi, agent, ACP, routine,
  browser, and settings activity.
- Run focused tests and `npm run check`.
- Run a live `pi --serve` smoke test over localhost and authenticated LAN access.

## Acceptance criteria

- Refreshing or closing a client does not stop an active run.
- Returning from another authenticated device focuses the same task and replays
  only missing events.
- Two Pi sessions, two agents, and one delegated run can progress concurrently
  without delaying settings or navigation.
- Approval, question, failure, and qualifying completion events appear exactly
  once in Attention.
- Selecting Attention focuses the existing conversation and does not duplicate
  the task or tab.
- Tool calls and subagent activity remain collapsed by default.
- Retry appends an attempt and preserves the failed attempt's evidence.
- Routine `Run now` uses the saved revision and creates a resumable conversation.
- Restart recovery never blindly repeats an external write.
- Permission decisions are action-bound, audited, and free of secret material.
- Compact and mobile layouts keep the composer, drawer controls, settings, and
  approval actions reachable without horizontal page overflow.

## Non-goals

- A hosted multi-tenant control plane.
- Guaranteed exactly-once execution across arbitrary external providers.
- Bulk approval of consequential actions.
- Displaying complete reasoning or unrestricted child transcripts.
- A second scheduler, chat store, or job queue beside `AgentTaskService`.

