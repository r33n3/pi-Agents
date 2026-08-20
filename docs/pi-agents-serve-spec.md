# pi-Agents `--serve` delivery specification

## Goal

`pi --serve` provides a secure local operations console for the active Pi
session and locally deployed Pi agents. It makes agent state, work, artifacts,
and routines visible without creating another writer for Pi session state.

## User experience

The browser console has three stable areas:

1. **Left rail** — separate Sessions and Agents tabs. Sessions may link another
   explicitly supplied local Pi capability URL; no discovery is performed.
2. **Center** — tabbed live Pi sessions, readable conversation scrolling, and
   a composer whose send arrow becomes a red stop control during a turn.
3. **Right workspace** — selected-agent tabs: Overview, Activity, Routines,
   and Builder. Builder separates its conversational Chat from Settings.

Both sidebars are resizable, and the left rail uses a faded calligraphic π
watermark instead of a product-title block.

The conversational builder runs in a browser-owned helper session beside the
persisted form. It does not own execution, scheduling, or artifact rendering.

## Security and lifecycle invariants

- Default bind address is `127.0.0.1`; LAN binding is explicit and warned.
- The omitted port selects the first available port from 4173; an explicit
  `--serve-port` never silently changes.
- Each server process generates one high-entropy capability token.
- HTTP assets and WebSocket access require the capability token.
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
      ├─ AgentRunManager → state, events, artifacts, queue
      └─ AgentExecutor
          ├─ session executor (fresh trusted local Pi session)
          └─ harness executor (fresh workspace-confined AgentSession)
```

`ServeHost` owns authentication, address binding, lifecycle, and browser asset
delivery. `AgentRunManager` owns run state and serialization. Executors own
only launch/abort/event collection. The browser consumes protocol snapshots and
agent-run events; it does not inspect Pi internals or infer process state.

## Agent definition

Persist one definition per agent:

```text
id, name, description, model, tools, memory, persona,
workspace, executor, permissionPolicy, schedules
```

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

## Delivery milestones

1. **Serve foundation**: CLI flags, localhost token, HTTP/WebSocket transport,
   active-session protocol adapter, and server lifecycle.
2. **Live browser client**: bundled PiClient transport, attach current session,
   transcript/model/steer/abort controls, reconnect and clear error state.
3. **Agent workspace**: registry, sidebar, Overview/Activity/Routines/
   Configure tabs, and existing conversational builder migration.
4. **Local execution**: run manager, session executor, isolated harness,
   artifact manifest, cancellation, and cleanup.
5. **Routines**: persisted schedules, next-run computation, run-now,
   enable/disable, and artifact recovery after host restart.
6. **Hardening**: LAN warning policy, process-lifetime token rotation, request
   and connection limits, protocol/agent concurrency tests, path validation,
   and documentation.

## Acceptance criteria

- `pi --serve` launches Pi and a browser URL on localhost without changing
  normal non-serve behavior.
- Browser reconnects and renders the same active session without data loss.
- Prompt, stop, model, and thinking actions operate on the selected live
  session and reject conflicts clearly.
- New Agent opens Builder Chat; Chat and Settings remain independently usable.
- A harness agent run is isolated to its configured workspace and its final
  output/artifacts remain visible after completion and restart.
- Schedules use the same run manager as Run Now; no parallel run can write the
  same agent workspace.
- Full `npm run check` and focused protocol, serve, executor, and schedule
  tests pass.

## Deliberate non-goals for v1

- Remote cloud control, multi-user collaboration, and remote-desktop streaming.
- Arbitrary LAN discovery or unauthenticated pairing.
- Distributed executors across machines.

These can extend the executor and authentication boundaries later without
changing the browser or agent-definition contract.
