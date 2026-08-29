# Pi Settings workspace and Agent Builder cleanup specification

## Status

Implemented contract separating environment configuration from agent
configuration in the authenticated `pi --serve` web console. This document
amends the navigation and Agent Builder portions of
[pi-agent-workspace-spec.md](pi-agent-workspace-spec.md) and the browser
placement described by
[pi-provider-authentication-spec.md](pi-provider-authentication-spec.md). The
provider authentication, capability broker, agent registry, and persistence
contracts remain authoritative.

## Problem

The current Agent Builder mixes two different operations:

1. making a model, provider account, tool, plugin, or MCP server available to
   the Pi deployment; and
2. granting an already available resource to one deployed agent.

For example, Google OAuth configuration is rendered below the complete agent
capability list inside a collapsed Providers section, while a separate generic
Provider Accounts form appears under Connections. A user can reasonably enter
Google metadata in the generic form, see Gmail capabilities marked `AVAILABLE`,
and believe Gmail is connected even though no OAuth tokens or active Google
account exist.

This creates three concrete failures:

- provider setup is difficult to discover;
- labels conflate installed implementations with callable capabilities; and
- credentials, provider health, and per-agent grants appear to have multiple
  owners.

## Goal

Make configuration discoverable and predictable without replacing existing
backend services or persistence.

The governing rule is:

> Settings determines what this Pi deployment can access. Agent Builder
> determines what one agent may use.

A user must be able to configure and connect Google Workspace in Settings,
return to Agent Builder, grant selected Gmail capabilities to an agent, deploy
it, and use those tools without entering provider IDs, scopes, environment
variable names, or secret references manually.

## Invariants

- The right workspace retains exactly three top-level tabs: Browser, Agents,
  and Agent Builder.
- Settings is opened from a gear icon immediately to the right of the Sessions
  add button.
- The Sessions add button continues to connect or start Pi sessions; it does
  not open configuration.
- Existing agent definitions, provider manifests, connection profiles,
  capability grants, plugin records, and legacy `.env.local` values remain
  readable through the credential migration contract.
- Provider configuration and OAuth remain host-owned operations and never enter
  model context.
- Agent Builder never becomes a second provider or credential manager.
- Pi chat and active agent work continue while Settings is open.
- Secret values remain write-only and are never returned to the browser.

## Scope model

Settings belongs to the `pi --serve` deployment rendering the page. It does not
silently configure another Pi process merely because that process is connected
as a chat session.

The Settings header displays:

```text
Settings · <project name>
<serve project path>
```

Each setting that is not project-scoped carries an explicit scope badge:

- **Project** — configuration and the optional encrypted workspace-vault
  overlay for the project that launched this serve host;
- **User** — resources installed under the user's Pi configuration; or
- **Deployment** — serve-host capability, policy, connection metadata, and
  runtime state.

Settings opened from a UI attached to a different serve host manages that host.
Connected chat sessions that cannot expose the authenticated management API are
not presented as configurable targets.

## Navigation

### Sessions header

Desktop and unfolded-foldable layouts render:

```text
Sessions                                      +  [gear]
```

- `+` has the accessible name `Connect another Pi session`.
- The gear has the accessible name `Open Settings` and a tooltip `Settings`.
- The gear uses the same compact icon-button dimensions as other toolbar
  actions.
- Settings activity or connection errors may add a small status indicator, but
  status is never communicated only by color.

On phone and narrow-fold layouts, both controls remain in the Sessions drawer
header. Neither is moved into the Browser, Agents, or Agent Builder tab row.

### Settings presentation

Settings opens as a dedicated workspace over the center and right columns while
the Sessions rail remains visible on layouts with sufficient width. On phone it
is a full-screen sheet. It has one close or back action that restores the exact
previous workspace and scroll position.

The Settings workspace uses one primary vertical scroll container. Subsections
must not introduce nested page-height scrollbars. Popovers, select menus, and
bounded logs may scroll independently when necessary.

The initial sections are:

1. **Models**
2. **Connections**
3. **Capabilities**
4. **Plugins & MCP**
5. **Security**

Desktop may use a compact internal rail. Phone and narrow fold layouts use a
selectable section header or horizontal icon toolbar with accessible labels.

Stable deep links use a settings section and optional resource ID, for example:

```text
#settings/connections/google-workspace
#settings/models/openai
#settings/capabilities/email.read
```

Agent Builder remediation actions use these links rather than duplicating
configuration forms.

## Settings sections

### Models

Models owns provider-level model availability, credentials, health, and safe
defaults. A provider card contains:

- provider icon and name;
- configuration and health state;
- number of usable models;
- configured default when one exists; and
- Configure, Test, Update, or Disable actions as supported.

Individual agents choose from usable models in Agent Builder. They do not edit
provider credentials there. A model retained by an existing agent but currently
unavailable remains visible with a remediation link and cannot be selected for
a new definition.

### Connections

Connections owns authenticated accounts and external endpoints. Each account
card contains:

- recognizable provider icon and name;
- account label, such as the connected email address;
- scope badge;
- connection and health state;
- concise granted-service summary;
- last successful validation when available; and
- provider-supported actions.

OAuth-managed providers never expose Provider ID, secret reference, raw scope,
or capability-ID fields on the normal path. The generic connection editor is
available only under an Advanced section for reviewed providers that genuinely
require manual connection metadata.

#### Google Workspace workflow

Google Workspace is one account card with grouped Gmail permissions. Future
Calendar, Drive, Contacts, and Chat groups appear only when their adapters are
installed.

The state machine is:

```text
Setup required -> Ready to connect -> Connecting -> Connected
                                      |               |
                                      v               v
                                    Failed       Needs attention
```

- **Setup required** shows Configure and lists missing OAuth client fields by
  label, never by secret value.
- **Ready to connect** shows Connect Google account.
- **Connecting** prevents duplicate authorization starts and provides Cancel.
- **Connected** shows the account email, selected permissions, Test, Update
  access, and Revoke.
- **Needs attention** preserves agent grants but prevents new calls and offers
  Reconnect.
- **Failed** explains the actionable cause without including codes, tokens, or
  provider response bodies containing secrets.

Connect opens the provider authorization page in a child window when the
browser permits it. The parent remains in Settings and refreshes redacted
status after callback completion. If a popup is blocked, the same authorization
URL may open in the current window and return to the deep-linked connection
card. The callback page contains no credentials.

For a loopback redirect such as `127.0.0.1`, Settings explains that
authorization must be completed on the host machine. A phone must not be sent
to a loopback callback that resolves to the phone itself. HTTPS reverse-proxy
deployments may use their registered callback according to the provider
authentication specification.

### Capabilities

Capabilities is the deployment catalogue, not an agent grant form. It groups
capabilities by category and source and supports search. Compact rows show:

- icon and capability name;
- read, write, external action, or destructive effect;
- selected provider;
- source type: built-in, plugin, MCP, API, or connection; and
- canonical readiness state.

Expanding a row shows description, provider alternatives, required connection,
health, and a Configure action that deep-links to the owning Settings section.
It does not show an agent checkbox.

### Plugins & MCP

Plugins & MCP owns installation and deployment-wide enablement. It keeps these
concepts distinct:

```text
plugin installation != provider configuration != agent grant
```

Plugin cards show source, pinned version, trust state, contributed capabilities,
required configuration, and install/update/disable/remove actions. MCP cards
show endpoint identity, authentication state, discovered tool count, read/write
classification, and health.

Installation, version updates, permission expansion, endpoint changes, and
removal require explicit confirmation. Installing or enabling a resource does
not grant it to existing agents.

### Security

Security presents existing security controls without exposing secret values:

- credential configuration status and storage scope;
- pending and recent approvals;
- browser and filesystem policy summaries;
- connection revocation controls;
- capability trust and review state; and
- concise audit or diagnostic references when available.

Credential status and lifecycle use the encrypted user vault and optional
workspace overlay defined by
[pi-credential-vault-spec.md](pi-credential-vault-spec.md). Legacy project
`.env.local` is exposed only through the explicit import and migration flow.

## Canonical status language

The browser must not use `AVAILABLE` for a capability that cannot yet be called.

| State | Meaning | Agent Builder behavior |
| --- | --- | --- |
| Ready | Adapter, provider, configuration, connection, review, and enablement requirements are satisfied | Selectable |
| Setup required | An implementation exists but configuration, authorization, review, or enablement is incomplete | Disabled with Configure link |
| Needs attention | A previously usable resource is unhealthy, expired, or revoked | Existing grant retained; new run blocked with Reconnect/Test action |
| Unavailable | Required adapter, executable, runtime, or platform support is absent | Disabled with installation requirement |
| Disabled | Operator intentionally disabled the resource | Disabled with Enable action in Settings |

Provider implementation health and account connection health remain distinct in
the API. The browser derives the canonical user-facing state in one formatter;
individual cards do not recreate the rules.

## Agent Builder

Agent Builder consumes configured resources and contains:

1. **Profile** — name, description, image, persona, and project folder.
2. **Runtime** — model, thinking level, executor, permissions, and browser
   environment.
3. **Capabilities** — per-agent grants for Ready tools, accounts, browser
   workflows, and skills.
4. **Delegation** — allowed agents, ACP targets, workflow limits, and A2A
   exposure.
5. **Automation** — routines and workflows targeting this agent.

The former Model & Tools section is split between Runtime and Capabilities. The
former Connections section is renamed Delegation and no longer contains global
provider-account management.

### Grant interaction

- Ready resources are selectable.
- Setup required, Needs attention, Unavailable, and Disabled resources remain
  discoverable but are not selectable for new grants.
- A disabled item includes a short reason and one Configure, Reconnect, Install,
  Review, or Enable action linking to Settings.
- Existing unresolved grants remain visible so editing an agent never silently
  deletes intent.
- Save and deploy validates every new grant against the authoritative broker.
- Agent Builder never asks for secrets or raw scope strings.

Selecting a connected account grants only the checked normalized capabilities.
It does not copy tokens or connection configuration into the agent definition.

## Interaction and visual design

- Cards are compact summaries; advanced fields and diagnostics are collapsed by
  default.
- Primary actions use text when the consequence is not obvious. Toolbar actions
  may use icons with accessible labels and tooltips.
- Provider branding uses the established icon for Google, OpenAI, Anthropic,
  Hermes, and other reviewed providers.
- Red is reserved for errors, destructive actions, Stop, and active recording.
- Connection state uses text plus icon or shape, never color alone.
- Forms use a single column at narrow widths and avoid two-column fields that
  force labels to wrap one word per line.
- Long provider names, paths, capability IDs, and account labels wrap or elide
  within their container; they never expand the workspace horizontally.
- The settings sheet and Agent Builder preserve the existing dark Pi theme and
  faded calligraphic Pi background.

## Responsive requirements

The supported layouts are desktop, phone portrait, phone landscape, folded
foldable, and unfolded Pixel Fold-class widths.

- No horizontal page scrolling.
- The Sessions drawer exposes both `+` and Settings gear.
- Settings becomes a full-screen sheet on narrow layouts.
- Section navigation remains reachable without scrolling to the bottom.
- OAuth actions and permission selectors remain at least 44 CSS pixels high on
  touch layouts.
- Sticky save or close controls do not obscure the last form control.
- Exactly one primary content scrollbar is visible.
- Returning from OAuth restores the Google Workspace card rather than the top
  of Agent Builder.

## API and persistence

The implementation reuses existing authenticated services and routes,
including:

```text
GET  /capabilities.json
GET  /capability-connections.json
GET  /capability-providers/:id/auth
PUT  /capability-providers/:id/configuration
POST /capability-providers/:id/authorize
GET  /capability-oauth/:id/callback
POST /capability-providers/:id/revoke
```

New endpoints are added only when an existing service lacks a high-level
operation required by the UI. The browser does not parse `.env.local`, edit
connection files, or infer credentials.

No persistence migration is required for the initial cleanup:

- provider secret values migrate to the encrypted credential vault while safe
  provider configuration remains readable;
- connection profiles retain their IDs and statuses;
- capability grants retain canonical capability and provider IDs;
- agent definitions retain unresolved historical grants; and
- plugin and MCP records remain authoritative.

The generic provider-account endpoint remains available for supported advanced
providers, but the normal Google path cannot create a manual OAuth connection.

## Security requirements

- Every Settings snapshot and mutation requires the serve capability token.
- OAuth callbacks require a valid, single-use, expiring state and follow the
  provider authentication specification.
- Browser payloads contain configured booleans and redacted metadata only.
- Secret inputs are cleared from the DOM after submission and are never placed
  in URLs, local storage, session storage, logs, task events, or transcripts.
- Connection and capability mutations are serialized where concurrent writes
  could lose updates.
- Revocation prevents new calls immediately, even when an agent definition
  retains the former grant.
- Settings does not gain an unrestricted environment-variable editor, package
  installer, filesystem browser, or shell.
- Deep links identify sections and public resource IDs only; they never contain
  tokens, OAuth codes, secrets, or account credentials.

## Design alternatives

### Alternative A: keep setup inline in Agent Builder

Each unavailable capability could expand into its provider configuration and
authentication form. This keeps the remediation nearby, but duplicates global
configuration across every agent, makes OAuth appear agent-owned, and leaves
the builder responsible for provider, plugin, connection, and grant lifecycle.

### Alternative B: add Settings as a fourth right-workspace tab

This centralizes configuration but treats Settings as another agent working
surface, crowds the tab row on mobile and foldable layouts, and keeps long forms
inside the narrow resizable details panel.

### Chosen design: Sessions-header Settings workspace

The gear beside Sessions `+` opens a dedicated Settings workspace. Configuration
has one owner, the three operational tabs remain focused, mobile navigation is
not crowded, and large forms gain sufficient width without replacing the Pi
session rail.

## Implementation plan

### Slice 1: navigation and shell

- Add the Settings gear beside Sessions `+`.
- Add the dedicated responsive Settings workspace, close behavior, section
  navigation, scope header, and deep-link routing.
- Preserve active session and workspace state while Settings is open.

### Slice 2: Models and Connections

- Move model-provider configuration into Settings > Models.
- Move provider-account lifecycle into Settings > Connections.
- Implement the Google Workspace account card and canonical OAuth states.
- Suppress the generic manual account form for OAuth-managed providers.

### Slice 3: Capabilities, Plugins & MCP, and Security

- Project broker, plugin, MCP, approval, and policy snapshots into their owning
  sections.
- Add search, compact cards, canonical status formatting, health, and high-level
  remediation actions.
- Keep advanced diagnostics collapsed.

### Slice 4: Agent Builder cleanup

- Replace Profile, Model & Tools, Connections, and Automation with Profile,
  Runtime, Capabilities, Delegation, and Automation.
- Remove global provider, plugin, MCP, and account mutation forms.
- Add disabled-resource explanations and Settings deep links.
- Preserve existing definition values and grant validation.

### Slice 5: responsive and accessibility hardening

- Remove nested full-height scrolling and overflow defects.
- Validate keyboard navigation, focus restoration, accessible names, tooltips,
  touch target sizes, status semantics, and reduced-width layouts.
- Validate desktop, phone, and Pixel Fold folded and unfolded presentations.

### Slice 6: tests and operator documentation

- Add focused endpoint, state derivation, navigation, OAuth presentation,
  persistence, and migration tests.
- Exercise the complete Google authorization flow manually with an
  operator-owned test account.
- Validate agent grant and Gmail read operation without sending or deleting
  mail.
- Run browser interaction checks and `npm run check`.
- Update README/operator documentation and screenshots after the UI is stable.

## Acceptance criteria

- The Sessions header contains `+` followed by a Settings gear with accessible
  labels and tooltips.
- Browser, Agents, and Agent Builder remain the only right-workspace tabs.
- Settings opens without stopping, replacing, or losing the active Pi session.
- A user can find Google Workspace under Settings > Connections without using
  capability search or scrolling through the full tool catalogue.
- Google setup clearly distinguishes OAuth client configuration from account
  authorization and displays the connected account email after callback.
- No normal Google workflow exposes Provider ID, secret reference, raw scope,
  capability-ID, or environment-variable fields.
- Capabilities that cannot be called are never labeled Ready or Available.
- Agent Builder contains no global credential, OAuth, plugin-installation, MCP,
  or provider-account forms.
- An agent can select a connected Google account, receive specific Gmail
  grants, deploy, and execute an approved read-only Gmail operation.
- Existing agents and connection profiles load without destructive migration.
- Configuration and connection state survive serve-host restart.
- Desktop, phone, and Pixel Fold layouts have no horizontal overflow or nested
  page-height scroll traps.
- Focused tests and `npm run check` pass.

## Deliberate non-goals

- Replacing the provider authentication or capability broker services.
- Introducing OpenBot, CopilotKit, AG-UI, PostgreSQL, or a Docker requirement.
- Reimplementing vault cryptography or credential release inside the Settings
  browser; Settings calls the credential broker's high-level operations.
- Configuring arbitrary connected Pi chat sessions from the current host.
- Automatically granting newly installed tools to existing agents.
- Enabling unavailable Google service groups before their adapters exist.
