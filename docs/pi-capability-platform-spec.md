# Pi capability platform: web and productivity waves

## Status

Implementation contract for adding reviewed extensions, MCP servers, and hosted
connections to the `pi --serve` workspace without coupling agents, routines, or
the UI to a particular vendor. This specification deepens Slice 2A of the
[agent workspace specification](pi-agent-workspace-spec.md).

Wave 1 foundation and everyday-web validation completed on 2026-08-23. The
canonical registry, provider trust state, immutable-source checks, quarantine,
agent grants, executor projection, audit persistence, restart recovery, and
responsive Agent Builder controls are implemented. The existing Firecrawl
provider is reviewed and enabled for `web.search`, `web.fetch`, and
`web.scrape`; `web.crawl` remains unavailable because the loaded provider does
not expose `firecrawl_crawl`. MCP, context pruning, notifications, and browser
annotations remain fail-closed until their reviewed providers are installed.

Wave 2 host implementation and validation completed on 2026-08-23. It adds
durable secret-reference connection profiles, connection-scoped agent grants,
target-bound approval receipts with stable idempotency keys, signed and
deduplicated inbound routing, unattended routine policy, routine availability
recovery after connection revocation, bounded Open-Meteo/NWS weather, RSS/Atom
reading, site-change monitoring, and an attachment scanning hook. The same
weather and feed grants were exercised through Pi, a deployed Luna agent, and
a routine; signed inbound delivery to an agent and duplicate suppression were
also exercised across the live host boundary.

Agent Builder now provides connected controls for editing and reconnecting
provider accounts, selecting enabled default providers, reviewing approval
receipts, configuring fixed inbound routes, and managing durable site monitors
and finance watchlists. These controls share the host registries and recover
after restart; they do not keep a second browser-only configuration copy.

Google Workspace, Microsoft 365, Drive, Dropbox, Box, task, messaging, events,
and finance manifests are present but remain unavailable until their reviewed
connector tools and account authorization are configured. Consequential
provider bindings remain fail-closed unless the adapter enforces an approval
receipt; the presence of a raw send, delete, share, or update tool is not
sufficient to activate it.

## Problem

The current capability catalog can report tools, skills, extensions, plugins,
ACP connections, and model providers. Deployed agents persist a tool-name
allowlist. That is sufficient while every tool has one implementation, but it
does not safely handle overlapping packages or consequential productivity
actions.

For example, two web extensions may both register `web_search`. Directly
installing both makes Pi fail at extension load. Persisting either raw name in
an agent or routine also makes that definition depend on the selected package.
Email creates a second problem: `email_search` and `email_send` cannot be
treated as equivalent grants merely because they come from one connection.

The solution is a capability broker between installed providers and consumers.
The UI, agents, routines, workflows, and Pi use stable capability IDs. Provider
adapters own vendor-specific tool names, authentication, and health. The broker
resolves one provider, enforces the grant and action policy, and invokes the
underlying tool.

## Goals

- Add a reviewed first wave of web, MCP, context, notification, and optional
  browser-annotation capabilities.
- Add a second wave of communication, productivity, monitoring, and everyday
  data capabilities.
- Keep Browser, Agents, and Agent Builder responsive and usable as the catalog
  grows.
- Let deployed agents, Pi, routines, and workflows use the same capability and
  approval contracts.
- Prevent duplicate tools, hidden permission expansion, secret disclosure,
  unreviewed package execution, and unsafe path access.
- Preserve capability state, grants, connections, health, and routine
  validation across restart.

## Non-goals

- A general package marketplace or automatic installation from model output.
- Granting every installed plugin to every agent.
- Browser-recorded login, payment, banking, or account-recovery automation.
- Silent fallback from a failed provider to one with different data or security
  semantics.
- Multi-user authorization. The local capability token remains a single-user
  control credential.

## Design alternatives

### Alternative A: expose installed extension tools directly

Agent Builder lists every raw tool and agents store those names. This requires
the least new host code, but duplicate registrations prevent startup, vendor
names leak into routines, and permission review becomes a long unstructured
checkbox list. Replacing a provider invalidates existing definitions.

### Alternative B: canonical capability broker

Providers publish manifests that map their tools to stable capability IDs. A
broker validates manifests, resolves the configured provider, evaluates agent
grants and action policy, and only then invokes the provider adapter. Raw tools
remain available to an intentionally configured Pi session, but deployed
agents and automations use brokered IDs.

**Decision:** use Alternative B. The broker is one deeper module that hides
provider selection, collision handling, connection health, and approval policy
from all consumers. This avoids separate plugin logic in Agent Builder,
routines, workflows, and agent execution.

## Architecture

```text
CapabilityCatalog
  └─ secret-free inventory and UI snapshots

CapabilityBroker
  ├─ CapabilityRegistry     canonical definitions and categories
  ├─ ProviderRegistry       reviewed manifests, versions, trust, health
  ├─ ConnectionBroker       secret references and authenticated sessions
  ├─ GrantService           per-agent capability and provider constraints
  ├─ ApprovalService        action risk and operator confirmations
  └─ ProviderAdapter        canonical request → underlying tool/MCP/API call

Consumers
  ├─ active Pi session
  ├─ AgentTaskService executor
  ├─ CronRoutineService
  ├─ WorkflowService
  └─ Agent Builder host operations
```

`CapabilityCatalog` stays read-only and secret-free. `CapabilityBroker` owns
resolution and invocation. `PluginManagementService` owns reviewed package
lifecycle but does not grant tools. `ConnectionBroker` stores only references
to credentials held by the OS credential store or a separately configured
secret provider.

### Canonical capability definition

```ts
interface CapabilityDefinition {
  id: string;
  version: number;
  category: CapabilityCategory;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effects: CapabilityEffect[];
  defaultApproval: ApprovalMode;
}
```

Initial categories are:

- Web & browser
- Files & development
- Communication
- Productivity
- Monitoring
- Data & finance
- Local system
- Plugins & MCP

Effects are independently reviewable: `read-local`, `write-local`,
`read-remote`, `write-remote`, `send-external`, `delete-remote`,
`financial-read`, `financial-write`, `credential-use`, and `browser-control`.

### Provider manifest

```ts
interface CapabilityProviderManifest {
  id: string;
  displayName: string;
  source: string;
  version: string;
  sourceDigest: string;
  trust: "unreviewed" | "quarantined" | "reviewed" | "enabled";
  provides: ProviderCapability[];
  requires: ProviderRequirement[];
  conflicts: ProviderConflict[];
  permissions: CapabilityEffect[];
}
```

Manifests are data, not executable install scripts. The host derives manifests
for legacy Pi extensions during review; a package-provided manifest is still
validated against observed tools and permissions. Unknown fields, duplicate
provider IDs, undeclared tools, or permission expansion fail closed.

### Grants

Agent definitions move from an ambiguous raw `tools: string[]` list toward
versioned grants:

```ts
interface AgentCapabilityGrant {
  capabilityId: string;
  capabilityVersion: number;
  providerId?: string;
  approval?: ApprovalMode;
  connectionId?: string;
}
```

The transition reader accepts existing built-in tool names and projects them
as legacy grants. Saving an edited definition writes normalized grants. A
provider pin is optional. Without one, the broker uses the configured default
provider for the capability. A routine stores the same grant reference and may
pin a provider when reproducibility requires it.

### Provider resolution

For each invocation the broker:

1. validates the canonical request schema and size limits;
2. resolves the agent, Pi session, routine, or workflow grant;
3. resolves an explicit provider pin or the one configured default;
4. verifies provider trust, version, health, executor compatibility, and
   connection state;
5. evaluates the capability effects and approval policy;
6. invokes the adapter with a bounded context and secret reference; and
7. records a redacted audit event, result metadata, and artifacts.

There is exactly one default provider per canonical capability. Multiple
providers may remain installed. Provider-specific tools are namespaced and are
not registered under the same raw name. An unavailable default produces a
visible failure and remediation action; it does not silently change providers.

## Trust and supply-chain review

The lifecycle is `unreviewed → quarantined → reviewed → enabled`.

- Install exact package versions or commit digests only.
- Review source, manifest, license, dependencies, lifecycle scripts, network
  destinations, filesystem access, subprocess execution, credential handling,
  telemetry, update behavior, and tool-output size.
- Install dependencies with scripts disabled. A required lifecycle script must
  be separately reviewed and allowlisted.
- Exercise adapters with fake credentials and local test endpoints while
  quarantined.
- Record reviewer, source digest, manifest digest, review date, and approved
  permissions.
- Any source, dependency, tool, destination, or permission change returns the
  provider to quarantined state.
- Models may recommend a provider but cannot approve, enable, update, or remove
  one.

Package instructions, tool output, web content, email, chat, and documents are
untrusted data. They cannot modify system instructions, grants, approval
policy, provider selection, or secret handling.

## UI contract

The three right-workspace tabs remain **Browser**, **Agents**, and **Agent
Builder**. No wave adds another top-level tab.

Agent Builder > Model & Tools displays capability groups as collapsed sections.
Each compact row shows an icon, canonical name, provider, state, risk marker,
and enable control. Expansion shows the description, individual effects,
connection health, source/version, review status, provider selector, and the
agent grant. A search field filters canonical names, providers, and categories.

The UI must distinguish these states:

```text
Not installed → Quarantined → Reviewed → Enabled
Not connected → Connected → Unhealthy
Not granted → Granted → Approval required
Conflict / update review required / unavailable
```

Secondary install, update, connect, review, disable, and remove actions live in
the row's three-dot menu. Consequential approval uses an explicit dialog with
target, action, account, and effect; it is not an icon-only action.

Catalog loading, filtering, provider health checks, and grant saves must not
wait behind an active Pi turn or agent task. Snapshots are versioned and
updated through host events. A failed provider card cannot prevent other
categories, agent chats, Browser, or Agent Builder from rendering.

Phone and unfolded-foldable layouts retain chat as the primary surface. The
workspace remains a dismissible side panel; capability rows use one column,
keep controls at least 44 px, and do not introduce horizontal scrolling.

## Agent and automation contract

- The executor receives only granted canonical capabilities and the minimum
  provider metadata needed to select them.
- Tool descriptions identify effects and approval behavior but never contain
  credentials or browser-visible secret references.
- Harness agents may receive only adapters supported by their confinement
  policy. A connection does not expand filesystem or browser access.
- Pi may use its existing direct tools. Brokered capabilities are recommended
  when work must be portable to agents, routines, workflows, or containers.
- Agent Builder validates every required capability before deployment.
- Routines and workflows validate provider, connection, and approval
  compatibility before enablement. Unattended execution cannot use an
  `always-confirm` action.
- AgentTaskService records provider ID, manifest digest, capability ID/version,
  approval receipt, result metadata, and error class with each invocation.
- A2A callers cannot gain capabilities beyond the target agent's grants.

## Persistence and restart recovery

```text
~/.pi/agent/serve/
  capabilities/definitions/<capability-id>.json
  capabilities/providers/<provider-id>.json
  capabilities/defaults.json
  capabilities/reviews/<provider-id>/<source-digest>.json
  capabilities/grants/<agent-id>.json
  connections/<connection-id>.json
  audit/capability-events.jsonl
```

Credentials are not stored in these files. State replacement is atomic.
Startup validates all definitions, manifests, defaults, grants, and secret
references before enabling invocation. Missing packages, changed digests, or
unavailable connections preserve definitions but mark affected grants
unavailable. A partial update returns the provider to its last verified state
or disables it; it never leaves executable unreviewed code enabled.

## Wave 1: capability foundation and everyday web

Wave 1 establishes the broker and adds low-to-medium-risk capabilities useful
to most Pi and frontend-development sessions.

### Wave 1 capability set

| Canonical capability | Initial provider direction | Default effects |
|---|---|---|
| `web.search` | reviewed `@juicesharp/rpiv-web-tools` adapter; SearXNG may be the local default | `read-remote` |
| `web.fetch` | same provider layer | `read-remote` |
| `web.scrape` | reviewed `@narumitw/pi-firecrawl` adapter | `read-remote`, `credential-use` |
| `web.crawl` | reviewed Firecrawl adapter with strict bounds | `read-remote`, `credential-use` |
| `mcp.discover` / `mcp.call` | reviewed `pi-mcp-adapter` integration | derived per server/tool |
| `context.prune` | reviewed `pi-context-prune` integration | local context mutation |
| `notifications.send` | reviewed platform notification adapter | `send-external` or local notification |
| `browser.annotate` | optional reviewed annotation bridge | `browser-control`, `read-local` |

`rpiv-web-tools` and Firecrawl are complementary: the first owns routine search
and fetch provider selection; Firecrawl supplies advanced scrape, map, and
bounded crawl operations. `pi-web-access`, Tavily-specific extensions, and
other packages that register the same raw tools are comparison fixtures, not
simultaneous defaults. Existing managed browser control remains authoritative;
Chrome/CDP extensions are not installed beside it unless a separately
namespaced compatibility provider is approved.

Community subagent and flow packages are design references only. Existing Pi
Agents task, workflow, transcript, routine, persona, and A2A services remain
authoritative.

### Wave 1 implementation slices

1. **Canonical registry** — definitions, manifest validator, categories,
   effects, collision detection, and versioned secret-free snapshots.
2. **Provider lifecycle** — pinned installation, quarantine, review evidence,
   enable/disable/update, health, default selection, and rollback.
3. **Grants and invocation** — normalized agent grants, broker resolution,
   approval receipts, audit events, executor projection, and legacy tool
   migration.
4. **Agent Builder UI** — grouped cards, search, provider selection, trust and
   health state, explicit lifecycle dialogs, responsive layout, and events.
5. **Web and MCP adapters** — search/fetch, bounded Firecrawl operations, lazy
   MCP discovery/calls, URL and SSRF controls, output limits, and local test
   providers.
6. **Context, notifications, and annotation** — enable individually after
   review; keep optional features absent from model context when disabled.
7. **Recovery and hardening** — atomic persistence, digest invalidation,
   restart recovery, connection failure behavior, UI isolation, and operator
   documentation.

### Wave 1 completion gate

- Existing agents using built-in tools still load and run.
- Two providers for one canonical capability can be installed without a raw
  tool-name collision, but only one is the default.
- A provider update that expands permissions cannot run until reviewed.
- Pi and a deployed test agent can perform `web.search` and `web.fetch` through
  the broker and receive the same normalized result contract.
- A routine using a pinned capability resumes after restart and fails clearly
  when its provider or connection is unavailable.
- Browser, Agents, and Agent Builder remain operable while another agent task,
  health check, or provider call is running.

## Wave 2: communication and productivity

Wave 2 uses the Wave 1 broker; it does not add vendor-specific execution paths.
Every integration starts read-only, then enables narrowly separated write
capabilities after review.

### Wave 2 capability groups

#### Email

Provide separate `email.search`, `email.read`, `email.draft`, `email.send`,
`email.attach`, and `email.delete` capabilities for Google and Microsoft
providers. Draft is the default write grant. Send, delete, forwarding to a new
recipient, and attachment upload require explicit target-aware confirmation.

#### Calendar and contacts

Provide `calendar.read`, `calendar.availability`, `calendar.create`,
`calendar.update`, `calendar.delete`, `contacts.search`, and `contacts.read`.
Creating, updating, deleting, inviting attendees, or changing meeting links is
separate from availability lookup and requires confirmation.

#### Files and knowledge

Provide search/read and separate write/share/delete capabilities for Google
Drive, OneDrive/SharePoint, Dropbox, and Box. Downloaded files enter the task as
bounded artifacts. Agent filesystem grants do not automatically authorize
cloud writes or shares.

#### Tasks and projects

Provide read/create/update/complete/delete capabilities for Todoist, Asana,
Trello, and ClickUp through provider adapters. Project or workspace scope is
part of the connection grant. Destructive and bulk changes require approval.

#### Messaging

Provide channel history/search and separate draft/send capabilities for Slack,
Teams, Google Chat, and Telegram. SMS/MMS uses an approved provider such as
Twilio, with verified inbound webhooks, destination allowlists, opt-out and
rate controls, and explicit send confirmation. Incoming messages map to a
configured Pi session, agent, or coordinator; they never select an arbitrary
agent from message text.

#### Monitoring and everyday data

- `weather.current`, `weather.forecast`, and `weather.alerts` use Open-Meteo
  and official NWS data where applicable.
- `feeds.read` and `sites.monitor` use bounded RSS/Atom and explicit site-change
  definitions.
- `events.search` uses configured local-event providers with location and time
  scope.
- `finance.quotes`, `finance.filings`, and `finance.watchlist` are read-only
  market and SEC monitoring capabilities.

Financial account aggregation and banking form a separate high-risk group.
Only official API/OAuth providers are allowed. They start read-only, keep
credentials in the OS secret store, and never use recorded browser workflows
for login, payment, transfer, or account changes. Transfers, payments, trades,
and account changes are deferred until a dedicated transaction specification.

### Wave 2 implementation slices

1. **Connection profiles** — provider OAuth/API setup, secret references,
   scopes, account identity, health, revoke, and reconnection.
2. **Read-only productivity** — email/calendar/contact/cloud-file/task search
   and read adapters with normalized pagination and bounded artifacts.
3. **Draft and write actions** — draft/create/update capabilities, previews,
   idempotency keys, target-aware confirmation, and audit receipts.
4. **Messaging and inbound routing** — chat plus SMS/MMS adapters, signed
   webhook verification, allowlists, rate limits, routing, and coordinator
   handoff.
5. **Monitoring and everyday data** — weather, feeds, site changes, events,
   quotes, filings, and watchlists integrated with routines.
6. **Cloud files and attachments** — safe names, MIME and size validation,
   malware-scanning hook, artifact lifecycle, share policy, and path controls.
7. **Recovery and hardening** — token refresh, revoked scopes, duplicate-event
   handling, missed schedules, provider outage behavior, mobile UI, and
   documentation.

### Wave 2 completion gate

- Pi and a granted agent can search and read from each enabled connection
  without receiving its credential material.
- Email and messaging default to draft; send requires a visible recipient and
  approval receipt.
- A routine can run weather, feed, or site monitoring unattended because its
  grants are read-only, while an unattended send action is rejected.
- Duplicate inbound webhooks and retried write requests are idempotent.
- Revoking a connection immediately removes its tools from new agent turns and
  marks dependent routines unavailable without deleting their definitions.
- Capability search and grouped cards remain usable with at least 250 provider
  tools and on phone, unfolded foldable, and desktop viewports.

## Validation strategy

### Unit tests

- manifest/schema validation, canonical ID/version rules, effects, and
  collisions;
- provider resolution, defaults, pins, incompatibility, and no silent fallback;
- grant migration and validation for session and harness executors;
- approval matrices, unattended-run restrictions, and receipt expiry;
- path, URL, SSRF, artifact size/MIME, secret-redaction, and webhook signature
  validation;
- atomic storage, corrupt records, digest changes, and restart recovery.

### Integration tests

- plugin lifecycle from quarantine through enablement using a fixture package;
- Pi and agent invocation through the same fake provider adapter;
- routine/workflow validation and execution through brokered capabilities;
- MCP lazy discovery without exposing ungranted tools;
- OAuth refresh/revoke and unhealthy-connection recovery using fake endpoints;
- idempotent email/message writes and duplicate inbound webhook delivery;
- concurrent agent tasks while catalog, grant, and connection operations remain
  responsive.

Tests use fake credentials and local providers. Real paid APIs are optional
manual smoke tests and are never required by the automated suite.

### Browser interaction tests

- desktop, phone, and unfolded Pixel Fold layouts;
- Browser, Agents, and Agent Builder switching during a running tool call;
- capability search, category collapse, provider selection, approval, grant
  save, error recovery, and restart refresh;
- no placeholder cards, disconnected controls, horizontal mobile overflow, or
  secrets in DOM snapshots;
- keyboard navigation, focus restoration, tooltips, accessible names, status
  text, and 44 px mobile targets.

### Release gates for each wave

1. focused unit and integration tests pass;
2. `npm run check` reports no errors, warnings, or infos;
3. a live `pi --serve` smoke test completes from a clean restart;
4. Pi and deployed-agent capability calls complete through the broker;
5. browser interaction validation passes on desktop and mobile widths;
6. persisted definitions, grants, connections, routines, results, and audit
   metadata recover after restart; and
7. documentation identifies enabled providers, permissions, security boundary,
   rollback, and known limitations.

Wave 2 cannot begin implementation until the Wave 1 broker, trust lifecycle,
grant model, UI regression suite, and restart recovery pass their completion
gate.
