# Pi managed browser and Preview workspace specification

Status: in progress — browser foundation, semantic tools, Preview controls,
shared control, live frames, low-latency input, diagnostics, and screenshot evidence complete
Date: 2026-08-21

## Decision

Replace the right-workspace Overview tab with Preview. Preview displays one
real Chromium page that the user and Pi agents can inspect and control. A
managed browser service owns Chromium and Playwright; the rest of Pi sees a
small browser-session interface and does not depend on Playwright objects,
Chrome DevTools Protocol messages, profile paths, or frame encoding. Every
browser session also records its owner workspace, so Browser can later become
one surface of a shared local workspace runtime without changing its owner or
profile contract.

This is a browser surface, not a remote desktop. Pi does not create a cloud VM,
control arbitrary desktop applications, or attach to the user's normal Chrome
profile in this delivery.

Durable recording, semantic compilation, validated replay, assignment, and
local-to-ECS portability follow the
[portable browser workflow specification](pi-browser-workflow-spec.md).
Review, recording, replay intent, and access-scoped session selection follow
the [browser review and recording specification](pi-browser-review-recording-spec.md).

## User outcome

A frontend workflow should read as follows:

1. Start Pi in the project with `pi --serve`.
2. Ask Pi or a deployed agent to start the project's development server.
3. The agent opens the local URL with `browser_open`.
4. Preview switches to that browser session and shows the rendered page.
5. The user watches, scrolls, clicks, types, changes viewport, or takes control.
6. The agent uses semantic browser tools to inspect and test the same page.
7. Console failures, network failures, screenshots, and traces remain attached
   to the owning agent run or Pi session.

The user and agent must never unknowingly operate different browser contexts.

## Product requirements

- Preview replaces Overview and is the default right-workspace tab.
- Preview has Back, Forward, Reload, address, viewport, Take control, Open
  externally, and Expand controls.
- Preview contains Page, Console, Network, and Tests views.
- The Page view is interactive rather than a periodic static screenshot.
- The selected Pi session or agent run owns the selected browser session.
- The browser remains viewable while an agent is working in the background.
- User takeover pauses agent browser actions without aborting the agent run.
- Returning control allows the agent to continue from the current page state.
- Closing an agent run closes its ephemeral browser contexts after artifacts
  are flushed.
- A missing browser installation produces an install action and command, not a
  Pi startup failure.
- Browser capability and installation status appear under Capabilities.

## Designs considered

### A. Iframe preview plus a separate Playwright browser

Pi would embed local development URLs directly and run Playwright separately
for tests. This makes the initial preview simple, but the user and agent obtain
different cookies, storage, navigation, focus, and DOM state. Many external
sites also reject iframe embedding through CSP or `X-Frame-Options`.

This design is rejected because it makes the common debugging question—"am I
looking at what the agent tested?"—unreliable.

### B. Shared managed Chromium surface

Pi owns a Chromium browser context. Playwright performs semantic automation,
while a Chromium frame bridge sends the same page to Preview and accepts user
input. Both user and agent therefore share one source of truth.

This design is selected. Its streaming and input handling are harder, but that
complexity is contained behind `BrowserSessionManager` and does not spread
through agents, routines, or the browser UI.

### C. Desktop webview or Chrome extension

An Electron/WebView2 surface could feel native, and a Chrome extension could
use the user's existing signed-in profile. Both would create a second product
surface and weaken the portability of `pi --serve`, especially over a local
network. They remain possible future adapters to the browser-session contract.

## Architecture

```text
pi --serve
  └─ ServeHost
      ├─ existing Pi session, agents, routines, attachments, ACP
      ├─ BrowserSessionManager
      │   ├─ BrowserDriver (Playwright implementation)
      │   ├─ BrowserPolicy
│   ├─ BrowserProfileStore
│   ├─ BrowserWorkspaceBinding
      │   ├─ BrowserArtifactSink
      │   └─ BrowserFrameBridge (Chromium/CDP implementation)
      ├─ token-gated browser REST routes
      └─ token-gated browser WebSocket channel

Pi/agent browser tools
  └─ BrowserSessionManager public operations

Preview workspace
  ├─ state and commands over REST
  └─ frames, control state, and user input over WebSocket
```

`BrowserSessionManager` is the authoritative owner of browser lifecycle,
session state, owner-workspace binding, control leases, navigation policy,
artifacts, and cleanup.
Callers do not receive Playwright `Browser`, `BrowserContext`, or `Page`
objects.

Before browser work is added, the current `--serve` composition should move
from `main.ts` into `ServeHost`. Its external interface is deliberately small:

```text
ServeHost.start(options) -> { url, port, diagnostics }
ServeHost.close()
```

This extraction is behavior-preserving and gives all serve-owned managers one
shutdown path. Browser code must not add another lifecycle block to `main.ts`.

## Browser-session contract

Conceptual TypeScript interface:

```ts
interface BrowserSessionManager {
  create(request: BrowserSessionRequest): Promise<BrowserSessionSnapshot>;
  list(owner?: BrowserOwner): BrowserSessionSnapshot[];
  get(id: string): BrowserSessionSnapshot | undefined;
  navigate(id: string, url: string, actor: BrowserActor): Promise<void>;
  perform(id: string, action: BrowserAction, actor: BrowserActor): Promise<BrowserActionResult>;
  setControl(id: string, owner: "agent" | "user"): Promise<void>;
  resize(id: string, viewport: BrowserViewport): Promise<void>;
  close(id: string): Promise<void>;
  closeOwner(owner: BrowserOwner): Promise<void>;
  subscribe(id: string, listener: BrowserSessionListener): () => void;
  dispose(): Promise<void>;
}
```

The implementation serializes mutations per page. Read-only snapshots,
console reads, and network reads may run concurrently. `close` is idempotent.

### Session state

```text
id
owner: pi-session | agent-run | external-run
workspace: stable workspace id + resolved root path
status: starting | ready | navigating | failed | closed
controlOwner: agent | user
url, title, canGoBack, canGoForward
viewport: width, height, deviceScaleFactor
profile: ephemeral | named profile id
createdAt, updatedAt
lastError
```

Browser processes are shared for efficiency. Each browser session receives an
independent Playwright context unless it explicitly uses the same named
profile. The default is ephemeral.

For this browser-first delivery, a workspace is the selected local project
root. It is not an OS sandbox and it does not yet create terminal or file
manager surfaces. A later `WorkspaceRuntimeManager` may add those surfaces,
write leases, and container/WSL runtimes while preserving this workspace id.

## Browser tools

The serve runtime contributes these tools to the active Pi session and only to
agents whose definitions enable browser access:

- `browser_open` — create or reuse the owner's browser session and navigate to
  an HTTP(S) URL or an HTML file inside the owner workspace. Workspace files
  are exposed through a private loopback preview server; `file:` navigation
  remains disabled.
- `browser_snapshot` — return a semantic page snapshot with stable element
  references for that snapshot revision.
- `browser_click` — click a semantic element reference.
- `browser_fill` — replace a form value through a semantic reference.
- `browser_press` — send a named keyboard key.
- `browser_screenshot` — capture viewport or full-page evidence.

`browser_type`, `browser_scroll`, `browser_wait`, `browser_console`,
`browser_network`, `browser_trace`, and `browser_close` are later Phase 2
additions, together with run-artifact persistence.

Element references are invalidated after navigation or a new snapshot
revision. Tools must request a fresh snapshot instead of falling back to
arbitrary JavaScript. Raw page evaluation is not included in the initial
delivery.

The tools are created by a tool factory bound to a `BrowserOwner`; they do not
infer ownership from global mutable state. The factory is used for the host Pi
session, browser-owned helper sessions, harness agents, and session agents.

## Agent definition

An agent may add an optional browser policy:

```text
browser:
  access: disabled | loopback | public-web | private-network
  profile: ephemeral | <named-profile-id>
  workspace: inherited-current-project | <workspace-id>
```

Defaults are `disabled`, `ephemeral`, and `inherited-current-project`. Selecting browser tools in Builder
requires selecting a browser access policy. `loopback` is the recommended
frontend-development default and allows loopback URLs only.

The existing filesystem `permissionPolicy` remains independent. Filesystem
write permission does not imply browser permission, and browser permission does
not imply filesystem write permission.

## Preview workspace

The current Overview panel is removed. Preview becomes the first tab:

```text
Preview | Activity | Routines | Capabilities | Builder
```

Preview layout:

```text
┌ Back Forward Reload ─ Address ─ Viewport ─ Take control ─ Expand ┐
├ Page | Console | Network | Tests                                 ┤
│                                                                  │
│                    shared Chromium surface                       │
│                                                                  │
└ status · browser session · owner · control owner ────────────────┘
```

- The right panel may expand from its normal width up to 70 percent of the
  window and collapse back to its saved width.
- Switching chat sessions selects the most recent browser session owned by the
  selected Pi session or agent.
- Creating a browser session may switch to Preview unless the user has disabled
  automatic switching in browser-local preferences.
- Page frames preserve aspect ratio and input coordinates are mapped through
  the rendered viewport transform.
- Console and Network use bounded lists and expose clear/filter controls.
- Tests lists screenshots, traces, and named assertions from the owner run.
- The empty state explains how to install Chromium or asks the agent to open a
  local URL.

## Shared control

Viewing never requires a control lease. Mutating browser input does.

- Agent tools hold a short mutation lease for one operation.
- `Take control` waits for the current operation, then sets the session owner to
  `user`.
- While user control is active, new agent mutations return a typed
  `browser_controlled_by_user` result that instructs the agent to wait.
- `Return to agent` releases user control without changing page state.
- Password, passkey, two-factor, CAPTCHA, and payment steps must be handed to
  the user. User keystrokes during takeover are not copied into chat, traces,
  console logs, or model context.
- Abort closes pending agent operations but does not discard a user-owned
  persistent profile.

## Transport

### REST

All routes require the existing process capability token.

```text
GET    /browser/status
GET    /browser/sessions
POST   /browser/sessions
GET    /browser/sessions/:id
POST   /browser/sessions/:id/navigate
POST   /browser/sessions/:id/control
POST   /browser/sessions/:id/resize
POST   /browser/sessions/:id/close
GET    /browser/sessions/:id/artifacts
GET    /browser/artifacts/:id
```

REST owns commands and recoverable snapshots. It remains usable when the frame
channel reconnects.

### Frame and input channel

`/browser-stream?token=...` is a separate authenticated WebSocket channel. The
Pi binary protocol remains unchanged.

- JSON messages carry subscribe, input, acknowledgement, and error records.
- Binary messages carry encoded page frames with a small versioned header.
- Slow viewers drop new frames once their socket buffer reaches 2 MiB rather
  than allowing an unbounded queue.
- Frame dimensions and encoded size are bounded.
- Reconnect resubscribes using the browser session id and receives a fresh
  state snapshot and keyframe.

`WebSocketListener` should gain a narrow auxiliary-channel registration point.
Browser-specific message parsing stays in `BrowserFrameBridge`.

## Rendering implementation

Playwright `1.62.1` is the proposed exact dependency at the time of this spec.
The implementation must re-check the current supported version and release
notes before modifying package metadata.

- Playwright owns browser launch, contexts, pages, locators, screenshots,
  console, network, downloads, and traces.
- Chromium DevTools Protocol provides the live frame stream and low-level user
  input bridge.
- The Chromium debugging endpoint is never bound to a network interface.
- If CDP screencast proves unstable during the implementation spike, the same
  frame interface may use event-triggered Playwright screenshots as a bounded
  fallback. This does not change callers or the UI protocol.
- Initial delivery supports managed Chromium only. Firefox and WebKit may be
  added through another driver after the contract is stable.

## Installation and configuration

The npm package and browser binary have separate lifecycles.

- Add an exact-pinned `playwright` dependency to `pi-coding-agent`.
- Install package metadata with lifecycle scripts disabled and regenerate the
  coding-agent shrinkwrap through the repository script.
- Add `pi browser status` and `pi browser install chromium` commands.
- `pi browser install chromium` invokes the Playwright version shipped with Pi,
  so the downloaded binary cannot drift from the library.
- `pi --serve` starts normally when Chromium is absent. Preview shows Browser
  unavailable and the install command.
- Browser binaries use Playwright's user cache by default and are not committed
  or copied into Pi run artifacts.

Minimal settings:

```text
serve.browser.enabled: true
serve.browser.maxSessions: 4
serve.browser.remoteControl: false
```

Additional knobs are not added until a demonstrated need appears. A custom
executable path is an advanced setting, not part of the primary UI.

## Persistence and artifacts

```text
~/.pi/agent/serve/browser/
  profiles/<profile-id>/
  sessions/<session-id>/metadata.json
  artifacts/<owner-id>/<artifact-id>/
```

- Ephemeral browser data is deleted at session close.
- Named profiles persist cookies, local storage, IndexedDB, and browser history
  until the user clears the profile.
- Named profiles are separate from normal Chrome/Edge profiles.
- Browser sessions are not automatically relaunched after Pi restarts.
- Metadata from interrupted sessions is recovered as closed with an
  interruption reason.
- Agent-run screenshots, traces, downloads, console failures, and network
  failures are copied or linked into the existing run artifact directory.
- Downloads use an owner-specific artifact directory, never the user's general
  Downloads directory.
- Console and network buffers are capped by count and encoded byte size.

## Security invariants

- Only `http:` and `https:` navigation is accepted. `file:`, `data:`,
  `javascript:`, `chrome:`, extension, and DevTools URLs are rejected.
- URL policy is evaluated after every redirect, not only on the initial URL.
- Loopback, public-web, and private-network policies use resolved addresses and
  defend against DNS rebinding.
- The browser is launched without a remotely reachable debugging port.
- Browser processes inherit an explicit environment allowlist rather than all
  Pi environment variables, so `.env.local` API keys are not exposed to pages.
- The process capability token is never inserted into navigated URLs, browser
  storage, screenshots, or traces.
- Browser control is disabled by default when `--serve-host` is non-loopback.
  Enabling LAN browser control requires an explicit `--serve-browser-remote`
  flag and a startup warning.
- Frame and input channels enforce connection, message, viewport, rate, and
  buffered-byte limits.
- User takeover input is not model-visible.
- Browser profiles are not security boundaries between agents when a named
  profile is deliberately shared. Builder must display that warning.
- Consequential external actions remain subject to agent approval policy; a
  browser capability does not grant permission to publish, purchase, delete,
  send, or modify production systems.

## Failure behavior

- Missing Chromium: Preview remains available with installation guidance.
- Browser crash: affected sessions become failed; one bounded browser-process
  restart is allowed, but actions are not replayed automatically.
- Page crash: session becomes failed and may be explicitly reloaded.
- Frame disconnect: automation continues; Preview reconnects without creating a
  new browser context.
- Slow viewer: frames are dropped and the latest frame wins.
- Navigation timeout: the page remains inspectable and returns a typed timeout.
- User takeover during an agent operation: takeover waits for the current
  serialized mutation rather than interrupting halfway through input.
- Pi shutdown: stop new browser operations, close contexts, flush artifacts,
  close Chromium, then close the serve listener.

## Implementation sequence

### Phase 0 — serve-host boundary

- Extract current `--serve` composition and disposal from `main.ts` into
  `serve-host.ts` without behavior changes.
- Preserve current URL, token, port fallback, agent, routine, ACP, attachment,
  and shutdown behavior.
- Add focused lifecycle tests before adding browser dependencies.

### Phase 1 — browser foundation

- Add the exact Playwright dependency and `pi browser status/install` commands.
- Implement `BrowserPolicy`, `BrowserProfileStore`, driver interface, and
  `BrowserSessionManager` with a fake driver for tests. Every create request
  records an explicit workspace owner id and root path.
- Implement the Playwright Chromium driver and lifecycle cleanup.
- Expose Browser status in Capabilities.

### Phase 2 — semantic agent tools

- Implement owner-bound `open`, `snapshot`, `click`, `fill`, `press`, and
  `screenshot` tools with snapshot reference revisions.
- Inject the core tools into the host session and permitted agent sessions.
- Add browser policy to agent definitions. Builder Settings remains part of
  the next UI slice.
- Bind browser tools to the owner workspace selected for that Pi session or
  agent run; tools may not infer it from process cwd.
- Persist screenshots, traces, downloads, console failures, and network
  failures with run artifacts.

### Phase 3 — Preview workspace

- Replace Overview with the initial Preview surface. This is complete for the
  selected local Pi session: it shows managed-browser availability, the latest
  owner-bound session, and a refreshed viewport screenshot.
- The initial address and Reload controls navigate the selected local Pi
  session through its existing browser policy. The next Preview increment adds
  Back/Forward, Page/Console/Network/Tests views, panel expansion, and the
  remaining browser REST commands.
- Add selection for agent-run and external-run browser owners alongside the
  current selected Pi-session owner.

### Phase 4 — live shared control

- CDP screencast is the primary frame transport, using bounded JPEG frames on
  the authenticated `/browser-stream` WebSocket. HTTP PNG screenshots remain
  the reconnect and compatibility fallback.
- Preview maps pointer and scroll input to the managed viewport and exposes a
  focused-field typing control. Input uses the same WebSocket when connected.
  User takeover and return-to-agent use a control lease; agent semantic
  mutations are paused while the user controls a page.
- User input is sent only to Chromium and is not added to chat, browser
  diagnostics, or tool context.

### Phase 5 — hardening and delivery

- Enforce redirect-aware network policies and DNS resolution checks. This is
  complete for managed request routing.
- Add LAN browser-control opt-in and warnings.
- Add crash recovery, resource ceilings, process leak checks, and artifact
  retention limits. Explicit screenshots from agent/external runs are already
  retained under the serve-owned browser artifact root.
- Run end-to-end frontend build/test scenarios and update user documentation.

Each phase must leave `pi --serve` usable. Phase 4 is required for the final
native shared-browser deliverable; Phases 1–3 are not presented as complete.

## Test plan

### Unit tests

- Browser policy accepts and rejects URL classes and redirect targets.
- Browser manager enforces ownership, limits, serialization, idempotent close,
  and cleanup through a fake driver.
- Control leases prevent user/agent concurrent mutations.
- Snapshot references expire by revision.
- Profile paths and artifact paths cannot escape their owned roots.
- Frame backpressure retains the newest frame and stays within byte limits.

### Focused integration tests

- Start a local fixture site and operate it through the Playwright driver.
- Exercise navigation, form input, scrolling, popup/tab behavior, console
  errors, failed requests, screenshot, download, and trace output.
- Verify the REST and WebSocket channels reject missing or incorrect tokens.
- Verify reconnect preserves the browser context.
- Verify agent abort and Pi shutdown leave no Chromium process or temporary
  profile behind.
- Verify non-loopback serve disables browser control without the explicit flag.

### Browser UI tests

- Preview replaces Overview and is keyboard accessible.
- Resize and Expand preserve usable center chat and restore saved width.
- Coordinate mapping remains correct at multiple viewport and panel sizes.
- Take control, Return to agent, disconnected, crashed, and missing-browser
  states are visible and recoverable.
- Console, Network, and Tests render untrusted strings as text.

### Repository verification

- Run each modified focused test file directly.
- Run `npm run check` with full output.
- Run the repository's non-e2e `./test.sh` only when the implementation reaches
  the cross-package hardening phase or the user requests it.
- Run a manual Windows smoke test from outside the repository using the
  installed `pi` command.

## Acceptance criteria

- `pi --serve` works normally with and without Chromium installed.
- Preview replaces Overview and displays the same Chromium page the agent is
  controlling.
- A user can navigate, click, type, scroll, resize, and take or return control
  without opening another browser window.
- An authorized agent can semantically inspect and test a local frontend and
  return screenshots, console failures, network failures, and traces.
- User takeover blocks agent mutations but preserves the browser and agent run.
- Ephemeral contexts do not share cookies or storage across owners.
- Named profile sharing is explicit and clearly warned.
- Every browser session identifies the workspace that owns its local project
  state, ready for later terminal, file, and isolation-runtime integration.
- Loopback, public, private-network, redirect, and LAN-control policies are
  enforced and covered by tests.
- Pi shutdown leaves no managed browser process running.
- No API key or Pi capability token appears in page state or browser artifacts.
- Focused tests and `npm run check` pass.

## Initial non-goals

- Full remote desktop, terminal, or arbitrary desktop-application control.
- Cloud VM provisioning or background operation after the host machine stops.
- Automatic attachment to the user's normal Chrome or Edge profile.
- Chrome extension distribution.
- Firefox or WebKit live streaming.
- Browser session discovery across unrelated Pi serve processes.
- Automatic CAPTCHA, password, passkey, payment, or two-factor completion.
- Arbitrary page JavaScript evaluation as an agent tool.
