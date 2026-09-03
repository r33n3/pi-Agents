# Pi agent collaboration implementation goals

Status: implementation and release-candidate validation complete. Goals 1
through 4 passed their review gates. Commit, merge, push, and deployment remain
separate user decisions.

## Program outcome

Make deployed Pi agents behave like persistent, inspectable teammates without
adding a second agent runtime, task queue, scheduler, approval system, or
conversation authority.

The persistent relationship is a user interface and durable-history concept.
Every unit of work remains an `AgentTask`; every execution attempt uses an
immutable configuration snapshot and live run authority; every consequential
effect remains governed by the existing capability and approval services.

## Invariants for every goal

- The left pane owns Sessions and the persistent Agents roster.
- The center owns the selected session or agent inbox conversation.
- The right drawer owns Browser, Workflow and Attention assistance, and Agent
  Builder configuration when requested by the user.
- Agent Builder remains the only deployment and later-edit path for agent
  packages.
- Presentation state cannot grant authority or mutate an executable agent
  revision.
- Credentials, approvals, private transcripts, and browser authority never
  transfer between agents.
- Personal agents, credentials, private catalogs, and live transcripts remain
  outside public fixtures and commits.
- Each implementation slice includes focused tests, `npm run check`, recovery
  checks appropriate to the slice, and desktop/mobile browser validation for
  user-visible changes.

## Goal 1: reconcile and integrate lifecycle hardening

### Outcome

Port the lifecycle-hardening implementation onto the current repository
baseline while preserving the accepted model-controls, agent-improvement, and
workspace user experience.

### Required work

- Rebase the lifecycle design against the current source and tests rather than
  copying stale browser or host files wholesale.
- Integrate exclusive serve-directory ownership, exact action-bound approvals,
  live run authority, immutable run snapshots, browser connection generations,
  metadata-only capability discovery, and the single host-owned capability
  execution path.
- Make one canonical configuration snapshot builder own normalization,
  secret exclusion, immutable cloning, capability binding, and digesting.
- Update the lifecycle and collaboration specifications to the current pane
  ownership and this sequenced roadmap.
- Preserve native model settings, saved-agent improvement state, proof and
  acceptance behavior, current Agents roster placement, and mobile drawers.

### Review gate

- No stale lifecycle file replaces a newer current-baseline behavior.
- Focused lifecycle, capability, approval, browser-generation, agent-run, and
  model-control regression tests pass.
- `npm run check` and `git diff --check` pass.
- One live desktop and LAN/mobile smoke test confirms startup ownership,
  session selection, model settings, Agent Builder, and normal shutdown.
- Changed-file review finds no user-specific agent or credential data.

## Goal 2: persistent roster, inbox, context, delivery, and routines

### Outcome

Give every deployed agent one stable inbox and admit user, Pi, routine, and
agent-originated work through durable, idempotent task delivery.

### Required work

- Add explicit agent-inbox identity, message sequencing, context epochs, and
  restart-safe migration.
- Add one roster projection owner for presentation, unread, activity, current
  task, attention, and routine summaries.
- Persist bounded task context and the canonical execution configuration seed
  before a queued task becomes schedulable.
- Add durable direct delivery with host-derived sender identity, scoped
  idempotency, typed failures, explicit retry rules, and bounded result
  references.
- Add host-owned delegation, inspection, and cancellation tools constrained by
  the source run snapshot and live authority.
- Project scheduler-owned routines and their run receipts into the responsible
  agent inbox without changing routine ownership.
- Render the stable roster below Sessions and focus the selected agent inbox in
  the center without creating a new task.

### Review gate

- Every deployed agent has exactly one inbox across restart and migration.
- Selecting, pinning, hiding, or reading an agent changes no executable
  revision or authority.
- Duplicate canonical delivery creates one task; changed content under the
  same key conflicts without mutation.
- Queued work cannot silently switch agent revision, model controls, grants,
  workspace, or context.
- Cancellation, interruption, corrupt projections, reconnect, retry, and
  Attention behavior pass deterministic recovery tests.
- Desktop and mobile complete create, select, send, follow progress, stop,
  retry, schedule, hide/show, and edit-in-Builder workflows.
- Full checks and privacy review pass.

## Goal 3: bounded local collaboration rooms

### Outcome

Allow deliberate multi-agent comparison and review through task-backed rooms
without introducing an open-ended group-chat runtime.

### Required work

- Add room definitions, membership, presentation transcripts, and immutable
  round records.
- Execute room turns through trusted ad hoc `WorkflowService` runs and ordinary
  agent tasks.
- Validate typed `reply`, `pass`, and `needs-user` results.
- Enforce member, round, message, concurrency, duration, token, cost, and
  delegation bounds.
- Keep room participation separate from direct-delegation and capability
  authority.
- Surface room progress, limits, results, and user questions through the same
  roster, inbox, Workflow, and Attention surfaces.

### Review gate

- Every member turn has an ordinary task, immutable attempt, and independent
  authority.
- Stable ordering does not depend on completion timing.
- Bounds and user escalation are represented as typed terminal outcomes.
- Restart, cancellation, partial completion, and corrupt projection recovery
  preserve task evidence and do not duplicate turns.
- Desktop and mobile room creation, progress, needs-user, cancellation, and
  result review pass with full checks.

### Validation record

Completed 2026-09-02 against the local ForkPI serve host.

- The combined Goal 1-3 regression set passed 77 focused tests, including
  deterministic reply, pass, needs-user, bounds, cancellation, partial-run
  recovery, corrupt-record handling, authenticated HTTP, host, and browser
  coverage. The repository check and generated-browser consistency check
  passed.
- A real two-agent, one-round room completed with ordinary isolated tasks,
  stable member order, typed reply/pass outcomes, 3 durable room messages, and
  recorded token/cost usage. Restart restored the exact room conversation,
  terminal result, round evidence, task references, and resource totals.
- The open room detail view was corrected to refresh in place as polling moves
  the run from running to terminal. Desktop and a 390 by 844 phone viewport
  exposed the room under Sessions, Agents, and Rooms and rendered the ordered
  transcript without requiring chat scrolling.
- Temporary validation room and agent definitions were removed after the live
  run. Historical run evidence remains in ignored local serve data by design;
  no personal agent, transcript, credential, or room data entered Git.

## Goal 4: complete lifecycle and release validation

### Outcome

Validate the full local agent lifecycle from creation through improvement,
collaboration, scheduling, recovery, and later editing, then prepare a release
candidate for explicit commit, merge, restart, and user live-test approval.

### Required work

- Run a clean isolated lifecycle using synthetic agents and providers.
- Exercise Builder creation, proof, acceptance, promotion, persistent inbox,
  direct delegation, routine execution, bounded room work, improvement feedback,
  later package editing, and recovery after restart.
- Validate desktop, resized pane, phone, and unfolded Pixel Fold layouts.
- Confirm approvals remain exact and actionable through the human-assistance
  drawer without requiring chat scrolling.
- Audit public changes for credentials, personal agents, transcripts, temporary
  test data, dependency drift, and generated artifact consistency.

### Review gate

- All prior goal gates remain satisfied on the final combined baseline.
- Deterministic affected tests, `npm run check`, and `git diff --check` pass.
- The isolated end-to-end lifecycle passes at desktop and mobile sizes.
- Residual risks and intentionally deferred remote federation are documented.
- Commit, merge, push, and live deployment remain separate explicit user
  decisions.

### Validation record

Completed 2026-09-02 against an isolated synthetic lifecycle and the local
ForkPI serve host.

- One cross-boundary test completed draft configuration, rejected an
  unconfirmed publish, published after exact confirmation, proved, accepted,
  promoted, scheduled, delivered direct work idempotently, dispatched routine
  work, completed a bounded two-agent room, retained improvement feedback,
  staged a later package edit without changing the active revision, promoted
  revision 2, and restored the registry, lifecycle, inbox, delivery, room, and
  routine state after service restart.
- The final affected regression set passed 143 tests across 20 files. The
  repository check, generated-browser consistency check, and `git diff
  --check` passed.
- Live validation covered 1440 by 900 desktop, independently resized navigation
  and details panes at 1200 by 800, a 390 by 844 phone, and an 853 by 1280
  unfolded Pixel Fold. Workflow and approval assistance remained accessible in
  the right drawer without chat scrolling.
- The persistent Agents roster now exposes Edit and Improve beside Pin and
  Hide. Edit opens the deployed package in Agent Builder; Improve opens the
  review-first improvement workflow. Both paths were opened against the live
  test agent and cancelled without mutation.
- Dependency manifests and lockfiles were unchanged. The public diff contains
  no personal agent, credential, token, transcript, or temporary live-test
  data; the only synthetic agent identifier is scoped to the isolated lifecycle
  test.
- The broad repository wrapper was also attempted on this Windows host. Its
  failures were outside the changed surfaces and trace to Git Bash path
  conversion, unavailable Windows symlink privileges, child-process quoting,
  and timing under full parallel load. Native affected tests are clean; these
  host-specific full-suite limitations remain a release-environment risk rather
  than a lifecycle regression.
- Remote federation remains intentionally deferred. Historical room evidence
  remains in ignored local serve data after a room definition is removed so
  completed work stays auditable.

## Deferred beyond this program

- Cross-machine room state or Desktop relay.
- Treating profile directories or conversations as security boundaries.
- Multi-user read state and cloud identity management.
- Unbounded autonomous conversation or recursive delegation.
- Automatic transfer of credentials, approvals, memory, or browser ownership.
