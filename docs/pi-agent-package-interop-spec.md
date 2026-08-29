# WTK package to Pi runtime interoperability

## Status

`pi.agents.bundle.v1` validation, installation, dependency-aware execution,
and runtime-evidence foundation implemented. WTK can carry a complete
`TeamContract` through its out-of-process target protocol and fail closed on
invalid Pi runtime evidence. The canonical cross-repository epic is WTK
`docs/backlog/items/PLATFORM-team-aware-target-deployment.md`.

## Boundary

WTK package source and its compiled `TeamContract` remain source truth. WTK
compiles that exact contract into one generated Pi-native bundle. Pi validates
and installs the bundle through authenticated operations:

```text
POST /agent-packages/validate
POST /agent-packages/install
POST /agent-packages/smoke
```

WTK does not read or write Pi's registry directories. Pi does not reconstruct
WTK semantics from an AgentHub manifest. Provider/model identities, project
paths, capability accounts, and credentials are consumer-host bindings and do
not enter the canonical WTK package.

## Bundle v1

`pi.agents.bundle.v1` contains:

- exact package, effective-source, and team-contract digests;
- all team roles and the coordinator identity;
- role instructions and build-time acceptance criteria as separate fields;
- role-local tools and credential references;
- memory namespaces, policy statements, model requirements, and delegation;
- one acyclic workflow with explicit nodes, edges, required nodes,
  concurrency, depth, and stop-on-required-failure policy; and
- adapter identity and version.

The bundle contains no credential values, API keys, OAuth tokens, fixed local
model IDs, or internal Pi paths.

## Validation and install

Validation is deterministic and offline. It rejects:

- unknown schema or execution-form versions;
- malformed identities or digests;
- missing, duplicate, cyclic, or dangling roles, nodes, edges, or delegates;
- a read-only role receiving Pi mutation tools;
- missing local project/model bindings; and
- absent or stale operator review digests for the exact bundle and normalized
  consumer-local bindings; and
- any unsupported failure-policy widening.

Installation is serialized, prevalidates the complete bundle, creates role
agents before the workflow, compensates registry changes on failure, records
the exact bundle digest, and returns the existing record on an identical
retry. The operation requires the normal serve capability token.

## Runtime execution and evidence

Pi schedules workflow nodes only after every declared predecessor reaches a
terminal state. Independent ready nodes run within `maxConcurrency`; fan-in
nodes receive every predecessor result. Required-lane failure stops the run,
dependent nodes are marked blocked, and graph depth is rejected when it exceeds
`maxDelegationDepth`.

Smoke writes `pi.agents.runtime-evidence.v1`, binding the exact source,
contract, bundle, adapter, execution form, workflow run, node outcomes, and
task identities. Each node carries measured token/cost usage and a verdict for
its declared role budget. Pi caps per-response output tokens before model
execution and fails terminal tasks whose cumulative measured usage exceeds a
declared ceiling. WTK grants a `deployable` assessment only when the identities
and reviewed bindings match, every required node completed, and every declared
budget has a matching passing receipt.

## Runtime instruction compilation

Pi currently compiles each role's operating instructions into its runtime
system prompt and keeps WTK acceptance, policy, memory, and assurance fields in
the bundle boundary. The next runtime slice must make those structured fields
first-class execution inputs:

- skills supply reusable operating procedures;
- hooks enforce pre-tool, post-tool, post-output, and terminal checks;
- memory namespaces govern retrieval and write approval;
- acceptance criteria feed smoke/evaluation, never the system prompt;
- artifacts and receipts carry the package, contract, bundle, role, lane, and
  attempt identities.

This separation prevents the daily-mail agent's schedule, Gmail authority,
memory policy, safety hooks, and evaluation contract from becoming one opaque
persona string.

## First reference package

The reference vertical slice is a daily-mail team:

1. a read-only mail researcher receives Gmail search/read grants;
2. a report writer receives only the workspace artifact authority it needs;
3. the workflow processes the complete previous calendar day in the selected
   timezone;
4. strict failure prevents an empty or partial mail fetch from being reported
   as success;
5. local model IDs and the Google account are bound during Pi installation;
6. smoke fixtures prove message accounting, date-window behavior, HTML/index
   artifacts, restart recovery, and honest partial-read failure.

## Remaining slices

1. Add operator-facing binding flags/control API for external-adapter validate,
   install, and smoke after ordinary package delivery.
2. Add a settings import/binding review that calls the same authenticated API.
3. Run the daily-mail compiled-runtime smoke with faux/local models and retain
   every attempt.
4. Wire the passing WTK Pi evidence assessment into AgentHub catalog readiness;
   an unassessed or mismatched package remains `compile-only`.

## Validation baseline

- focused WTK deterministic compiler tests;
- focused Pi bundle validation/install/idempotency/authority tests;
- Pi `npm run check`;
- WTK `npm run typecheck` and `npm run cli -- --help`;
- full WTK tests for target-compiler changes;
- authenticated live Pi validate/install smoke before declaring the target
  deployable.

## Live canonical package proof (2026-08-29)

The WTK canonical `daily-mail-agent-team` package completed the public
`pi-agents` bind, validate, install, and smoke path against a live Pi host. The
runtime executed the compiled two-role DAG directly, without an undeclared
supervisor, in fresh per-node conversations. Both required nodes completed,
their JSON output contracts passed, and their measured costs remained within
the package-declared ceilings.

The retained Pi runtime evidence records `verdict: goal-accomplished`, and the
independent WTK assessment records `claim: deployable`, for bundle digest
`25d8af773ff4deb70abfd4e72b339c2b5d0e2530adaec384a5c40842cc58bd14`.
The proof reviewed the exact America/Chicago calendar day `2026-08-28`, using
the Gmail query `after:1787893200 before:1787979600`, and produced the expected
HTML report, index, and state artifacts. The report was independently checked
for the document/viewport contract, responsive styling, the exact reviewed
query, and 20 native `details`/`summary` message disclosures.

This is a date-bound compiled-runtime attestation for the exact package,
contract, bundle, reviewed bindings, and workflow run. It does not publish an
AgentHub claim. General recurring proof still needs a target-independent way to
bind derived date inputs to cross-field output assertions; static JSON Schema
cannot express that relationship by itself.
