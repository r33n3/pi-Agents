# Pi agent lifecycle hardening specification

## Status

Implementation contract for hardening the existing local `pi --serve` agent
runtime. This specification refines the agent workspace and capability platform
specifications. It preserves the proof, acceptance, promotion, and scheduling
lifecycle. Delivery and review follow Goal 1 in the
[agent collaboration implementation roadmap](pi-agent-collaboration-goals.md).

## Goal

Make each consequential decision belong to one explicit lifecycle owner:

- one process owns a serve data directory;
- one immutable configuration snapshot owns an agent run;
- one live run authority owns effects initiated by that run;
- one exact action binding owns an approval receipt;
- one connection generation owns browser responses; and
- one metadata registry describes capabilities without activating plugin code.

The implementation remains a local Pi runtime. It does not adopt a distributed
control plane or replace Pi's agent, model, session, or extension systems.

## Existing behavior that remains authoritative

- `AgentBuildLifecycleService` continues to own proof, acceptance, promotion,
  and automation eligibility.
- `AgentRegistry` continues to own deployed definitions and monotonically
  increasing definition revisions.
- `AgentTaskService` and `AgentRunManager` continue to own task and execution
  state.
- `CapabilityBroker` continues to own reviewed provider state, defaults,
  grants, and invocation eligibility.
- `PluginManagementService` continues to own package installation and
  activation. Installation never grants a tool to an agent.
- Credentials remain outside definitions, run records, browser snapshots,
  transcripts, and capability metadata.
- Completed approval outcomes retain their existing idempotent replay behavior.

## Design principles

1. Acquire authority before reading or repairing state that authority protects.
2. Capture configuration once, then pass the captured value through execution.
3. Check live authority after awaited work and immediately before an effect.
4. Bind approval to an exact canonical action, not a descriptive label alone.
5. Treat discovery, activation, and grants as separate lifecycle decisions.
6. Let the latest browser selection intent win without serializing unrelated
   network work.
7. Prefer one authoritative representation over synchronized copies.

## 1. Serve-directory ownership

### Problem

Execution locks are currently process-local while run, task, workflow, routine,
browser, approval, and audit state share one serve directory. A second host can
start against the same directory and mark the first host's live runs failed
during startup recovery.

### Alternatives

**Alternative A: process-long directory lease.** Acquire one canonical
filesystem lease before persistent initialization. This prevents concurrent
hosts and keeps all existing file formats.

**Alternative B: transactional ownership per stored record.** Move task and run
claims into a database with owner epochs and conditional updates. This permits
intentional multi-host operation but requires schema migration, transactional
recovery, fencing for every writer, and a distributed scheduling contract.

**Decision:** use Alternative A. ForkPI documents one host per serve directory
and does not currently need multi-host execution.

### Contract

Add `ServeDirectoryOwnership` with this lifecycle:

```ts
interface ServeDirectoryOwnership extends AsyncDisposable {
  readonly path: string;
  release(): Promise<void>;
}

function acquireServeDirectoryOwnership(
  serveRoot: string,
  onCompromised: (error: Error) => void,
): Promise<ServeDirectoryOwnership>;
```

The implementation uses the existing pinned `proper-lockfile` dependency:

- create the serve root before acquisition;
- acquire with canonical real-path resolution;
- use an atomic lock directory on Windows and POSIX;
- use a 10-second stale interval, a 2.5-second heartbeat, and no contention
  retries;
- fail startup with the canonical directory in the error when another host
  owns it;
- close the host if the heartbeat reports a compromised lease; and
- make release idempotent.

`ServeHost` acquires ownership after validating its capability token and before
audit initialization, run or task recovery, schedulers, browser stores, or the
network listener. On shutdown it releases ownership after the listener,
schedulers, executors, workers, and stores have stopped. Startup failure uses
the same shutdown path.

A crash may leave the directory unavailable for up to the stale interval. Code
must not delete a lock based only on a PID because PID reuse and path aliases
make that unsafe.

### Acceptance criteria

- A second host using the same physical serve root fails before recovery.
- Symlink or junction aliases resolve to the same ownership boundary.
- Closing the owner allows a fresh host to start immediately.
- A failure after acquisition releases the lease.
- A compromised lease initiates fail-closed host shutdown.

## 2. Exact approvals and live run authority

### Problem

An approval receipt currently binds capability, provider, connection, action,
and visible target. For email writes, the target is the recipient list while
the subject, body, HTML, and attachment bytes are supplied later. Two different
messages to the same recipients therefore have the same receipt identity.

Separately, authorization may be followed by audit and credential awaits. A
stopped or replaced run must not regain permission merely because it holds a
persisted receipt.

### Alternatives

**Alternative A: add more provider-specific fields to receipts.** This is a
small diff for email but repeats policy for calendars, files, messaging, and
future providers.

**Alternative B: canonical action binding plus independent execution
authority.** Every approved adapter supplies a bounded canonical action object.
The approval store records its digest and human-readable preview. Agent effects
also carry a process-local live authority that is checked at use time.

**Decision:** use Alternative B. Canonicalization is provider-owned because the
provider understands which fields determine the effect. Hashing, storage,
matching, and execution authority are shared mechanisms.

### Canonical action binding

```ts
interface CapabilityApprovalActionBinding {
  version: 1;
  digest: string;
  preview: string;
}

type CapabilityApprovalOwner =
  | { kind: "session"; id: string }
  | { kind: "agent-run"; id: string };
```

The digest is SHA-256 over canonical JSON with lexicographically sorted object
keys. Values must be JSON-safe: null, booleans, finite numbers, strings, arrays,
and plain objects. Undefined values, non-finite numbers, prototypes, and cycles
are rejected. The persisted receipt contains only the digest and bounded
preview, not sensitive message content.

For Gmail message writes, canonical input includes ordered trimmed `to` and
`cc` addresses; exact subject and text; the provider's normalized HTML value;
validated filename and MIME type; and a digest of decoded attachment bytes.
Empty `cc` and HTML values use the same representation that dispatch uses. The
visible target remains the recipient list. Changing any canonical field
requires another approval.

Approval state advances from persistence version 1 to version 2. Version 1
receipts remain visible as legacy history but cannot authorize execution or
replay because they prove neither the exact action nor its owner. During
migration, approved legacy receipts become cancelled and started legacy
receipts become failed with reconciliation required. No receipt is
automatically reissued.

### Live run authority

`AgentRunManager` remains the sole owner of live run state. Add narrow
`isActive(runId)` and `assertActive(runId)` operations rather than copying that
state into another registry. A provider invocation receives an ephemeral
`ActionAuthority` containing an owner, abort signal, and `assertLive()` method.
The agent tool projection constructs it from the execution context's run ID;
session-owned actions construct it from the live session identity.

The approval HTTP operation accepts an explicit owner and provider action
input. The server validates that owner, resolves the applicable provider and
connection, and asks the registered provider binder to produce
`{ version, digest, preview, dispatchInput }`. It rejects caller-supplied
digests. Receipts are never left unbound and cannot be transferred to another
run or session.

`GovernedActionService` checks the supplied authority:

1. before authorization;
2. after authorization;
3. after the durable decision write;
4. after credential resolution;
5. immediately before dispatch; and
6. before accepting a successful result.

Effect adapters that perform additional asynchronous preparation inside
dispatch must assert current authority immediately before the external fetch,
filesystem mutation, subprocess launch, or equivalent effect.

Dispatch uses the binder's `dispatchInput`, so the approved representation and
the effect cannot drift. Completed receipt replay validates the exact action
binding and owner identity but does not require the historic owner to remain
live. No adapter dispatch occurs on that path.

Revocation aborts the live authority first and cancels matching approved
receipts. A started receipt records the revocation without overwriting its
eventual provider outcome: it becomes cancelled if abort wins and completed if
the provider already succeeded. A crash while started remains reconciliation
required and is never retried automatically.

### Acceptance criteria

- Changing an email subject, body, HTML, recipients, filename, MIME type, or
  attachment bytes rejects the receipt.
- An approved receipt is consumed at most once concurrently.
- Completed results replay across restart without repeating the provider call.
- Cancelling a run while authorization, audit, or credential resolution is
  pending prevents dispatch and records cancellation.
- A receipt bound to one live execution cannot authorize another execution.
- The approval API rejects digest-only requests and inactive owners.
- A grant or owner denial cannot strand a receipt in `started`.
- No secret or complete email body is persisted in approval or audit state.

## 3. Immutable run configuration snapshots

### Problem

The current path already passes a detached agent definition to the executor and
resolves granted host tools and the selected model credential before worker
startup. That useful boundary is implicit. Run records retain only revision and
optional model, so operators cannot prove which non-secret configuration was
executed, and future reload paths could accidentally mix generations.

### Alternatives

**Alternative A: deep-clone and freeze the existing execution context.** This
prevents in-process mutation but does not produce an auditable identity or make
the captured fields explicit.

**Alternative B: a versioned non-secret run snapshot.** Capture the effective
definition, canonical workspace, selected model, capability bindings, provider
manifest digests, and configuration digest at admission. Pass one immutable
value through execution and persist its safe representation with artifacts.

**Decision:** use Alternative B, implemented as a small boundary around the
existing execution context rather than a second model runtime.

### Contract

```ts
interface AgentExecutionConfigurationSeed {
  version: 1;
  agentId: string;
  agentRevision: number;
  workspace: string;
  definition: AgentDefinition;
  effectiveModel?: ModelRef;
  capabilityBindings: Array<{
    capabilityId: string;
    capabilityVersion: number;
    providerId: string;
    providerDigest: string;
    connectionId?: string;
  }>;
  digest: string;
}

interface AgentRunConfigurationSnapshot {
  version: 1;
  runId: string;
  configuration: AgentExecutionConfigurationSeed;
  digest: string;
}
```

One configuration-snapshot builder owns canonicalization, capability binding,
secret exclusion, cloning, freezing, and digest generation. Before durable task
admission exists, `AgentRunManager` uses that builder at run admission. The
persistent-inbox goal stores the same seed in the task contract before queueing;
`AgentRunManager` then adds only run identity and the outer snapshot digest.
There must not be separate task and run implementations of configuration
normalization or digest policy.

The seed and snapshot contain no credentials, secret references, access tokens,
live tool objects, or mutable registries. `run.json` records the snapshot digest;
`run-snapshot.json` stores the safe snapshot with the run artifacts using atomic
replacement.

The executor resolves the model credential once for the snapshot's effective
model and captures host tool objects once for its capability bindings. Ordinary
definition, default-model, provider, connection, credential, or grant edits
after admission affect later runs. Security revocation remains immediate and
invalidates live authority. Retries of the same execution attempt reuse its
snapshot.

### Acceptance criteria

- Editing an agent while a run is active does not alter that run's persona,
  model, tools, grants, workspace, browser policy, or limits.
- Provider or connection changes affect newly admitted runs only.
- Snapshot and run-record digests agree after restart.
- Snapshot persistence never includes credential material.
- A temporary specialist snapshots its generated identity and source revision.
- Task admission and direct run admission use the same configuration builder.

## 4. Browser connection generations

### Problem

Session attachment, session listing, reconnect, and removal are asynchronous.
An older operation can finish after a newer user selection and publish stale
state into the console.

### Alternatives

**Alternative A: serialize browser operations through one promise queue.** This
prevents reordering, but a stalled attachment blocks later user input and
reconnection.

**Alternative B: independent generation scopes.** Capture connection identity
and generation around asynchronous work and publish only when they remain
current. Increment a separate selection generation for each user intent.

**Decision:** use Alternative B so the latest selection wins without blocking
independent inventory refreshes.

### Contract

Each connection owns an epoch and session-list request generation. The app owns
a global selection generation.

- Disconnect, client replacement, and connection removal increment the
  connection epoch.
- Each session-list request captures and increments its request generation.
- Each session selection intent increments the selection generation, including
  selecting the currently visible target.
- Attach, reconnect, list, and subscription callbacks publish only when the map
  still contains the same connection object and all captured generations match.
- A stale newly attached session is disposed rather than published.
- A manual selection during reconnect wins over reconnect's prior selection.
- Only the current operation may publish an error or change connecting controls.

### Acceptance criteria

- If attach A starts, attach B starts, B finishes, then A finishes, B remains
  selected and A is disposed.
- Disconnect or removal invalidates pending attachment and list operations.
- An older list response cannot replace a newer session list.
- Reconnect cannot override a later manual host selection.
- Stale failures do not replace current status or controls.

## 5. Metadata-only capability discovery

### Problem

Provider definitions, manifests, validation, and digest behavior currently live
inside `CapabilityBroker`, while runtime tools are constructed separately in
the host. Some Everyday and SearXNG tools are reconstructed again inside the
worker. Catalog inventory also joins loaded tools, configured packages, and
broker state. This duplicates tool ownership and makes metadata discovery depend
on runtime assembly.

### Alternatives

**Alternative A: each adapter exports `{ manifest, createTools }`.** This gives
strong compile-time linkage but importing external metadata executes adapter
modules and therefore crosses the activation boundary.

**Alternative B: one data contract and metadata registry, with host-owned tool
construction.** Pi-owned built-ins use typed records; reviewed external plugins
use validated sidecars. The registry is safe to read while package runtime is
inactive.

**Decision:** use Alternative B. Do not add separate cached and cold tool
construction paths.

### Contract

Add a TypeBox-backed `capability-provider-contract` as the single runtime schema
and TypeScript type owner for definitions, provider manifests, authentication
metadata, and capability bindings. Add `CapabilityProviderRegistry` to own:

- immutable built-in metadata;
- parsing and validation of reviewed sidecar metadata;
- duplicate ID, binding, version, environment-name, and effect checks;
- deterministic canonical source and manifest digests; and
- versioned, secret-free discovery snapshots.

`CapabilityBroker` consumes the registry snapshot and retains trust, defaults,
connections, grants, and invocation eligibility. `CapabilityCatalog` consumes
the same snapshot plus live tool availability. `PluginManagementService`
continues to own install and activation state.

The host registers each provider `ToolDefinition` exactly once. Agent grants
select host-owned tools. Isolated workers receive safe descriptors and proxy
calls to those same host tool objects over IPC. Remove worker-local Everyday
and SearXNG tool construction and capability-specific secret environment
forwarding.

Installed inactive plugin metadata may be visible as unavailable. Activating a
plugin makes its declared tools live but grants none of them automatically.
Manifest changes continue to quarantine reviewed state.

Persisted broker state remains version 1 because provider IDs, manifest
digests, defaults, and grants retain their meaning. Canonical digest generation
must ignore object-key order while detecting semantic permission changes.

### Acceptance criteria

- Metadata for an inactive reviewed plugin is discoverable without importing
  its runtime entrypoint.
- Activation does not create an agent grant.
- An enabled and granted capability resolves only when its declared host tool
  is live.
- Built-in manifests all validate through the same schema.
- Field-order-only metadata changes preserve the digest; permission or binding
  changes alter it and quarantine the provider.
- Everyday and SearXNG execute through the parent host proxy only.
- Worker environments contain no provider secrets required solely by a
  duplicated worker-local adapter.

## Delivery order

1. Serve-directory ownership and browser generations.
2. Execution authority and exact approval bindings.
3. Explicit immutable run snapshots.
4. Capability metadata registry and single host tool path.

Each slice updates its focused tests and documentation before the next slice.
All code changes finish with the affected test files and `npm run check`. The
full Vitest suite and `npm test` remain outside this specification.

## Compatibility and migration

- Agent definitions and proof lifecycle records retain their current schemas.
- Run records accept missing snapshot digests as legacy history.
- Version 1 approval state is read through the restricted migration described
  above; it is rewritten as version 2 on the next mutation.
- Capability broker persistence stays at version 1.
- Browser changes affect client runtime state only.
- A deployment may roll back before creating version 2 approval state. After
  that point, rollback requires retaining or explicitly removing the newer
  approval history; approvals are not silently downgraded.

## Deliberate non-goals

- Multiple writers or distributed scheduling against one serve directory.
- SQLite migration for existing JSON task, run, approval, or capability state.
- Organization identity providers, multi-user permissions, or cloud hosting.
- A new agent runtime, provider stack, or plugin SDK.
- Automatic long-term memory consolidation.
- Backward-compatible authorization of incomplete version 1 approvals.
- Treating plugin activation as equivalent to an agent tool grant.
