# Pi credential vault specification

## Status

Proposed and implementation-ready. This specification replaces the temporary
`.env.local` secret-storage contract in
[pi-provider-authentication-spec.md](pi-provider-authentication-spec.md) and
[pi-settings-workspace-spec.md](pi-settings-workspace-spec.md). Existing
provider, capability, agent, OAuth, and connection contracts remain
authoritative except where this document explicitly changes credential
persistence and release.

## Problem

Pi currently stores provider credentials and OAuth tokens in a project
`.env.local`, then loads those values into the serve process environment. This
creates four failures:

1. a reusable account is duplicated across workspaces;
2. unrelated Pi sessions, agents, ACP processes, or tools can inherit more
   credentials than they need;
3. plaintext values can be copied, backed up, inspected, or committed by
   mistake; and
4. provider configuration, credential storage, and runtime release appear to
   have different owners.

A concrete unsafe path is:

```text
Settings saves OPENAI_API_KEY
-> project .env.local
-> serve process.env
-> launcher copies process.env
-> unrelated child receives OPENAI_API_KEY
```

The required path is:

```text
Settings stores OpenAI Personal
-> encrypted user vault
-> connection stores vault reference
-> an authorized model run requests the declared key
-> credential broker releases only that key to the trusted adapter
```

## Goals

- Store local credentials encrypted at rest.
- Configure a reusable provider account once and grant it to multiple agents
  and workspaces without copying its values.
- Keep values out of project files, agent definitions, browser snapshots,
  prompts, transcripts, logs, run artifacts, and audit records.
- Release only explicitly declared credentials to the trusted runtime that
  needs them.
- Support concurrent Pi sessions and agent workers without lost updates or
  cross-session credential leakage.
- Provide convenient Windows startup and a portable passphrase-backed path for
  Linux, headless, recovery, and future containers.
- Import existing `.env.local` values explicitly and non-destructively.
- Preserve the provider authentication and Agent Builder user flows while
  replacing their persistence implementation.

## Non-goals

- Defending against malware, an administrator, a debugger attached to an
  unlocked process, or a compromised operating-system account.
- Giving a model or browser a generic secret-reading tool.
- Treating encryption as authorization. Agent grants, capability policy,
  approvals, and OAuth scopes remain independent controls.
- Automatically moving credentials into AWS Secrets Manager or another hosted
  vault. Hosted secret stores are future adapters behind the same broker.
- Deleting a legacy environment file or remote OAuth grant without explicit
  operator action.
- Storing Claude Code, Codex, or other subscription credentials that remain
  owned by their installed CLI. Pi records an external-auth reference and
  invokes that CLI without substituting an API key.

## Invariants

- Agent definitions store connection IDs and capability grants, never secret
  values or environment-variable names.
- Connection profiles store a credential reference, never a value.
- Provider manifests are the only authority for credential field names,
  formats, and whether a field is secret.
- Browser APIs return configuration state and safe metadata only.
- The parent serve process is not populated with vault values in
  `process.env`.
- A runtime receives no credential unless a provider binding, agent grant, and
  execution request all authorize it.
- Revocation prevents new resolutions immediately.
- A locked, missing, corrupted, or unavailable vault fails closed with a
  remediation message. It never silently selects another account or API path.
- A Pi model, agent, ACP connection, MCP process, browser workflow, or routine
  cannot use a credential merely because another concurrent run has unlocked
  or resolved it.
- Secret values never appear in URLs, command-line arguments, local storage,
  session storage, IPC diagnostics, telemetry, or error messages.

## Scope and ownership

### User vault

The user vault is the default for reusable accounts and provider credentials:

```text
<Pi user data>/credentials/v1/vault.json
```

`<Pi user data>` is resolved by Pi's existing user-data configuration rather
than the current workspace. The vault contains Google accounts, OpenAI and
Anthropic API credentials, AWS credentials, Plaid configuration, and similar
operator-owned connections.

### Workspace vault overlay

Project-only deployment credentials may use:

```text
<workspace>/.pi/vault/credentials.v1.json
```

The complete `.pi/vault/` directory is gitignored. The workspace vault never
falls back to a similarly named user credential unless the connection binding
explicitly names the user scope.

### External credential owners

Subscription CLIs and future hosted vaults remain external owners. Their
references use a distinct backend and cannot be resolved through the encrypted
file vault:

```text
external:claude-code/default
external:codex/default
aws-secrets-manager:<configured identifier>
```

Selecting an external subscription connection removes conflicting provider API
keys from that child environment.

## Design alternatives

### Alternative A: one passphrase vault per workspace

This approach is portable and keeps a checkout self-contained, but duplicates
shared accounts, complicates rotation, and requires repeated unlocks when Pi
serves several workspaces.

### Alternative B: operating-system storage only

Windows DPAPI or Credential Manager provides convenient user-bound unlocking,
but an OS-only design is difficult to move into Linux, headless use, recovery,
or ECS containers and makes the credential model platform-specific.

### Chosen design: broker with user vault, workspace overlay, and key-protection adapters

One `CredentialBroker` owns references, authorization, resolution, locking,
redaction, and backend selection. The default user vault avoids duplication.
The workspace overlay handles intentionally project-local secrets. Windows
DPAPI and portable passphrases protect the same encrypted vault data key, so
callers do not know how a vault was unlocked.

This design is chosen because it gives common callers one small interface while
hiding storage location, cryptography, key protection, process isolation, and
future hosted-vault adapters.

## Credential model

### References

New local references use opaque credential IDs:

```text
vault:user/<credential-id>
vault:workspace/<credential-id>
```

Connection profiles retain the provider ID, account label, scopes,
capabilities, status, and the opaque reference. Agents retain only the
connection ID. A normal user workflow never displays or edits a reference.

Legacy `env:`, `os:`, and `managed:project-environment/` references remain
readable during migration but cannot be created by the normal UI after the
vault is enabled.

### Encrypted entries

The encrypted payload contains:

```ts
interface VaultCredentialEntry {
  id: string;
  providerId: string;
  values: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

Entry names, provider IDs, field names, and values are ciphertext. The
unencrypted envelope contains only the schema, crypto profile, vault ID, scope,
generation, timestamps, key-protection descriptors, and authenticated cipher
parameters.

Account labels and granted capabilities remain in the connection registry so
Settings can render safe status while the vault is locked. They are not treated
as secret values, but errors and logs still avoid unnecessary personal data.

## Credential broker

The existing `CredentialStore` boundary evolves into one broker used by every
provider and runtime:

```ts
interface CredentialBroker {
  status(scope?: "user" | "workspace"): Promise<VaultStatus[]>;
  metadata(reference: string): Promise<CredentialMetadata>;
  store(binding: CredentialBinding, values: Readonly<Record<string, string>>): Promise<CredentialMetadata>;
  replace(reference: string, request: CredentialReplaceRequest): Promise<CredentialMetadata>;
  revoke(reference: string, names?: readonly string[]): Promise<CredentialMetadata>;
  withResolved<T>(request: CredentialResolutionRequest, use: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  importLegacy(request: LegacyImportRequest): Promise<LegacyImportReport>;
  lock(scope?: "user" | "workspace"): Promise<void>;
}
```

`withResolved` is available only to trusted provider and launcher adapters. It
requires the credential reference, provider ID, declared field names,
connection ID, actor identity, run ID, and purpose. The broker verifies all of
them before resolution, invokes the callback, then releases its temporary
buffers on a best-effort basis.

There is no `get`, `export`, `reveal`, or browser-facing resolve operation.

Provider manifests remain authoritative. A request for an undeclared field,
another provider's reference, a revoked connection, or a capability outside
the execution grant is rejected before decryption.

## Cryptographic format

### Data encryption

- Generate a random 256-bit data-encryption key for each vault.
- Encrypt the complete payload with AES-256-GCM.
- Generate a fresh random 96-bit IV for every write.
- Store the 128-bit authentication tag separately from ciphertext.
- Authenticate schema version, crypto profile, vault ID, scope, generation,
  and timestamps as additional authenticated data.
- Reject unknown schemas, profiles, algorithms, sizes, or parameters. Never
  downgrade silently.

### Key protection

The data-encryption key has one or more wrappers:

- **Windows default:** DPAPI `CurrentUser`, binding automatic unlock to the
  Windows account running Pi.
- **Portable:** scrypt-derived key-encryption key with random 128-bit salt,
  `N=2^15`, `r=8`, and `p=3`; use AES-256-GCM with a distinct IV to wrap the
  data-encryption key.

Passphrases are at least 16 characters, entered through hidden input or stdin,
and never accepted in arguments, URLs, settings files, or environment
variables. Adding, rotating, or removing a key wrapper does not require
reencrypting every credential entry.

The Windows DPAPI adapter must use an audited local API boundary. Plaintext key
material may cross only an inherited pipe or in-process native boundary, never
a command line or temporary file. Windows file mode is not treated as a
security boundary.

### Persistence

- Write a same-directory temporary file with exclusive creation.
- Flush the file before atomic replacement where the platform supports it.
- Use restrictive permissions as defense in depth on POSIX.
- Validate the complete envelope before replacing the in-memory snapshot.
- Zero key and plaintext buffers on lock and after failed unlock where Node
  permits it. The threat model acknowledges that JavaScript strings cannot be
  reliably zeroed.

## Locking, concurrency, and restart recovery

Multiple Pi serve processes may use the same user vault. An in-process queue is
not sufficient.

- Every mutation obtains an inter-process vault lock.
- The lock record contains vault ID, process ID, host identity, creation time,
  and a random owner token, but no credentials.
- Lock acquisition is bounded and abortable. A stale lock is recoverable only
  after verifying its owning process is absent or its lease expired.
- After acquiring the lock, the writer reloads the latest envelope, verifies
  its generation, applies one mutation, increments the generation, and writes
  atomically.
- A generation mismatch causes bounded reload and retry; it never overwrites a
  newer vault snapshot.
- Readers authenticate a complete immutable snapshot. A concurrent replacement
  cannot expose a partially written vault.
- DPAPI-backed user vaults may auto-unlock after restart for the same Windows
  user. Passphrase-backed vaults start locked and require host-side unlock.
- Refreshing or closing the browser does not lock the serve process or cancel
  active credential leases. Stopping the serve host locks its in-memory vault
  session after active calls finish or are cancelled.
- Revocation updates the authoritative generation first. Existing outbound
  network requests may finish, but no subsequent resolution succeeds.

## Runtime release rules

### Pi model sessions

Model adapters receive only the selected connection's declared authentication
fields. Model credentials are passed as scoped adapter options rather than
added to `process.env`.

### Isolated agents

Agent workers receive no provider credentials. Capability tools execute
through the authenticated host broker whenever possible. If a reviewed tool
must run in the worker, its launcher receives only the approved fields for that
run and deletes them when the child exits.

### ACP and subscription CLIs

Each ACP tab binds to one explicit connection and working directory. API-backed
connections receive only their provider fields. Subscription-backed
connections inherit the external CLI's own authentication files and receive no
conflicting API key. The UI and run record state which connection path was
used.

### MCP and local subprocesses

MCP manifests declare credential field references. The launcher constructs a
fresh environment from runtime essentials plus those fields. It never spreads
the parent environment wholesale.

### Browser workflows and routines

Workflow parameters may refer to a connection ID, not `env:NAME`. The browser
driver or host tool resolves the credential only at the action boundary. Saved
steps, screenshots, DOM snapshots, request logs, and run artifacts are
redacted. Routines revalidate connection health and grants at every run.

### Tool and plugin policy

Plugins cannot declare arbitrary environment names at runtime. Credential
requirements must come from a reviewed, installed manifest. Installing a
plugin does not grant its credentials to any agent.

## Provider configuration and OAuth

Provider manifest fields are split by ownership:

- non-secret URLs, regions, model choices, and safe identifiers persist in Pi
  configuration;
- API keys, client secrets, refresh tokens, access tokens, and financial access
  tokens persist in the vault; and
- external subscription authentication remains with its owning CLI.

OAuth state and PKCE verifier remain short-lived process memory. OAuth client
secrets and resulting tokens use the selected vault scope. Token refresh uses
`withResolved`, persists replacements atomically, increments the entry version,
and marks prior validation metadata stale.

The connection registry is updated only after vault persistence succeeds. If
the registry update fails, the unreferenced encrypted entry is retained for a
bounded reconciliation job and is not considered connected.

Validation results contain provider, connection ID, entry version, timestamp,
and success or safe failure category. They contain no value, token fragment,
hash derived from a value, or provider response body that may contain a token.

## Settings user experience

### Settings > Security > Credential vault

Display compact cards for User vault and the current Workspace vault:

- initialized, locked, unlocked, or needs attention;
- Windows protected or passphrase protected;
- safe credential/account count when unlocked;
- last update and last successful validation;
- Import legacy configuration, Lock, Add recovery passphrase, and Rotate
  protection actions when applicable.

Advanced cryptographic metadata is collapsed by default. Values are never
displayed.

### Settings > Connections

Provider cards retain Configure, Connect, Test, Update access, Revoke, and
Remove actions. Secret inputs are always blank:

- blank means unchanged;
- Replace explicitly overwrites;
- Clear explicitly revokes the selected value; and
- successful submission clears the input element immediately.

The user chooses **Shared user account** by default or **This workspace only**
for project credentials. Existing agents are not granted a newly connected
account automatically.

### Agent Builder

Agent Builder shows connected accounts and grants. It never presents a secret
input, raw scope editor, environment-variable name, credential reference, or
vault unlock control. A locked or unhealthy connection remains visible with a
Settings remediation link.

## LAN and browser security

- All vault management routes require the serve capability token.
- On plaintext HTTP, secret entry, import, unlock, recovery setup, rotation,
  and credential replacement are loopback-only. A LAN/mobile browser may view
  safe readiness and validation status but cannot transmit secrets.
- Authenticated HTTPS deployments may enable remote secret entry only with
  origin validation, CSRF protection, secure cookies or equivalent bearer
  handling, no caching, and explicit operator configuration.
- OAuth callbacks preserve their existing state, PKCE, expiry, and replay
  protections. Callback pages contain no token material.
- Secret request bodies are never logged and receive `Cache-Control: no-store`.
- Clipboard paste is allowed for operator convenience, but the application
  never copies a stored value back to the clipboard.

## Legacy `.env.local` migration

### Discovery

On startup, Pi identifies provider-declared fields present in `.env.local` and
reports only provider, field label, secret/non-secret classification, and
configured state. It does not parse arbitrary environment names into the
vault.

### Import

The operator selects a destination scope and providers to import. For each
declared field:

- secret values go to the vault;
- safe non-secret configuration goes to Pi settings;
- dangerous process variables are rejected; and
- unsupported or malformed values remain untouched and are reported safely.

Import is serialized, atomic per provider account, and non-destructive. The
source file remains unchanged until validation succeeds.

### Transition precedence

During the migration window:

```text
explicit vault connection -> external credential owner -> legacy declared env
```

There is no fallback after an explicitly selected vault connection fails. A
legacy value is considered only for a legacy connection that has not been
migrated.

After validation, Settings offers to remove only the imported secret
assignments while preserving comments, blank lines, and unrelated safe
configuration. Removal requires confirmation and creates a value-free audit
event. Legacy write operations are disabled once the vault implementation is
active.

## Audit and redaction

Audit events may contain:

- operation, actor, credential ID, provider ID, connection ID, scope, entry
  version, result, and timestamp.

They must not contain:

- values, authorization codes, tokens, passphrases, ciphertext, wrapped keys,
  value-derived hashes, raw provider response bodies, or secret request
  payloads.

A central redactor covers known credential field names and dynamically
registered values while they are in memory. Redaction is defense in depth;
callers must still avoid logging secret-bearing objects.

## Error behavior

Errors are stable and actionable:

```text
Vault locked
Credential not configured
Connection revoked
Provider binding mismatch
Credential field not declared
Vault update conflict; retry
Vault data failed authentication
Secret entry requires the host or authenticated HTTPS
```

Authentication failures do not distinguish wrong passphrase, wrong wrapped
key, tampered ciphertext, or tag failure. Provider errors are sanitized before
they enter logs, run history, or chat.

## Implementation slices

### Slice 1: contracts and encrypted file backend

- Add opaque references, credential bindings, metadata, and broker contracts.
- Implement versioned AES-256-GCM envelope, portable key wrapper, atomic writes,
  lock/unlock, replace, revoke, and focused crypto tests.
- Retain the current store behind a legacy adapter for transition tests.

### Slice 2: Windows protection and scope resolution

- Add the DPAPI `CurrentUser` key wrapper and Windows restart tests.
- Resolve the Pi user-data vault and validated workspace overlay path.
- Add inter-process locking, generation checks, and stale-lock recovery.

### Slice 3: provider and OAuth migration

- Separate secret and non-secret manifest fields.
- Move Google OAuth, provider API keys, AWS, Plaid, and other managed tokens to
  the broker.
- Add explicit `.env.local` discovery, import, validation, and cleanup flow.
- Stop hydrating the parent `process.env` with persisted secrets.

### Slice 4: runtime isolation

- Route Pi model keys through adapter options.
- Audit and replace every `{ ...process.env }` child launch with a scoped
  environment builder.
- Bind agents, ACP, MCP, routines, browser workflows, and plugins to explicit
  connections.
- Add subscription-versus-API path assertions.

### Slice 5: Settings and Agent Builder

- Add vault status, protection, import, rotation, lock, and remediation UI.
- Add user/workspace scope selection to connection setup.
- Keep secret fields write-only and unavailable over plaintext LAN HTTP.
- Keep Agent Builder limited to account selection and grants.

### Slice 6: recovery, concurrency, and operations

- Reconcile unreferenced encrypted entries and missing connection records.
- Validate restart recovery, simultaneous serve hosts, rotation, revocation,
  cancellation, and active-run behavior.
- Document backup limitations and recovery-passphrase behavior.

### Slice 7: completion validation

- Run focused unit and integration tests after each slice.
- Run `npm run check` with no errors, warnings, or informational findings.
- Run a live `pi --serve` smoke test on Windows.
- Validate desktop, phone, and unfolded Pixel Fold layouts.
- Validate concurrent Pi, agent, ACP, MCP, routine, and browser activity.
- Perform a repository and generated-artifact secret scan.
- Update operator documentation and screenshots after the UI stabilizes.

## Focused test plan

### Cryptography and persistence

- round trip, wrong unlock material, ciphertext/tag/AAD tamper, unknown profile,
  fresh IV, wrapper rotation, atomic replacement, truncation recovery, and
  locked-session behavior;
- prove raw vault bytes contain no entry names, provider IDs, field names, or
  values; and
- DPAPI tests run on Windows plus deterministic adapter tests elsewhere.

### Isolation and authorization

- provider and account mismatch rejection;
- undeclared field rejection;
- agent grant and capability enforcement;
- revoked and unhealthy connection rejection;
- no unrelated credential in parent or child environments; and
- subscription ACP launch contains no provider API key.

### Concurrency and lifecycle

- two processes update different credentials without loss;
- conflicting generation retries or fails safely;
- stale lock recovery and live lock refusal;
- browser refresh does not cancel a run;
- host stop cancels or drains leases and zeroes keys; and
- restart restores safe metadata and DPAPI unlock behavior.

### Migration and UI

- declared-only import, comments and unrelated lines preserved, no automatic
  deletion, vault precedence, and legacy failure behavior;
- no secret values in API JSON, DOM, browser storage, logs, errors, events, run
  artifacts, or transcripts;
- loopback and plaintext-LAN mutation restrictions; and
- Settings and Agent Builder behavior on desktop, phone, and foldable layouts.

## Acceptance criteria

- A user configures one Google or model-provider account and grants it to two
  agents in different workspaces without duplicating credential values.
- Vault files contain authenticated ciphertext and expose no stored names or
  values.
- Windows can restart and unlock the user vault under the same OS account
  without placing a key or passphrase in a launcher, environment variable, or
  command line.
- A portable passphrase vault can be unlocked through hidden host input or
  stdin and fails closed with the wrong passphrase.
- Existing `.env.local` credentials can be imported, validated, and optionally
  removed without losing unrelated configuration.
- The serve parent and unrelated children do not receive vault credentials in
  `process.env`.
- Pi sessions, multiple agents, ACP tabs, MCP processes, routines, and browser
  workflows run concurrently with only their authorized credentials.
- Subscription-backed ACP runs cannot silently use an API-key connection.
- Revoking a connection blocks every subsequent model or tool invocation that
  references it.
- Plaintext LAN/mobile clients cannot submit, replace, import, or unlock
  credentials.
- Secret values do not appear in browser responses, DOM state, logs,
  transcripts, events, run artifacts, or committed files.
- Settings presents one understandable connection flow; Agent Builder presents
  only accounts and grants.
- Focused tests, `npm run check`, live `pi --serve`, browser interaction, and
  concurrent-runtime validation pass before merge.

## Completion definition

The feature is complete only when all seven slices are implemented with no
placeholder UI or disconnected controls, migration and restart recovery work,
security and path validation pass, focused unit and integration tests pass,
`npm run check` passes, a live Windows `pi --serve` smoke test passes, browser
interaction is validated, and the resulting changes are reviewed before
commit, push, PR, and merge.
