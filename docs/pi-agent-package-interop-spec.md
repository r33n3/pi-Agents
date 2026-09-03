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

Pi remains a complete standalone agent runtime. Native conversational agent
creation, editing, execution, delegation, improvement, scheduling, skills,
memory, and isolated workers do not require WTK. WTK is an optional canonical
catalog/compiler boundary when a portable, independently qualified package is
desired.

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
- consumer-local capabilities, providers, credential slots, approval modes,
  or role bindings that widen the explicit bundle authority ceiling; and
- any unsupported failure-policy widening.

Installation is serialized and prevalidates the complete bundle before it
writes a durable prepared transaction. Recovery rolls that transaction
forward through checkpointed agent and workflow application, commits the
secret-safe install receipt only after the intended runtime state is durable,
and removes the transaction last. Repeated recovery compares intended state
before saving, so it converges without agent revision churn. Exact retries
return `reused`; changed bundle or reviewed local bindings return `updated`.
The committed identity covers the bundle, reviewed binding, authority,
execution form, and adapter digests. The operation requires the normal serve
capability token.

The restart proof interrupts all eleven durability boundaries: before prepare,
after prepare, after the applying-phase checkpoint, after each role-agent
mutation and its journal checkpoint, after workflow mutation and its journal
checkpoint, after receipt temporary-file write, and after receipt rename. A
fresh registry, workflow service, and installer must recover from disk, leave
both role revisions at one, remove transaction and temporary-file residue, and
return `reused` on the exact retry (or `created` when interruption preceded the
prepared transaction).

## Runtime execution and evidence

Pi schedules workflow nodes only after every declared predecessor reaches a
terminal state. Independent ready nodes run within `maxConcurrency`; fan-in
nodes receive every predecessor result. Required-lane failure stops the run,
dependent nodes are marked blocked, and graph depth is rejected when it exceeds
`maxDelegationDepth`.

Smoke writes `pi.agents.runtime-evidence.v1`, binding the exact source,
contract, bundle, authority, effective deployment, adapter, execution form,
workflow run, node outcomes, and task identities. Each node carries measured
token/cost usage and a verdict for its declared role budget. Pi caps
per-response output tokens before model execution and fails terminal tasks
whose cumulative measured usage exceeds a declared ceiling. Pi reports
factual execution status only, including content-addressed node outputs or
errors. It does not judge the WTK goal, issue qualification, or authorize a
deployable catalog claim. WTK independently recomputes the authority and
effective-deployment identities, verifies every reported output digest, and
validates the factual output against the canonical role schema. A Pi-local
`passed` output-contract assertion is not sufficient by itself. WTK may call
the exact run `execution-proven` only when those identities and reviewed
bindings match, every required node completed, every output passes WTK's
independent validation, and every declared budget has a matching passing
receipt; goal accomplishment still requires separate WTK evaluation and
control evidence.

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

1. Wire WTK's closed receipt producers into the operator run. WTK now derives
   output validation from Pi's content-addressed factual outputs; derives
   semantic, integrity, separation, safety/authority, and optional tribunal
   receipts from one sealed held-out evaluation bundle; and derives attempt
   accounting from an immutable preallocated plan plus every retained terminal
   result. Package-level summaries and caller-authored flags never substitute
   for these exact-run artifacts.
2. Keep retained target evidence separate from catalog readiness and promotion
   authority; an unassessed or mismatched package remains compile-only.
3. Validate concurrent prepare/launch review staleness and active-run rebinding
   across restart and LAN clients.

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

The retained historical Pi runtime evidence records
`verdict: goal-accomplished`, and the historical WTK assessment records
`claim: deployable`, for bundle digest
`25d8af773ff4deb70abfd4e72b339c2b5d0e2530adaec384a5c40842cc58bd14`.
The proof reviewed the exact America/Chicago calendar day `2026-08-28`, using
the Gmail query `after:1787893200 before:1787979600`, and produced the expected
HTML report, index, and state artifacts. The report was independently checked
for the document/viewport contract, responsive styling, the exact reviewed
query, and 20 native `details`/`summary` message disclosures.

This is a date-bound compiled-runtime observation for the exact package,
contract, bundle, reviewed bindings, and workflow run. It does not publish an
AgentHub claim, and its accomplishment/deployable labels are superseded by the
fact-only execution contract above. General recurring proof still needs a target-independent way to
bind derived date inputs to cross-field output assertions; static JSON Schema
cannot express that relationship by itself.

## Live retained code-review proof (2026-08-30)

The canonical WTK package `provide-an-automated-offline-code-review` compiled
to the Pi target, installed with reviewed consumer-local bindings, and executed
both required roles successfully as Pi workflow run
`970c4a3a-47b2-4f98-9c10-233a4130172d`. Both role output contracts passed.
Pi retained the workflow plus attempt records, transcripts, and results.

WTK imported copies of those exact artifacts under one SHA-256-bound source
manifest and assessed the target run as `execution-proven`. Rebuilt WTK
qualification remains correctly blocked: target smoke is 1/1 passing, while
three deterministic fixture partitions and 17 goal obligations remain
unevaluated. The runtime proof does not imply goal accomplishment,
qualification, catalog acceptance, or promotion authority.
