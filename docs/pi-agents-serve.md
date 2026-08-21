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
- New Agent opens Builder with separate Chat and Settings tabs. The chat uses
  an isolated helper session while Settings owns the persisted definition.
- Preview replaces Overview and, when the managed-browser milestone is
  installed, shows the same Chromium page controlled by the user and agent.
  See the [managed-browser specification](pi-browser-preview-spec.md) for the
  implementation contract.
- Activity launches and aborts local agents. Completed results link to their
  persisted artifact.
- Routines show enabled interval schedules and their next/last run state.

## Storage

Serve data is owned by `~/.pi/agent/serve`:

```text
definitions/<agent-id>.json
workspaces/<agent-id>/
runs/<agent-id>/<run-id>/run.json
runs/<agent-id>/<run-id>/result.md
runs/<agent-id>/<run-id>/transcript.json
```

Definitions and workspace paths are validated before use. Interrupted run
metadata is recovered as failed on the next serve startup; completed artifacts
remain listed and readable.

## Executors

- `harness` creates a fresh in-process `AgentSession` with a dedicated cwd and
  path-confined `read`, `list`, and optional `write` tools. It is isolated from
  the active Pi transcript and from other agent workspaces. It is not an OS or
  container security boundary.
- `session` creates a fresh local Pi session with the selected standard tools.
  Use it for trusted interactive local work that needs normal Pi path behavior.

Both executor forms use the same single-lease run manager. Manual and routine
runs cannot overlap for one agent workspace, and abort waits for the session to
become idle before releasing the lease.

## Verification

```sh
npm run check
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/args.test.ts test/serial-operation-queue.test.ts \
  test/agent-registry.test.ts test/agent-run-manager.test.ts \
  test/agent-routine-scheduler.test.ts test/serve-page.test.ts \
  test/websocket-listener.test.ts
```
