# pi-Agents local console

Run Pi interactively with its authenticated local browser console:

```sh
pi --serve
pi --serve --serve-port 4174
pi --serve --serve-host 127.0.0.1
```

Pi prints a process-scoped capability URL. HTTP resources and the binary
WebSocket protocol require its token. Without `--serve-port`, Pi starts at 4173
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
- The right workspace contains Browser, Agents, and Agent Builder. Selecting an
  agent opens its persistent chat and its manual, scheduled, and workflow run
  history. Agent Builder owns Profile, Runtime, Capabilities, Delegation, and
  Automation for one agent.
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
- Agents deployed through Pi and Agent Builder share one registry and appear
  without restarting the serve host.
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

## Storage

Serve data is owned by `~/.pi/agent/serve`:

```text
definitions/<agent-id>.json
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

- `harness` creates a fresh child-process `AgentSession` with a dedicated cwd
  and host-mediated, path-confined `read`, `list`, and optional `write` tools.
  It is isolated from the active Pi transcript and other agent processes. It is
  not an OS or container security boundary.
- `session` creates a fresh child-process Pi session with the selected standard tools.
  Use it for trusted interactive local work that needs normal Pi path behavior.

Both executor forms use isolated run queues and deterministic process-tree
termination. Chat, Pi delegation, routine, workflow, and A2A tasks cannot
overlap while mutating one agent project root, and stopping one run does not
stop unrelated agents or Pi sessions.

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
