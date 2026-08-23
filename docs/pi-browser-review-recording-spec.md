# Pi browser review, recording, and replay specification

Status: approved for implementation
Date: 2026-08-23

## Goal

Pi and deployed agents can review local or public webpages, record user actions
when explicitly requested, and replay saved workflows without confusing those
three operations. Local preview remains the safe default. Public-web browsing
uses a separate browser context and never expands the network reach of a local
preview context.

This specification narrows the interaction and access-routing behavior already
defined by the managed-browser and portable-workflow specifications. It does
not introduce a second workflow format or browser runtime.

## Problem

The current Pi session receives browser tools fixed to `loopback` access. It
can review a workspace HTML file but cannot open Google or another public site.
Recording is exposed in the Browser UI but not as a model-facing operation.
When the user asked Pi to browse Google and save the actions, Pi selected an
existing generated workflow skill and replayed its unrelated local fixture.
That run completed successfully, so the result was technically correct for the
selected workflow but wrong for the user's intent.

The invalid trace was:

```text
record a new Google flow
  -> list existing workflows
  -> replay browser-workflow-1348a28b
  -> open /missing-fixture
  -> report success
```

The system must make the reasonable interpretation of review, record, and
replay unambiguous to Pi, agents, and users.

## User outcomes

### Immediate review

```text
ask Pi to review a local page or public URL
  -> create or reuse an access-compatible browser session
  -> inspect the page and gather bounded evidence
  -> discuss findings
  -> do not create a workflow
```

### User recording

```text
open page
  -> start a new recording
  -> take control
  -> perform browser actions
  -> stop recording
  -> compile a new workflow draft
  -> validate and activate explicitly
```

### Saved replay

```text
request a named workflow and version
  -> verify the assignment or workspace grant
  -> replay the immutable version in an isolated context
  -> report the exact run and step evidence
```

### Delegated browser QA

Pi may delegate a sustained review to one browser-enabled agent. Multi-agent
coordination remains appropriate only when the task requires distinct roles,
such as design, accessibility, and functional testing. Delegation does not
change browser access or workflow grants.

## Invariants

- Review, recording, and replay are distinct operations and tool names.
- Recording never selects or runs an existing workflow.
- Replay never starts or modifies a recording.
- A recording compiles into a new workflow draft; it does not overwrite an
  active version.
- Pi defaults to loopback access for local files and loopback URLs.
- Public URLs use a separate `public-web` browser session.
- Public-web contexts cannot resolve or navigate to loopback, link-local, or
  private-network addresses.
- Loopback contexts cannot navigate to public sites.
- Agents receive only the access class configured in their definition.
- Saved workflows retain their required access class and run through the
  canonical workflow runner.
- User takeover input remains outside model context.
- Consequential browser actions still require the normal approval boundary.

## Designs considered

### A. Change an owner's browser policy in place

Pi would begin with loopback access and elevate the same context to public-web
when needed. This preserves cookies and page state, but a public page would then
share a context whose earlier or later navigation may reach local services. It
also makes policy changes part of browser history and capture semantics.

This design is rejected. The convenience is not worth weakening the network
boundary or making a session's access depend on its navigation history.

### B. Separate sessions per access class

The browser tool factory receives an explicit set of access grants. Opening a
target selects the required access class and creates or reuses only a session
with that exact class. Pi receives loopback and public-web grants; an agent
receives only its configured grant.

This design is selected. Session selection is slightly more involved inside
the tool factory, but callers keep one browser interface and each Chromium
context has one immutable, auditable network policy.

## Tool contract

### Review and navigation

`browser_open` opens a page for inspection. It does not record or replay.

Input:

```text
url: absolute HTTP(S) URL or workspace HTML path
access: optional loopback | public-web | private-network
```

The access override is accepted only when the owner already has that grant.
When omitted, Pi selects the narrowest granted class compatible with the
target. Workspace paths always require a class that permits loopback.

Subsequent snapshot, click, fill, press, and screenshot operations select the
most recently used active session for the owner unless `sessionId` is given.

### Recording

`browser_record_start` starts a new capture on an active owner-bound browser
session. It refuses a session that is already recording.

`browser_record_stop` stops the active capture and deterministically compiles
it into a new workflow draft. The result returns the capture ID, workflow ID,
version, status, required access, compile issues, and a readable step summary.

These operations do not validate, activate, assign, or replay the workflow.

### Replay

`browser_workflow_validate` and `browser_workflow_run` operate only on an
explicit workflow ID and version. Their descriptions and prompt guidance must
state that they are not recording operations. Pi must not list workflows as a
precursor to a new recording unless the user separately asks to inspect saved
workflows.

## Access selection

The browser tool factory owns target classification and session reuse:

1. A workspace path is served by the workspace preview server and uses
   loopback-compatible access.
2. `localhost`, `*.localhost`, `127.0.0.0/8`, and `::1` use loopback-compatible
   access.
3. Literal RFC1918, link-local, or private IPv6 destinations require
   private-network access.
4. Other HTTP(S) hosts use public-web access.
5. DNS resolution and every browser request remain subject to `BrowserPolicy`.

An IP literal is checked against the same resolved-address rules as a hostname.
It cannot bypass the public-web private-address restriction.

Pi receives `[loopback, public-web]`. It does not receive private-network access
implicitly merely because the console is reachable on the LAN. An agent gets
the single access class selected in Agent Builder.

## Session selection

An owner may have more than one active browser session. Reuse requires all of:

- same owner;
- same access class;
- same runtime;
- same profile identity; and
- ready or navigating status.

Opening a public site therefore cannot reuse a local preview context. Returning
to a local page selects the earlier loopback session when it remains active.

## UI behavior

The established `Browser | Agents | Agent Builder` layout does not change.

- Browser status distinguishes `Reviewing`, `Recording`, and `Replaying`.
- Record is enabled only for an active browser session.
- Stop recording exposes the newly compiled draft rather than an existing
  workflow.
- Disabled controls explain the missing prerequisite.
- Agent-owned browser sessions remain selectable in the same Browser panel.
- A workflow card exposes replay only after validation and activation rules are
  satisfied.

No new permanent panel or layout mode is required.

## Failure behavior

- Public target without a public-web grant: fail before browser creation and
  identify the missing access class.
- Private target from a public-web context: block before navigation.
- Recording requested without an active browser: instruct the caller to open
  the page first.
- Duplicate recording: preserve the active capture and return its session
  state.
- Stop requested without recording: do not create an empty workflow.
- Browser close or process restart during capture: persist an interrupted
  capture, never an active workflow.
- Compilation ambiguity: persist `needs-input`; do not validate or replay.
- Replay request without an explicit ID and version: reject it.

## Persistence

The existing capture, workflow, validation, run, and artifact stores remain
authoritative. Access-scoped live browser sessions are ephemeral. Captures and
compiled definitions survive restart under the existing serve-owned browser
root. No public URL, capture, or workflow changes the process capability token
or server bind configuration.

## Implementation slices

1. Add multi-grant access selection and exact-policy session reuse to the
   browser tool factory.
2. Give Pi and Pi helper sessions loopback plus public-web grants while keeping
   agent grants unchanged.
3. Add model-facing recording start and stop/compile operations.
4. Strengthen review, record, and replay tool descriptions so intent does not
   route to the wrong operation.
5. Fix public-web IP-literal validation so private addresses cannot bypass DNS
   checks.
6. Add focused tool, policy, Pi composition, agent composition, and recording
   tests.
7. Validate local review, public review, user-controlled recording, Pi replay,
   and agent replay against live managed Chromium.

## Test plan

### Unit and integration

- Local paths and loopback URLs select loopback sessions.
- Public URLs select separate public-web sessions.
- Returning to loopback reuses the previous loopback session.
- Explicit ungranted access fails before browser creation.
- Public-web rejects literal and resolved private addresses.
- Agent browser tools cannot exceed the definition's access grant.
- Starting and stopping a recording creates a new compiled workflow.
- Recording operations never call workflow list or workflow run.
- Workflow replay uses the recorded workflow's required access.
- Interrupted recordings recover as interrupted after restart.

### Live flow

1. Start `pi --serve` with managed Chromium.
2. Ask Pi to review a local fixture and confirm loopback access.
3. Ask Pi to open a public page and confirm a separate public-web session.
4. Use the Browser panel to take control and start recording.
5. Perform at least one semantic interaction and stop recording.
6. Validate and activate the resulting workflow.
7. Replay the exact version through Pi.
8. Assign the exact version to a browser-enabled agent and replay it through
   an agent chat or task.
9. Confirm the local preview still works after public-web activity.
10. Restart Pi and confirm the saved workflow remains available.

## Acceptance criteria

- The previously observed Google request cannot replay an unrelated workflow.
- Pi can review both local and public pages without combining their network
  policies in one browser context.
- A user can record actions through shared takeover and receive a new workflow
  draft.
- The saved version can be validated, activated, and run by Pi.
- An explicitly authorized agent can run the same saved version.
- Local preview still works after the public review and replay.
- Security, persistence, focused tests, `npm run check`, and the live browser
  flow pass before completion is reported.

## Non-goals

- Attaching to the user's normal Chrome profile.
- Recording arbitrary desktop or terminal activity.
- Giving Pi implicit private-network access.
- Automatically activating or assigning a new recording.
- Inferring that any request containing “save” means workflow replay.
- Changing the established console layout.
