# Pi fast agent and team workflow specification

## Status

Implementation contract for simplifying the path from a canonical WTK package
or conversational draft to a running Pi agent team. The existing registry,
task, workflow, bundle, vault, and artifact services remain authoritative.

## Goal

The common path should feel like starting a conversation with a teammate:

```text
describe outcome -> review team and access -> launch -> continue in chat
```

Advanced model, capability, workflow, routine, and policy controls remain
available through progressive disclosure. They do not become a second runtime
or persistence path.

## Invariants

- Canonical WTK packages remain source truth for portable teams.
- Pi bundle validation, reviewed local bindings, and capability grants remain
  mandatory before installation.
- Agent definitions, workflows, conversations, tasks, and artifacts keep their
  existing authoritative owners.
- Workers remain isolated processes. A team is not a credential or filesystem
  security boundary.
- Installation and launch are idempotent for the exact bundle and bindings.
- The default UI preserves the existing dark Pi visual system and exposes no
  large configuration form until the operator requests advanced controls.

## Design alternatives

### Alternative A: orchestrate existing endpoints in the browser

The browser would call review-bindings, validate, install, refresh agents,
resolve the coordinator, create a conversation, and select it. This has the
smallest backend diff, but leaks ordering and recovery into every future UI or
client. A refresh between calls can leave an installed team that the UI treats
as unfinished.

### Alternative B: introduce a first-class team runtime and store

A new service would own team conversations, members, messages, runs, and
artifacts. This presents a clean surface but duplicates AgentTaskService and
WorkflowService state, creating two meanings for conversations and runs.

### Alternative C: add a deep prepare/launch service

One service composes the existing bundle installer, registry, workflow, and
task services. Prepare returns a safe review projection and digest. Launch
requires that digest, regenerates the exact binding review, performs the
idempotent install, resolves the coordinator, and ensures its durable
conversation.

**Decision:** Alternative C. It centralizes unavoidable sequencing without
creating another runtime model. The browser receives one review object and one
launch result.

## Backend contract

### Canonical WTK factory boundary

Pi owns one loopback-only `WtkAgentFactoryClient`. The browser never calls WTK
directly and never receives its access token or repository paths outside the
bounded build projection. Pi exposes authenticated routes for intake,
operation status, research, build, delivery, and local prepare. The client:

- probes the bounded WTK `/healthz` endpoint with a one-second readiness
  timeout, so opening Agent Builder does not wait on an unavailable service;
- permits only HTTP(S) loopback origins and fixed API paths;
- limits response sizes and operation identifiers;
- accepts WTK paths only when they resolve inside the configured WTK root; and
- loads only `.wtk/packages/<id>/targets/pi-agents/bundle.json`.

Intake session, operation, phase, package, review-ready state, and compact
messages persist in browser storage. A reload resumes the durable WTK
operation. Explicit brief approval sends WTK's deterministic `confirm` action;
ordinary conversation remains natural language.

### Prepare

```text
POST /agent-teams/prepare
```

Input contains a `pi.agents.bundle.v1` bundle and unreviewed consumer-local
bindings. Output contains:

- an approval digest binding the exact bundle and local bindings;
- team name, package identity, coordinator, members, workflow shape, and
  permission summaries;
- local model selections, project root, credential-reference names, and grant
  counts; and
- no credential values, tokens, internal registry paths, or persona prompt
  bodies.

### Launch

```text
POST /agent-teams/launch
```

Input repeats the bundle and bindings, supplies the approval digest displayed
to the operator, and identifies the reviewer. Launch fails if any reviewed
input changed. On success it returns:

- created, updated, or reused disposition;
- the exact install receipt;
- coordinator agent and durable conversation IDs;
- installed member IDs and workflow ID.

The operation relies on the installer's prepared transaction and recovery
logic. An identical retry reuses the installation and conversation.

### Team conversation

```text
GET  /agent-teams?coordinatorAgentId=<id>
POST /agent-teams/run
POST /agent-teams/cancel
```

The installed receipt durably identifies the coordinator and workflow. A
coordinator message starts that workflow rather than submitting a direct task
to the coordinator agent. State returns the five most recent runs with bounded
node progress; older complete results remain available in workflow history.
The latest turn is expanded in chat and older turns are collapsed.

Worker conversations remain implementation details and are not mixed into the
team transcript. Reload reconstructs the transcript from workflow runs, so a
registry "latest conversation" race cannot redirect the team tab to a worker.

## Conversation-first UI

The `Agents +` action opens one compact composer with the question: “What
should this agent or team accomplish?” The response becomes either:

- a native Pi agent draft using the existing registry path by default; or
- an explicitly selected canonical-package team review using the optional WTK
  compiler or an imported bundle.

WTK is never a startup, creation, editing, execution, or improvement
dependency. When WTK is absent, Pi's native agent registry, delegated agents,
workflows, and isolated workers remain available. WTK is an advanced portable
package source, not Pi's orchestration authority.

The review card shows name, members, models, access, project, and workflow
shape. Its primary action is `Launch team`. `Advanced` opens the current
configuration controls in a secondary sheet. Successful launch replaces the
builder state with the coordinator conversation in the same tab.

Raw draft markers, system instructions, package JSON, and full persona text
are never rendered as ordinary chat messages.

## Runtime and collaboration

- Existing agent task events stream worker state into the team conversation.
- Workflow parent/child IDs represent handoffs; the UI groups them beneath the
  owning coordinator turn.
- Temporary research or review uses clone-run-cleanup semantics: create a fresh
  conversation-scoped worker, capture its result and artifacts, and always
  dispose the worker unless it is awaiting operator input. The implementation
  clones a catalog agent into a generated transient identity, executes it in
  the existing child-process runtime, and never writes that identity back to
  the agent catalog. The authenticated `POST /runs/temporary` endpoint exposes
  this bounded operation.
- Successful task instructions can be promoted to a reviewed skill. Scheduling
  remains a separate tested routine action. Promotion requires a persisted
  successful run, accepts operator-reviewed instructions, validates a staged
  `SKILL.md` through Pi's normal skill loader, installs it atomically, and
  refuses overwrite through `POST /runs/:id/promote-skill`.

## Native improvement loop

Pi owns agent and team improvement. WTK may provide a canonical package and
portable evidence contract, but it is not the runtime or the improvement
controller.

The user starts with an improvement goal and observable success criteria. Pi
retains the current agent revision and selected task attempts as the
last-known-good baseline, then classifies the work:

- a failed, cancelled, or interrupted run enters repair;
- a successful run enters refinement; and
- missing or inconclusive evidence enters diagnosis.

Pi chooses one agent or a coordinated team unless the user constrains the
scope. The builder receives the baseline revision, exact task and attempt IDs,
goal, criteria, and scope as hidden context. It proposes only the smallest
candidate change. The visible advanced configuration remains the review
surface, and the candidate does not replace the baseline until the user applies
it. A passing assessment is evidence for adoption, not automatic adoption.

For canonical WTK packages, the same flow can emit a new package candidate and
compile it to Pi. Package leases and immutable evidence remain WTK concerns;
the refinement conversation, local execution, and deployment decision remain
Pi concerns.

## Progressive build, proof, skill, and routine lifecycle

The conversational builder and advanced form write one durable build record.
Model output may recommend fields, but it cannot advance lifecycle state. The
server owns these transitions:

```text
named draft -> deployed revision -> one-time proof -> reviewed proof
            -> reusable skill -> explicitly confirmed routine
```

A successful worker exit produces `proof-ready`, not `proven`. The operator
must inspect the retained result and accept or reject it. Rejection returns the
build to refinement. Acceptance binds the run ID and exact agent revision. Any
later agent update increments the registry revision and clears that proof,
skill, and automation authority.

Skill promotion accepts only the reviewed proof run for the current revision.
Agent routines accept only a revision that has both accepted proof and a
promoted skill. Enabling a routine also requires a distinct schedule
confirmation containing the displayed timezone. The runtime repeats the same
proof gate when a routine executes, so an old routine cannot silently resume
after its agent changes.

The compact builder header exposes one next action at a time: `Try agent`,
`Review proof`, `Save as skill`, then `Add routine`. Advanced configuration
continues to edit the same agent registry definition. This keeps the common
path conversational while retaining deterministic policy and recovery.

## CrewAI reference patterns

CrewAI's open-source architecture reinforces the same separation already
present in Pi: agents perform bounded work while flows own durable state,
branching, and execution order. Pi adopts the useful contract, not the Python
runtime:

- WTK packages and Pi workflow definitions fill the role of declarative crews
  and flows.
- AgentTaskService and WorkflowService remain the durable run and state owners.
- Existing task events provide the event stream used for progress and
  observability.
- Structured node output contracts, approval policies, and reviewed local
  bindings remain stricter than prompt-only role configuration.

Pi does not embed CrewAI, create a parallel persistence database, or expose its
agent backstory/configuration forms as the primary user experience. This keeps
the fast path portable through the WTK compiler and avoids two orchestration
authorities.

## Implementation slices

1. Deep prepare/launch service and authenticated endpoints. Implemented.
2. Compact natural-language create surface and team review card. Implemented.
   A retained canonical package compiled and installed successfully through the
   Pi target with consumer-local runtime bindings.
3. Same-tab coordinator conversation activation after launch. Implemented.
4. Grouped progress and durable handoff receipts. Implemented.
5. Temporary clone-run-cleanup helper for bounded specialist work. Implemented.
6. Promote-result-to-skill validation, compact review, and routine staging.
   Implemented.
7. Native goal-driven repair, refinement, and diagnosis entry point.
   Implemented; live browser validation remains.
8. Progressive build, explicit proof review, skill promotion, and automation
   gating. Implemented; live browser validation remains.
9. Concurrent Pi session, agent, and team browser validation.

## Acceptance criteria

- One launch request cannot install bindings different from the displayed
  review digest.
- An identical retry creates neither duplicate agents nor conversations.
- A successful launch returns a usable coordinator conversation immediately.
- The common UI does not expose the full advanced builder form.
- Existing advanced controls still edit the same registry and workflow state.
- Refresh or serve-host restart preserves installed teams and conversations.
- Agent progress, handoffs, terminal results, and artifacts remain inspectable.
- Focused tests and `npm run check` pass, followed by authenticated LAN browser
  validation.
