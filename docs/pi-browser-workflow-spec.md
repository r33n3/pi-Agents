# Pi portable browser workflow specification

Status: implemented locally; ECS runtime remains backlog
Date: 2026-08-23

## Goal

Pi Agents can record a user's actions inside the managed browser, convert the
recording into a stable semantic workflow, validate it by replaying it, and
then run the same workflow through Pi, a deployed agent, a skill, a routine, a
larger agent workflow, or a future ECS browser worker.

The workflow is the authoritative executable artifact. Skills, routines,
agents, and cloud jobs reference it rather than copying its browser steps.
The distinction between immediate review, new recording, and saved replay is
defined by the
[browser review and recording specification](pi-browser-review-recording-spec.md).

## User outcome

A user building or automating a web application can:

1. Open the application in Pi's managed browser.
2. Take control and select Record.
3. Perform the task as they would in Chrome.
4. Stop recording and review detected entry conditions, parameters, actions,
   and completion checks.
5. Resolve any ambiguous targets or missing values.
6. Test the proposed workflow against the live application.
7. Save the validated workflow and choose Run with Pi, Assign to agent,
   Create skill, Add to routine, or Use as frontend test.
8. Inspect each later run, including progress, screenshots, failures, and the
   exact workflow version used.

The common path is visual and compact. Users do not edit JSON unless they open
an advanced definition view.

## Product decisions

- Browser recording applies only to managed-browser interactions. Terminal,
  filesystem, API, MCP, and desktop actions remain separate workflow nodes or
  tool calls.
- A recording is evidence, not executable automation. It becomes executable
  only after compilation and a successful validation replay.
- Coordinates are retained as diagnostic evidence but are never executable
  selectors.
- The portable workflow does not encode a local process, Chrome installation,
  AWS task, or storage backend.
- Managed Chromium is the default capture, validation, and execution runtime.
- A dedicated persistent browser profile may supply authenticated state.
  Pi never attaches to the user's normal Chrome profile.
- An optional installed-Chrome runtime provides local compatibility
  testing. It uses a dedicated Pi profile and the same workflow contract.
- Future ECS execution uses the same workflow and a different runtime and
  persistence adapter.

## Designs considered

### A. Generate independent skills and routines from each recording

Each destination would receive copied browser instructions. This is initially
fast, but selector repair, validation, versioning, security, and evidence would
diverge across Pi, agents, skills, routines, and ECS.

This design is rejected because a browser change would require repairing
several copies of the same automation.

### B. Canonical browser workflow referenced by every destination

One versioned workflow owns entry conditions, semantic actions, assertions,
parameters, and validation evidence. Pi, agents, skills, routines, larger
workflows, and ECS submit executions through one runner contract.

This design is selected. It adds a deliberate compilation step, but contains
browser-specific complexity behind one stable interface and makes execution
portable.

## Lifecycle

```text
recording -> draft -> compiled -> validating -> validated -> active
                         |             |
                         v             v
                    needs-input      invalid

active -> superseded | disabled
```

- `recording` is bounded, in-memory capture attached to one browser session.
- `draft` persists the raw capture and page evidence.
- `compiled` has a valid schema and no unresolved target or parameter.
- `validating` is executing in an isolated validation context.
- `validated` passed every step and completion assertion and may be run
  interactively.
- `active` is explicitly enabled for assignment and unattended execution.
- `needs-input` identifies concrete ambiguity the user must resolve.
- `invalid` retains failure evidence and cannot execute unattended.
- Editing an active workflow creates a new draft version. It does not mutate
  the active version in place.

Only `active` versions may be assigned to agents or run by routines.
Interactive Pi may run a validated version or test a compiled draft through
the explicit validation operation.

## Canonical definition

The persisted format is `pi.browser-workflow.v1`. The following TypeScript is
conceptual; implementation types and runtime validation must be authoritative.

```ts
interface BrowserWorkflowDefinition {
  schema: "pi.browser-workflow.v1";
  id: string;
  version: number;
  name: string;
  description: string;
  status: "draft" | "needs-input" | "compiled" | "validated" | "active" | "superseded" | "invalid" | "disabled";
  entry: BrowserWorkflowEntry;
  parameters: BrowserWorkflowParameter[];
  steps: BrowserWorkflowStep[];
  completion: BrowserAssertion[];
  requirements: BrowserWorkflowRequirements;
  policy: BrowserWorkflowPolicy;
  source: BrowserWorkflowSource;
  createdAt: number;
  updatedAt: number;
}
```

### Entry point

The entry point stabilizes where execution begins and proves that the expected
page is ready before actions start.

```ts
interface BrowserWorkflowEntry {
  urlTemplate: string;
  allowedOrigins: string[];
  ready: BrowserAssertion[];
  reset?: BrowserResetStrategy;
}
```

- `urlTemplate` may contain declared parameters such as
  `/projects/${projectId}/settings`; undeclared substitutions fail validation.
- `allowedOrigins` is explicit and is checked after redirects and for every
  subresource according to the selected browser access policy.
- `ready` should identify stable page landmarks: URL pattern, title, heading,
  accessible control, or application-defined marker.
- `reset` may clear workflow-owned storage, navigate to a reset route, or call
  a separately authorized setup operation. It cannot contain arbitrary shell
  commands or page JavaScript.

Opening a URL is not by itself proof that the correct application state
loaded.

### Parameters

```ts
interface BrowserWorkflowParameter {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "url" | "choice" | "secret-ref";
  required: boolean;
  choices?: string[];
  default?: string | number | boolean;
  sensitive: boolean;
}
```

- Typed recording values become named parameters; their literal contents are
  not persisted in raw capture, snapshots, chat, or artifacts.
- Secrets use provider-owned references. A workflow never stores a password,
  API key, session token, one-time code, or secret value.
- Parameter values are validated before browser launch.

### Semantic targets

```ts
interface BrowserTarget {
  frame: BrowserFrameTarget[];
  candidates: BrowserLocatorCandidate[];
  expected: BrowserElementExpectation;
}

type BrowserLocatorCandidate =
  | { kind: "role"; role: string; name: string; exact: boolean }
  | { kind: "label"; text: string; exact: boolean }
  | { kind: "test-id"; value: string }
  | { kind: "id"; value: string }
  | { kind: "text"; text: string; exact: boolean };
```

Locator priority is role and accessible name, label, stable test ID, stable
ID, then bounded text. Generated CSS or XPath paths and viewport coordinates
may appear only in capture evidence.

The compiler rejects:

- locators that match zero or multiple visible actionable elements;
- generated framework IDs or unstable class-name chains;
- text selectors containing recorded secrets or volatile user data;
- targets outside the declared frame or popup context; and
- fallback candidates that identify materially different elements.

Shadow roots, iframes, new tabs, dialogs, and popups are represented as
explicit context boundaries rather than hidden inside a selector string.

### Steps and assertions

Initial executable actions are:

```text
navigate, click, fill, select, press, scroll-to, wait, assert
```

Each mutating step contains:

```text
id
action
target when applicable
parameter or non-sensitive constant when applicable
preconditions
postconditions
timeoutMs
evidence policy
```

Assertions support:

```text
URL matches, title matches, element visible, element hidden,
element enabled, element value, text visible, page ready, download produced
```

Network-idle is not sufficient as the only readiness or completion condition.
Applications with long-lived connections may never become network-idle.

## Capture contract

The recorder captures evidence immediately around each user interaction:

1. Current URL, title, viewport, tab, frame chain, and browser profile class.
2. A semantic snapshot before the interaction.
3. The element under the pointer and its accessible role, name, label,
   attributes, visibility, and bounding box.
4. The user action with sensitive values redacted.
5. A semantic snapshot after the interaction settles.
6. Observed URL, tab, dialog, download, and visible-state transitions.
7. A screenshot reference before and after when the evidence policy requires
   it.

Repeated scroll and typing events are coalesced. Pointer movement is not
recorded. Password, passkey, CAPTCHA, payment, and two-factor interactions are
recorded only as explicit user-handoff boundaries.

Capture is limited by step count, duration, artifact bytes, and browser
session. Switching browser sessions stops the recording and preserves a draft.

## Compilation

`BrowserWorkflowCompiler` owns the conversion from capture evidence to a
portable definition.

Compilation has two layers:

1. Deterministic analysis generates locator candidates, detects parameters,
   validates entry conditions, coalesces events, and reports ambiguity.
2. Pi may propose names, descriptions, assertions, or candidate rankings, but
   model output is untrusted and must pass the same schema, security, and live
   uniqueness validation.

The compiler never invents a successful target after an ambiguous click. It
returns `needs-input` with the screenshot, nearby semantic elements, and a
specific selection request.

## Validation and replay

Validation runs the compiled workflow through `BrowserWorkflowRunner` in a new
managed context unless the workflow explicitly requires a named profile.

For every step, the runner:

1. Checks cancellation and the execution deadline.
2. Revalidates the current page identity and allowed origin.
3. Resolves semantic candidates in priority order.
4. Requires exactly one visible compatible target.
5. Captures pre-action evidence.
6. Executes one bounded browser operation.
7. Waits for declared postconditions.
8. Captures result evidence and emits progress.

The runner stops on ambiguity, policy failure, unexpected navigation, missing
parameter, failed assertion, user takeover, or browser crash. It never falls
back to a recorded coordinate.

A validation result records the workflow digest, runtime version, Chromium
version, viewport, profile class, timestamps, step results, artifacts, and
failure. Validation is invalidated when executable workflow content changes.

## Runtime boundary

```ts
interface BrowserWorkflowRunner {
  validate(request: BrowserWorkflowValidationRequest): Promise<BrowserWorkflowRun>;
  run(request: BrowserWorkflowRunRequest): Promise<BrowserWorkflowRun>;
  cancel(runId: string): Promise<void>;
  subscribe(runId: string, listener: BrowserWorkflowRunListener): Unsubscribe;
}

interface BrowserRuntime {
  create(request: BrowserRuntimeRequest): Promise<BrowserRuntimeSession>;
  dispose(): Promise<void>;
}
```

The runner owns workflow semantics. A runtime owns browser launch, context,
input, snapshots, screenshots, downloads, and cleanup. Callers never receive
Playwright or CDP objects.

Supported runtime classes are:

- `managed-ephemeral` — pinned Chromium and clean context; default.
- `managed-persistent` — pinned Chromium and a dedicated named Pi profile.
- `local-chrome` — compatibility runtime using installed stable Chrome
  and a dedicated Pi profile.
- `ecs-managed` — future container runtime using pinned Chromium and external
  profile, secret, event, and artifact providers.

Runtime selection is an execution binding. It does not change or fork the
workflow definition.

## Integration with Pi, agents, skills, routines, and workflows

The host exposes high-level operations:

```text
browser_workflow_list
browser_workflow_get
browser_workflow_validate
browser_workflow_run
browser_workflow_cancel
```

- Pi may validate or run workflows authorized for its current workspace.
- Agent definitions receive explicit browser-workflow grants. Browser tool
  permission alone does not grant every stored workflow.
- A generated skill contains usage guidance and calls a workflow by stable ID
  and version constraint; it does not copy the steps.
- A routine may target one active browser workflow and provide non-secret
  parameters plus secret references.
- A larger sequential, parallel, or supervisor workflow may include a browser
  workflow node and consume its typed result and artifacts.
- “Use as frontend test” attaches the workflow to the current project and
  makes validation available to Pi during implementation and review.

Assignments pin a workflow version or declare an explicit compatible version
range. Publishing a new version never silently changes a running task.

## Browser UI

The Browser toolbar retains compact icon controls with accessible labels and
tooltips. Stop recording opens a compact automation sheet containing:

```text
Name
Starting page
Detected parameters
Ambiguous steps requiring attention
Completion check
Test workflow
Save draft
Activate after successful test
Run with Pi | Assign to agent | Create skill | Add to routine | Frontend test
```

Workflow cards display Draft, Needs input, Testing, Validated, Active,
Disabled, or Failed. The default view shows a readable step summary; advanced
view shows the canonical definition and validation evidence.

Mobile and fold layouts use the existing full-height side workspace. The
automation sheet must not require horizontal scrolling, and browser controls
remain icon-first with tooltips or accessible names.

No button is displayed until its operation is connected. Disabled operations
explain the missing prerequisite through their tooltip or adjacent status.

## Persistence and restart recovery

```text
~/.pi/agent/serve/browser/
  workflows/<workflow-id>/
    metadata.json
    versions/<version>.json
    captures/<capture-id>/capture.json
    validations/<validation-id>/result.json
    runs/<run-id>/run.json
    artifacts/<run-id>/
```

- Definitions and state replacements use temporary files plus atomic rename.
- Captures and run events are append-only, bounded records.
- Startup marks interrupted capture, validation, and execution records with an
  explicit interruption result.
- Completed workflow versions and evidence survive `pi --serve` restart.
- Persistent profile storage remains owned by `BrowserProfileStore`; workflow
  definitions store only profile requirements or references.
- Deleting a workflow uses an explicit operation and refuses deletion while a
  referenced routine or agent assignment exists. Disable remains available.

## Local-to-ECS portability

The initial implementation is local, but the execution contract accepts a
transport-neutral job envelope:

```ts
interface BrowserWorkflowJob {
  workflowId: string;
  version: number;
  parameters: Record<string, unknown>;
  profileRef?: string;
  secretRefs: Record<string, string>;
  deadline: number;
  correlation: BrowserWorkflowCorrelation;
  artifactDestination: string;
}
```

An ECS worker will:

1. Receive an authenticated job from the session broker.
2. Load the immutable workflow version and verify its digest.
3. Resolve Secrets Manager and encrypted profile references without returning
   their values to Pi or the browser UI.
4. Launch the image-pinned Chromium runtime as a non-root user.
5. Apply domain egress policy, CPU, memory, storage, and execution limits.
6. Stream bounded progress events and persist screenshots and results outside
   the disposable task.
7. Close the browser, erase ephemeral state, and publish one terminal result.

Sites that require a fixed source IP use an approved NAT gateway or proxy.
Workflows do not capture or replay HTTP authentication headers. Chrome creates
normal headers for the runtime environment.

The first local delivery must not import AWS SDKs or encode ECS decisions in
the workflow runner. ECR image construction, ECS orchestration, session-broker
authentication, and cloud artifact providers remain a later deployment slice.

## Security invariants

- Workflow, capture, profile, validation, run, and artifact paths resolve
  beneath their owned roots.
- All console operations require the existing capability token. Future cloud
  execution requires user authentication in front of the internal token.
- Allowed origins and browser access policy apply to navigation, redirects,
  popups, frames, workers, and subresources.
- Literal secrets and typed sensitive values never enter definitions,
  captures, screenshots intended for model review, chat prompts, events, or
  artifacts.
- Named profiles are explicit grants and are not isolation boundaries when
  deliberately shared.
- Workflows cannot execute arbitrary JavaScript, shell commands, filesystem
  paths, or unregistered tools.
- Recording a consequential action does not pre-authorize publishing,
  purchasing, sending, deleting, production changes, or other external side
  effects. Execution uses the agent's approval policy.
- CAPTCHA, passkey, payment, password, and two-factor steps require user
  takeover and cannot run unattended.
- Workflow run events contain bounded summaries and artifact references, not
  unrestricted page content.
- Installed Chrome compatibility mode never opens the user's normal Chrome
  profile and never exposes a remote debugging port.

## Failure behavior

- Browser unavailable: preserve the draft and show the exact install action.
- Ambiguous target: stop and request selection; do not guess or use coordinates.
- Entry assertion failed: report the observed page identity and stop before
  mutations.
- Unexpected origin or popup: block it and attach policy evidence.
- Missing parameter or secret reference: fail before browser launch.
- Validation failed: keep the previous active version unchanged.
- User takeover: pause at a step boundary and resume only after control returns
  and page identity is revalidated.
- Browser crash: record interruption evidence; do not replay a mutating step
  automatically.
- Serve restart: recover interrupted records as failed or interrupted, never
  as still running.
- ECS worker loss: the broker records a terminal infrastructure failure; a
  retry is a new attempt with a new run ID.

## Implementation slices

### Slice 1 — workflow contract and registry

- Add runtime-validated `pi.browser-workflow.v1` types.
- Implement `BrowserWorkflowRegistry`, atomic version persistence, lifecycle
  validation, digests, references, and restart recovery.
- Add focused schema, path, version, and recovery tests.

### Slice 2 — semantic capture

- Replace coordinate-only recording with before/after semantic snapshots,
  target evidence, context boundaries, transitions, and redacted parameters.
- Persist bounded draft captures when recording stops or browser selection
  changes.
- Add click, fill, navigation, scroll coalescing, popup, iframe, and redaction
  tests using a local fixture application.

### Slice 3 — compiler and ambiguity resolution

- Implement deterministic locator ranking, entry detection, parameter
  extraction, and schema validation.
- Add optional Pi-assisted descriptions and assertion proposals behind the
  deterministic validator.
- Add the compact review UI for resolving targets and naming parameters.

### Slice 4 — validation runner

- Implement isolated replay, step progress, assertions, cancellation,
  deadlines, evidence, and workflow digest binding.
- Validate against fresh managed Chromium and named-profile requirements.
- Refuse activation until one current validation passes.

### Slice 5 — assignment and execution

- Add Pi workflow tools, agent grants, skill references, routine targets,
  larger-workflow nodes, and frontend-test attachment.
- Display runs and artifacts in the selected Pi session or agent conversation.
- Preserve version pinning and approval policy across every caller.

### Slice 6 — runtime and profile hardening

- Keep managed ephemeral Chromium as default.
- Complete named-profile selection, health, clearing, and warnings.
- Add optional installed-Chrome compatibility mode only after managed replay
  is stable.
- Add process, resource, profile-concurrency, and cleanup tests.

### Slice 7 — user and operator documentation

- Document record, review, test, assignment, repair, profile, and security
  flows.
- Add desktop, mobile, and fold browser validation.
- Update README screenshots only after the complete flow is working.

### Later slice — ECR and ECS worker

- Build the versioned, scanned, non-root Pi Agents browser-worker image.
- Implement broker authentication, ECS lifecycle, external artifacts,
  Secrets Manager references, fixed-egress options, limits, audit, and cleanup.
- Run the same conformance fixtures locally and in ECS before declaring
  portability.

## Test plan

### Unit tests

- Schema rejects invalid state, selectors, parameters, origins, and references.
- Recorder redacts typed values and excludes pointer noise and secret fields.
- Locator ranking is deterministic and rejects zero or multiple targets.
- Editing creates a new version and preserves the active version.
- Validation digests change for executable changes and remain stable for
  non-executable metadata changes.
- Registry and artifact paths cannot escape their owned roots.
- Assignments reject missing, disabled, invalid, or incompatible versions.

### Focused integration tests

- Record, compile, validate, activate, and replay a local fixture workflow.
- Cover forms, navigation, dialogs, tabs, iframes, delayed rendering,
  downloads, validation failure, and application layout changes.
- Restart between capture, validation, and later execution and recover state.
- Run one workflow through Pi, an agent, a generated skill, a routine, and a
  larger workflow node without copying its definition.
- Confirm named-profile authentication state is available only to authorized
  assignments.
- Confirm cancellation and browser crashes leave no process or write lease.

### Browser interaction validation

- Desktop, mobile, and fold users can complete recording and review.
- Tooltips and accessible names explain every icon.
- Ambiguous steps show actionable evidence rather than raw JSON.
- Validation progress and the exact failing step remain visible.
- Side-panel collapse, browser popout, reconnect, and page refresh preserve the
  draft and active run state.

### Repository and live verification

- Run every modified focused test directly.
- Run `npm run check` with full output.
- Run a live `pi --serve` smoke test with managed Chromium.
- Record and validate a real local fixture through the web interface.
- Restart Pi and successfully execute the persisted workflow.
- Verify no API key, capability token, or typed secret appears in captures,
  prompts, artifacts, or logs.

## Acceptance criteria

- A user can record a browser task and receives a persisted draft after Stop.
- The draft identifies a stable entry page, semantic targets, parameters,
  transitions, and completion assertions without executable coordinates.
- Ambiguous or sensitive steps cannot be activated unattended.
- Test workflow replays in a fresh managed browser and produces visible
  step-by-step evidence.
- A successful validation can activate the exact workflow version.
- Pi, an authorized agent, a skill, a routine, and a larger workflow can run
  the same stored version through one runner.
- “Use as frontend test” lets Pi execute and review the workflow while building
  the current application.
- Completed definitions, validation evidence, assignments, and run history
  survive restart.
- Browser, profile, path, origin, secret, approval, and artifact controls are
  enforced by focused tests.
- The local workflow contract and job envelope require no change to support a
  later ECS runtime.
- All focused tests, live browser validation, and `npm run check` pass before
  the feature is declared complete.

## Deliberate non-goals for the local delivery

- Recording arbitrary desktop applications or operating-system input.
- Attaching to or copying the user's everyday Chrome profile.
- Capturing or replaying raw authentication headers, passwords, CAPTCHA,
  passkeys, payment data, or two-factor values.
- Generating executable automation from unresolved coordinates.
- Arbitrary page JavaScript or shell execution inside a browser workflow.
- Automatic self-healing that silently changes an active workflow.
- Multi-user cloud authentication, ECS provisioning, or distributed scheduling
  in the initial local implementation.
