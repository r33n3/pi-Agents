# Reliable conversational agent building

## Goal

Describe an outcome, obtain a useful draft, test it, refine it, activate the
reviewed revision, and optionally schedule it from one conversation. The host
owns authorization, validation, execution identity, recovery, and state
transitions. Inference performs bounded reasoning and proposes changes.

This specification supersedes earlier requirements that make skill export a
prerequisite for agent activation or automation. Export remains available.
Existing provider choices, standalone agents, imports, workflows, and browser
capabilities remain supported.

## Design decision

Keep Pi's inference and session runtime. Consolidate the product services around
one validated configuration and task execution contract. Do not add another
agent framework or distributed scheduler.

Alternatives considered:

- Keep separate execution/build paths and improve prompts. This preserves
  duplicated policy and makes model compliance responsible for correctness.
- Replace the runtime with an external orchestration framework. This adds
  migration and provider integration cost without resolving authorization.
- Consolidate existing services and use direct execution adapters. Selected:
  it preserves capabilities while localizing policy and recovery.

## Contracts

1. User authorization comes from host-observed user input or an authenticated
   review action, never model-supplied confirmation text alone. A receipt binds
   the exact proposal, session, revision, and expiry.
2. Active revision eligibility is independent of a draft candidate. Editing,
   rejecting, or testing a candidate cannot suspend the active routine.
3. Activation requires accepted current evidence and resolves the effective
   execution configuration. Skill export is optional and has no authority of
   its own.
4. Chat, forms, and imports use the same configuration validation. Missing
   capabilities are explicit blockers; cosmetic defaults are not questions.
5. Selected external backends dispatch directly. Backend-specific transport
   stays in adapters; lifecycle, cancellation, workspace exclusion, artifacts,
   and recovery use shared mechanisms.
6. Validate complete changes before mutating state. Retried commands must either
   reuse their durable result or report a recoverable partial operation.
7. Machine checks and human review remain distinguishable. User-defined criteria
   cannot disable mandatory host checks.
8. Provider availability is distinct from workflow suitability. Unsupported
   controls fail before dispatch; no silent backend, billing, or model fallback.

## Implementation and verification plan

- [x] Separate active eligibility from candidate state; add activation without export.
- [x] Verify host-observed approval and simplify authorized test/feedback actions.
- [x] Share configuration parsing and expose complete capability patches to chat.
- [x] Replace inference-mediated external routing with direct adapters.
- [x] Share execution coordination and improve durable operation recovery.
- [x] Make mandatory proof checks explicit and retain human-review provenance.
- [x] Update UI, tools, operator docs, and skill instructions to the same lifecycle.
- [x] Validate draft → test → feedback → retest → activate → schedule → edit → restart.
- [x] Validate backend routing, cancellation, conflicts, invalid input, duplicate
      requests, stale approvals, and persistence failures without paid providers.
- [x] Run relevant focused tests, generated-browser verification, and npm run check.

Use synthetic workspaces and providers for automated verification. Do not alter
personal agents, credentials, or schedules. Record any live backend verification
limits explicitly. Do not claim completion from documentation or unit tests alone.

## Baseline

Work began on main with existing edits to the Responses stream guard, workspace
defaults, related tests/changelogs, and building-agents instructions. Preserve
those edits. Initial focused checks: stream tests passed; lifecycle/tool tests
exposed a cleanup race in agent-registry-tools.test.ts that passed on rerun.

## Execution record

Implemented on 2026-09-04:

- `activeProof` identifies the accepted active revision independently of candidate
  stage. Explicit activation pins the proof's effective model. Registry writes
  compare the expected revision inside their write queue; a competing update
  cannot silently overwrite another accepted revision.
- Conversation tools require a later, host-observed user approval bound to the
  proposal. Model-provided confirmation text cannot authorize an action. Completed
  proposals replay their retained result. Interrupted authorized actions retain
  partial progress and require inspection before a replacement proposal.
- Draft configuration uses the registry's pure normalization. Chat exposes the
  same capability grants, browser settings, and native model controls as the
  saved configuration. Invalid changes are rejected before changing evidence.
- Claude and Hermes invoke their selected tools directly. Agent and external
  executions share capacity and conflicting-workspace admission. Cancellation,
  disposal, and failed persistence release admission. Worker cancellation now
  retains its abort outcome even if the process exits before its IPC error arrives.
- Mandatory retained-configuration and nonempty-result checks survive replacement
  of custom criteria. Human acceptance is a separate review receipt. Export does
  not activate a candidate, and schedule-only changes preserve accepted evidence.
- The browser synchronizes tool-created drafts into its package view and offers
  test, proof review, activation, optional export, and automation in order.

Focused verification:

- 40 tests passed across lifecycle, conversation coordinator, registry tools,
  lifecycle integration, external connections, host dispatch, direct execution,
  and shared admission. Includes rejected/refined candidates, retesting,
  activation, scheduling, restart recovery, approval replay, persistence failure,
  and competing registry writers.
- 48 tests passed across saved native model settings, served browser assets, and
  real child-process execution. Includes scoped host tools, worker isolation,
  missing IPC recovery, cancellation, watchdogs, and model-control validation.
- Another 46 tests passed across registry, run management, tasks, scheduler,
  routine registry, skill export, model-control endpoints, and serve services.
- The real Chromium conversation scenario passed through drafting, proof review,
  activation, scheduling, forged model confirmation rejection, duplicate-action
  replay, candidate refinement, and host restart. The active routine and candidate
  remained distinct after restart. This long integration test has a five-minute
  overall allowance; it is not a streaming throughput benchmark. Timing varied
  substantially on this Windows host, and no UI performance improvement is claimed.
  The final rerun without diagnostic instrumentation passed in 137 seconds.
- `npm run check` passed: formatting, browser generation/type checks, pinned
  dependencies, imports, lock/shrinkwrap verification, root types, browser smoke.

## Verification boundaries

The initial automated inference checks were synthetic. Browser verification used Chromium, the real
serve host and protocol, a faux chat provider, and a synthetic proof worker.
The subsequent [live example validation](pi-agent-example-validation.md) exercised
OpenAI, Anthropic, and Ollama through real workers, including file tools and a
scheduled task after restart. Eight of ten live outputs passed their checks;
two model-only arithmetic attempts failed. A deterministic calculation capability
then passed on the same Anthropic configuration. Live Codex/Claude CLI/Hermes and
Grok/xAI verification remain outstanding. No personal agents, schedules, or
credentials were modified by these tests.

The host controls state transitions deterministically; model outputs remain
probabilistic. A provider being available does not make it suitable for a task.
Proof quality depends on representative criteria and inputs.

Cross-file activation/publication/scheduling is not a database transaction or
an exactly-once guarantee for external effects. Inspect retained partial results
after interrupted authorization. Workspace admission covers normalized equal or
nested paths within one host, not filesystem aliases or other hosts. Existing
session tools are not an OS sandbox; run budgets are not hard spending caps.
Full external CLI descendant termination has not been verified on every platform.

Legacy records lacking `activeProof` need a current accepted proof and explicit
activation; the host does not reinterpret earlier skill export as authorization.
