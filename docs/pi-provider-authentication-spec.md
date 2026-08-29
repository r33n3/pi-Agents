# Pi provider authentication

## Status

Implemented through the `pi --serve` Settings workspace. Google
Workspace/Gmail is the first complete OAuth provider. Other providers use the
same manifest and service boundary as their adapters are added.

## Problem

The capability broker currently separates stable capabilities from their
providers, but Agent Builder exposes provider manifests and grant checkboxes as
if those providers were callable. A connection form can persist descriptive
metadata, but it cannot install an adapter, write its declared environment
configuration, perform OAuth, or prove that an account is usable. Consequently
a user can appear to configure Gmail while Pi still has no Gmail tools.

## User-visible contract

Each provider and capability has an explicit state:

```text
connector required -> configuration required -> authorization required
-> connected -> enabled -> granted
```

- **Configure** edits only fields declared by the provider manifest.
- **Authorize** starts a provider-owned OAuth flow.
- OAuth providers present one account connection with grouped service
  permissions. Google Workspace groups Gmail, Calendar, Drive, Contacts, and
  Google Chat and requests only the capabilities selected by the operator.
- **Reconnect** repeats authorization without changing agent grants.
- **Revoke** invalidates the remote grant when supported and always removes the
  local connection.
- Agent capability checkboxes remain disabled until the selected provider is
  installed, healthy, configured, connected when required, reviewed, and
  enabled.
- Saving configuration never implies that authorization or adapter installation
  succeeded.
- Secret values are write-only. The browser receives configured/not-configured
  status, never stored values.

Provider configuration is split between safe Pi settings and the encrypted
credential store defined by
[pi-credential-vault-spec.md](pi-credential-vault-spec.md). Existing project
`.env.local` values are a read-only migration source and explicit legacy
fallback; new secrets and OAuth tokens are written to the vault.

## Design

### Chosen design: provider authentication service

`ProviderAuthenticationService` owns manifest requirements, environment-file
persistence, OAuth state and PKCE, token exchange, redacted status, reconnection,
and revocation. The broker consumes its status but does not parse environment
files or perform OAuth. HTTP and Agent Builder use high-level operations rather
than editing environment variables directly.

The alternative was provider-specific forms, HTTP routes, and token storage.
That is initially smaller but repeats security rules for every provider and
requires UI changes for each new connector. A single service makes the common
operation small and keeps provider differences behind adapters.

### Provider declaration

Provider manifests may declare:

```ts
interface ProviderAuthenticationManifest {
  kind: "environment" | "oauth2";
  fields: ProviderConfigurationField[];
  oauth?: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    scopes: string[];
  };
}

interface ProviderConfigurationField {
  env: string;
  label: string;
  required: boolean;
  secret: boolean;
  format?: "text" | "url";
}
```

Only declared names can be written. Dangerous process variables, arbitrary
names, multiline values, NUL bytes, and values beyond the bounded field size
are rejected. URL fields require an absolute HTTP(S) URL. Duplicate manifest
environment names are invalid.

### Credential storage

The encrypted credential store:

- stores shared accounts in the user vault and project-only credentials in the
  validated workspace overlay;
- persists only fields declared by the provider manifest;
- keeps safe non-secret provider configuration outside the vault;
- writes authenticated ciphertext through atomic replacement;
- releases only declared fields to trusted provider adapters;
- never returns values through snapshots, logs, errors, or audit records; and
- uses inter-process locking and generations so simultaneous provider saves
  cannot lose updates.

Clearing a field revokes the selected vault value. The parent serve process is
not hydrated with stored credentials. `.env.local` remains gitignored and is
handled by the explicit, non-destructive migration flow.

### OAuth

OAuth authorization uses a random, single-use, expiring state and PKCE
challenge. The callback is bound to the initiating provider and browser token.
The service validates state before exchanging a code. Tokens are written only
to provider-declared environment names. Callback pages contain no tokens.

Google Workspace initially requests the minimum scopes needed for the selected
Gmail grants. Read-only grants do not request compose or modify scopes. Draft
requires compose. Send remains a separate capability and requires a
target-bound approval receipt before invocation.

The account picker is shown for every Google connection or access update.
Incremental authorization retains previously approved Google scopes while Pi's
connection profile restricts execution to the currently selected capability
set. A service is selectable only when its adapter tools are installed; other
service groups are visible as `Adapter required` and cannot create a false
grant.

The callback defaults to the current `pi --serve` origin. Deployments behind an
HTTPS reverse proxy can declare `GOOGLE_OAUTH_REDIRECT_URI`; it must be an
absolute HTTP(S) URL without credentials, query, or fragment and must route to
Pi's Google callback endpoint. This avoids binding OAuth configuration to a
specific LAN port while retaining an exact provider-registered callback.

### Gmail adapter

The Google Workspace adapter provides normalized tools for:

- `email.search`
- `email.read`
- `email.draft`
- `email.send`
- `email.attach`
- `email.delete`

Search and read are bounded and strip unneeded payload. Draft produces a Gmail
draft and returns its ID and recipient summary. `email.delete` moves the message
to Gmail trash; it does not permanently erase it. Send, attachment upload, and
trash operations require the existing approval service and stable idempotency
key. MIME construction rejects header injection and bounds attachment size.

The adapter refreshes an expired access token using the stored refresh token,
persists the replacement access token, and marks the connection unhealthy when
refresh or account validation fails. Credentials never enter model context.

### Plugins and future providers

Plugins can participate only through a reviewed capability-provider manifest.
Installing a plugin does not grant or configure it. A plugin without declared
authentication fields has no generic secret editor. OAuth behavior remains in
a reviewed provider adapter; models and package instructions cannot add fields,
scopes, callback destinations, or environment names at runtime.

## HTTP API

Authenticated local management endpoints:

```text
GET  /capability-providers/:id/auth
PUT  /capability-providers/:id/configuration
POST /capability-providers/:id/authorize
GET  /capability-oauth/:id/callback
POST /capability-providers/:id/revoke
```

Configuration accepts declared values and explicit field names to clear. Auth
status responses contain field names, labels, validation type, configured
booleans, connection/account state, and available actions only.

## Recovery and concurrency

- Configuration writes run independently of Pi turns and agent workers.
- On startup, the service loads safe vault metadata without exposing values and
  reconstructs connection health. A locked vault remains visible as a
  remediable state.
- OAuth state is intentionally process-local and expires after ten minutes;
  restart requires starting authorization again.
- Agent definitions retain grants while a connection is unavailable, but new
  runs fail with a remediation message.
- Revocation immediately prevents new invocations and refreshes routine status.

## Validation

Focused tests must cover:

- allowlisted writes, clears, escaping, comment preservation, atomic recovery,
  concurrent updates, and path validation;
- secret redaction from API payloads, DOM state, logs, and errors;
- OAuth state, PKCE, expiry, replay rejection, callback errors, token refresh,
  and revocation using a local fake provider;
- Gmail pagination, message normalization, MIME/header safety, size bounds,
  approval enforcement, and idempotency;
- provider/capability state transitions and restart recovery;
- Agent Builder configuration and authorization controls on desktop, phone, and
  unfolded-foldable layouts; and
- a live `pi --serve` smoke test with an environment-only provider.

Live Google authorization is a manual completion check because it requires an
operator-owned Google OAuth client and consent. Automated completion never uses
real credentials or sends email.
