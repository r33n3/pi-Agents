# pi-Agents `--serve` delivery specification

## Goal

`pi --serve` provides a secure local operations console for the active Pi
session and locally deployed Pi agents. It makes agent state, work, artifacts,
and routines visible without creating another writer for Pi session state.

## User experience

The browser console has three stable areas:

1. **Left rail** — Pi sessions and connection management only. A supplied local
   Pi capability URL may link another server; no discovery is performed.
2. **Center** — tabbed live Pi sessions, readable conversation scrolling, and
   a composer whose send arrow becomes a red stop control during a turn.
3. **Right workspace** — Browser, Agents, and Agent Builder tabs. Agents owns
   persistent agent chat and operational history. Agent Builder owns profile,
   persona, model, built-in tools, plugins, MCP/API connections, per-agent
   grants, workflows, and cron automation. Browser follows the
   [managed-browser design](pi-browser-preview-spec.md).

Both sidebars are resizable, and the left rail uses a faded calligraphic π
watermark instead of a product-title block.

The consolidated agent workspace, registry, persistent-task model,
orchestration, persona catalog, cron scheduling, and A2A boundary follow the
[agent workspace specification](pi-agent-workspace-spec.md).

## Security and lifecycle invariants

- Default bind address is `127.0.0.1`; LAN binding is explicit and warned.
- The omitted port selects the first available port from 4173; an explicit
  `--serve-port` never silently changes.
- Each server process generates one high-entropy capability token.
- HTTP assets and WebSocket access require the capability token.
- Plugin install/update, connection authentication, and agent-grant mutations
  require explicit user approval and validated host operations.
- The active Pi session has exactly one writer. Browser commands operate on the
  host session; they never spawn a second session process or rewrite its JSONL.
- A per-agent run owns one executor lease. Abort waits for process cleanup
  before the workspace can be reused.
- Paths for agent workspaces and artifacts are validated against their owned
  root before filesystem access.

## Architecture

```text
CLI --serve
  └─ ServeHost
      ├─ CurrentSessionService → active AgentSession
      ├─ WebSocket/HTTP listener → browser PiClient
      ├─ AgentRegistry → persisted AgentDefinition records
      ├─ AgentTaskService → conversations, tasks, events, artifacts, queue
      ├─ WorkflowService → sequential, parallel, and supervisor orchestration
      ├─ CronRoutineService → schedule calculation and task submission
      ├─ A2AAdapter → optional authenticated external task mapping
      ├─ BrowserSessionManager → managed Chromium, workspace binding, shared control, evidence
      └─ AgentExecutor
          ├─ session executor (fresh trusted local Pi session)
          └─ harness executor (fresh workspace-confined AgentSession)
```

`ServeHost` owns authentication, address binding, lifecycle, and browser asset
delivery. `AgentTaskService` owns persistent conversations and task lifecycle.
Executors own only launch, abort, and event collection. Workflows, cron, Pi,
Agent Builder, and A2A submit through the same task contract. The browser
consumes snapshots and events; it does not inspect Pi internals or infer state.
Each browser session carries the owning local project workspace id and root,
which is the compatibility seam for the later terminal/file/container runtime.

## Agent definition

Persist one definition per agent:

```text
id, revision, name, description, image, persona, model, thinking,
projectRoot, tools, executor, permissionPolicy, delegateAgentIds, a2a, browser
```

`browser` is optional and defaults to disabled. When enabled it declares the
agent's navigation scope and ephemeral or named managed Chromium profile.

Runtime state is separate and ephemeral/persisted by run: status, timestamps,
exit status, transcript pointer, tool activity, and artifact manifest.

## Executor contract

```text
start(definition, request) -> run
abort(runId)
subscribe(runId, listener) -> unsubscribe
dispose(runId)
```

The session executor is for intentional trusted local delegation. The harness
executor creates a fresh in-process session with a dedicated cwd, confined tool
policy, transcript, and artifact root. This harness is a Pi state/workspace
isolation boundary, not an OS sandbox. Both report the same run and artifact
model.

## Delivery slices

1. **Workspace navigation**: Browser/Agents/Agent Builder consolidation.
2. **Registry and personas**: catalog images, structured definitions, registry
   events, and Pi `agent_deploy`.
2A. **Plugins and grants**: capability projection, explicit lifecycle approval,
   and per-agent tool grants.
3. **Persistent execution**: conversations, tasks, attempts, cancellation,
   recovery, and artifacts.
4. **Cron automation**: presets, five-field cron, timezone, previews, timeout,
   and routine actions.
5. **Workflows**: sequential, parallel, and supervisor orchestration.
6. **A2A boundary**: authenticated opt-in A2A v1.0 HTTP+JSON operations.
7. **Hardening and docs**: concurrency leases, path validation, browser checks,
   operator documentation, and restart coverage.

The managed browser remains a foundational console capability. It provides
isolated Chromium sessions, semantic browser tools, shared user/agent control,
browser evidence, and browser-specific LAN policy. See the
[managed-browser specification](pi-browser-preview-spec.md).

## Acceptance criteria

- `pi --serve` launches Pi and a browser URL on localhost without changing
  normal non-serve behavior.
- Browser reconnects and renders the same active session without data loss.
- Prompt, stop, model, and thinking actions operate on the selected live
  session and reject conflicts clearly.
- The right workspace exposes only Browser, Agents, and Agent Builder.
- Agents deployed by Pi or Agent Builder appear without a server restart and
  open a persistent chat when selected.
- A harness agent run is isolated to its configured workspace and its final
  output/artifacts remain visible after completion and restart.
- Chat, Pi delegation, cron, workflows, and A2A use the same task service; no
  parallel task can mutate the same agent project root by default.
- A2A Agent Cards, version negotiation, HTTP operations, payloads, task states,
  errors, and streaming pass tests derived from the tagged `v1.0.1` protocol
  definition while advertising protocol version `1.0`.
- Full `npm run check` and focused protocol, serve, executor, and schedule
  tests pass.

## Deliberate non-goals for v1

- Remote cloud control and multi-user collaboration.
- Full remote-desktop or arbitrary desktop-application streaming. The managed
  browser streams only its owned Chromium page.
- Arbitrary LAN discovery or unauthenticated pairing.
- Distributed executors across machines.

These can extend the executor and authentication boundaries later without
changing the browser or agent-definition contract.
