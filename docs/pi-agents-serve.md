# pi-Agents local console

Run Pi interactively with its authenticated local browser console:

```sh
pi --serve
pi --serve --serve-port 4174
pi --serve --serve-host 127.0.0.1
```

Pi prints a capability URL. Its token is generated for the process unless
`PI_SERVE_TOKEN` is explicitly configured. HTTP resources and the binary
WebSocket protocol require that token. Without `--serve-port`, Pi starts at 4173
and selects the next available port if necessary. An explicit port remains
strict. The default bind address is `127.0.0.1`; an explicit non-loopback
`--serve-host` is allowed with a warning.

## Console

- The center conversation attaches to a selected live session. Session tabs can
  switch within one Pi server, and Sessions can connect another running Pi by
  its complete capability URL. Linked URLs remain in browser memory only.
- The left and right sidebars are independently resizable. Their widths are
  stored in browser-local layout preferences.
- The composer sends with an arrow while idle and becomes a red stop control
  during a turn. Enter sends; Shift+Enter inserts a newline.
- Published agents appear as durable identities below Sessions. The right
  workspace contains Browser, Workflow, and Agent Builder. Workflow collects
  pending lifecycle decisions, active tasks, approvals, and agent activity; on
  mobile its top-bar indicator shows the pending count without blocking chat.
  Agent Builder owns Profile, Runtime, Capabilities, Delegation, and Automation
  for one agent.
- The gear beside Sessions opens deployment Settings for Models, Connections,
  Capabilities, Plugins & MCP, and Security. Provider credentials and account
  authorization are configured there rather than duplicated in Agent Builder.
- Browser, when the managed-browser milestone is
  installed, shows the same Chromium page controlled by the user and agent.
  See the [managed-browser specification](pi-browser-preview-spec.md) for the
  implementation contract.
- Browser walkthroughs can be recorded, compiled into semantic targets,
  validated in a fresh context, activated, and run by Pi or an explicitly
  granted agent. Active versions can also be attached to routines, larger
  workflows, generated skills, and project frontend tests. Run evidence and
  screenshots remain available after restart.
- Pi chat and Agent Builder share one draft lifecycle. `configure_agent` stages
  a durable draft; it never deploys, runs, promotes, or schedules by itself.
  Omitted `projectRoot` preserves an existing draft/agent workspace or defaults
  to the current session directory for a new draft. The tool reports the chosen
  workspace, and lifecycle proposals include it for review.
  The user reviews the complete package in Agent Builder and explicitly
  activates it after accepting its proof. Edits to a published agent create an inactive candidate
  revision; the active definition and its schedules remain unchanged until the
  candidate passes proof review and explicit activation.
- `manage_agent_build` gives chat the same reviewed test, Accept/Reject,
  Activate, Export skill, and Enable schedule actions. The host checks a later
  user message against the exact proposal, session, revision, and expiry.
  Model-supplied `confirmationText` cannot authorize an action. Reply `yes`
  to a single pending proposal, or `approve <proposal-id>` when several exist.
- Cron routines are configured in Agent Builder and their next/last task state
  and artifacts are reviewed under Agents.
- Pi sessions discover their configured tools automatically. Installing a
  plugin does not grant it to every deployed agent; Agent Builder explicitly
  controls each agent's tool grants.

The target persistent-chat, workflow, persona, cron, and A2A design is defined
in the [agent workspace specification](pi-agent-workspace-spec.md).
The A2A boundary is pinned to the official
[A2A v1.0.1 specification](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)
and advertises the compatible `1.0` wire-protocol version.

## Stream recovery

OpenAI Responses streams use the existing `httpIdleTimeoutMs` setting (five
minutes by default) to bound silence between decoded provider events. Active
responses can run longer than that; each event resets the wait. Explicit
request/provider `timeoutMs` overrides still take precedence. Setting
`httpIdleTimeoutMs` to `0` effectively disables the guard.

A stalled stream is aborted and returned as a retryable error through the
existing bounded retry policy. User cancellation remains non-retryable. A
completed response finishes at its terminal event without waiting for the
connection to close. Stream interruption diagnostics include elapsed and idle
time, event count, last event type, transport codes when available, and a safe
provider request ID. They do not add prompts, tool arguments, headers, or raw
error-cause objects to logs. These details help distinguish timeouts from socket
resets; they do not by themselves establish whether the provider, proxy, or
network caused the interruption.

An interrupted tool call does not establish that a draft was saved. Use
`inspect_agent_build` to check the retained state before continuing.

## Storage

Serve data is stored under `~/.pi/agent/serve` by default. A directory ownership
lock rejects a second live host using that directory before restart recovery.

```text
definitions/<agent-id>.json
agent-builds.json
agent-build-conversations.json
conversations/<conversation-id>/
tasks/<agent-id>/<task-id>/
runs/<agent-id>/<run-id>/run.json
runs/<agent-id>/<run-id>/result.md
runs/<agent-id>/<run-id>/transcript.json
workflows/definitions/<workflow-id>.json
workflows/runs/<workflow-run-id>/run.json
routines/<routine-id>.json
browser/captures/<capture-id>.json
browser/workflows/<workflow-id>/versions/<version>.json
browser/runs/<run-id>.json
browser/artifacts/<owner>/<artifact-id>.png
browser/references/frontend-tests.json
audit/serve-audit.jsonl
```

Definitions and workspace paths are validated before use. Interrupted run
metadata is recovered as failed on the next serve startup; completed artifacts
remain listed and readable.

## Executors

- `harness` creates a fresh child-process `AgentSession` with a dedicated cwd,
  host-mediated path-confined `read`, `list`, and optional `write` tools, and
  only the explicitly granted provider capability adapters.
  It is isolated from the active Pi transcript and other agent processes. It is
  not an OS or container security boundary.
- `session` creates a fresh child-process Pi session with the selected standard tools.
  Use it for trusted interactive local work that needs normal Pi path behavior.

Within one host, agent runs and external connections share a four-run admission
limit and exclude conflicting work in equal or nested project directories.
Concurrent readers are allowed. Stopping one run does not stop unrelated runs.
Separate serve directories and alternate paths through filesystem links are not
covered by this exclusion.

Claude and Hermes connections dispatch directly to their validated backend tool
adapters. Codex uses its CLI adapter; API connections use the Pi session adapter.
There is no extra model turn to choose a backend or rewrite the requested task.
Availability reports installation/authentication readiness; it does not establish
that a model is suitable for a particular workflow. Use representative proofs.

The `session` executor can still enable `bash` or `edit` under a read-only policy.
Use `harness` with only `read` and `list` for bounded file inspection. Cumulative
run budgets are checked after execution and are not hard spending caps. See the
[README limits](../README.md#current-scope-and-limits) and
[security boundary](../README.md#security-boundary) before enabling automation.

## Agent lifecycle

1. Pi chat or Agent Builder progressively stages a durable draft.
2. The user reviews the candidate configuration and its acceptance criteria.
3. A one-time isolated proof run retains its exact configuration, transcript, result, tool evidence,
   and artifacts. Relative dates are anchored to the host time and timezone.
4. Machine-checkable criteria are evaluated as Pass, Fail, or Unverified.
   Configured required empty-source, tool-error, stale-artifact, workspace-mutation, and
   output-contract checks block acceptance. Process completion alone does not
   prove the goal. Host configuration and nonempty-result checks cannot be disabled
   by replacing the custom criteria list.
5. The user accepts or rejects the proof. Rejection retains a 1-5 rating,
   concrete feedback, and up to three focused answers for the next candidate.
6. Explicit activation saves the accepted revision and its effective model.
   Exporting a reusable skill is optional and does not activate a candidate.
7. The user can review and enable automation for an accepted active revision.
   Editing, testing, or rejecting a candidate preserves that active eligibility.

Schedule requests made during drafting are retained as intent only. They do not
create Windows tasks or routines. After activation, the intent repopulates the
routine editor for a final explicit review, or chat can enable the exact
retained intent after confirming the action and timezone.

Interrupted drafts, candidates, feedback, proof prompts, and evaluation state
are restored from `agent-builds.json`. A proof left running by a stopped host is
recovered as failed and returned to Needs refinement; it never activates its
candidate revision.

Completed conversational proposals retain their result for safe replay. An
interrupted authorized proposal becomes failed on restart with any recorded
partial progress. Inspect the build, agent, and routine records before preparing
a replacement; cross-file publication and scheduling are not a database
transaction. Failed writes restore the last persisted in-memory build/proposal
state. Human proof acceptance is retained separately from machine check results.

Older build records without an active proof receipt must be tested, accepted,
and explicitly activated before enabling or re-enabling automation. Skill export
is not inferred to be authorization for activation.

See the [consolidation specification](pi-agent-consolidation-spec.md) for the
implementation plan, verification evidence, and remaining limits.

## Recorded browser workflows

1. Ask Pi or an agent with browser access to open the application.
2. Select Take control, start recording, and perform the walkthrough.
3. Stop recording. Resolve any ambiguous semantic target in the workflow card.
4. Validate the compiled version in a fresh managed Chromium context.
5. Activate the validated version, then run or assign that exact version.

Coordinates are capture evidence only. Replay uses roles, accessible names,
labels, stable IDs, frame identity, and explicit assertions. Typed values become
parameters; passwords and other sensitive values are not stored. Workflows that
require approval cannot run until the caller supplies an explicit approval.

Managed Chromium is the default. Agent Builder can select installed stable
Chrome for compatibility testing, but Pi still creates an isolated browser
context and never opens the user's normal Chrome profile. Named sign-in profiles
are dedicated Pi profiles and permit one live session at a time.

See the [portable browser workflow specification](pi-browser-workflow-spec.md)
for lifecycle, versioning, security, and ECS portability details.

## Companion extensions

- [`pi-agent-builder`](../packages/extensions/pi-agent-builder/README.md) adds the
  `configure_agent` tool and `/persona` command for reusable Markdown agents in
  normal Pi sessions. Persona names are normalized and path-validated before
  fetching or caching. Use Agent Builder in `pi --serve` for routines and
  workflows.
- [`pi-switch-project`](../packages/extensions/pi-switch-project/README.md) adds
  `/cd <path>`, which relaunches Pi in another working directory and resumes the
  persisted session when possible.

## Verification

```sh
npm run check
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/args.test.ts test/serial-operation-queue.test.ts \
  test/agent-registry.test.ts test/agent-run-manager.test.ts \
  test/agent-task-service.test.ts test/cron-schedule.test.ts \
  test/agent-routine-scheduler.test.ts test/persona-catalog.test.ts \
  test/plugin-management-service.test.ts test/serve-agent-services.test.ts \
  test/browser-workflow-registry.test.ts test/browser-workflow-runner.test.ts \
  test/browser-workflow-reference-store.test.ts \
  test/serve-a2a-http.test.ts test/serve-page.test.ts \
  test/websocket-listener.test.ts
```
