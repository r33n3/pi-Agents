# Model capability accuracy goal

Status: superseded as the active goal on 2026-08-31. This file is retained as the detailed implementation and validation archive. The bounded release goal is [pi-model-settings-agent-improvement-goal.md](pi-model-settings-agent-improvement-goal.md). Implementation branch: `codex/model-capability-accuracy`.

## Outcome

Every model Pi offers has accurate capabilities, valid controls, and correct request/cost handling for its connection type. Catalog presence, configured credentials, confirmed account access, and live-tested behavior are separate facts.

Example: OpenAI Fast mode changes processing service, not reasoning effort. Choosing high effort must not silently enable premium processing. A Fast request can report `priority`, or `default` after a downgrade; Pi must show what actually ran.

## Design decision

Keep the upstream generated catalog and existing ModelRuntime. Extend their shared capability contract and apply narrow, source-dated corrections where required. Resolve provider/connection-specific settings before requests; use that same result for browser chat, Agent Builder, saved agents, and CLI.

Rejected alternative: a second browser-only registry. It would duplicate model policy and diverge again on refresh. Replacing the complete upstream catalog is also unnecessary and would make upstream alignment harder.

The current thinking-level map remains useful, but is not enough to describe independent reasoning modes, effort, budgets, processing tiers, defaults, option interactions, provenance, or verification state. Unknown support must not become advertised support merely because a model name resembles another model.

## Acceptance criteria

- Inventory bundled, cached, custom, and discovered models, with private inventories excluded from Git. Include IDs/aliases, limits, modalities, tools, structured output, reasoning, speed tiers, pricing, and retirement status.
- Record source, verification date, connection type, and confidence for reviewed capabilities. Prefer provider discovery when it actually supplies capability metadata; a model-list ID alone is not enough.
- Validate catalog refreshes atomically and preserve the last valid catalog offline. Preserve explicit private overrides. Validate cached input and disclose stale/unverified data.
- Expose only options supported by both the selected connection/model and Pi's adapter. Keep mode, effort, token budget, and processing speed separate. Do not call thought-display suppression “thinking off.”
- Validate options on the backend as well as in the UI. On model switch or saved-agent reuse, disclose unsupported values and require a valid replacement rather than silently increasing effort or cost.
- Preserve settings through chat, Agent Builder review/edit, saved-agent execution, and CLI. No automatic opt-in to premium processing.
- Track requested versus effective options and the actual response tier. Show estimated, unknown, and provider-reported costs distinctly; never count negative unknown-price sentinels as savings.
- Deterministic tests cover each advertised option and representative interactions, model switching, persistence, refresh, failures, and Fast/priority/default response handling.
- Full `npm run check` and affected tests pass. Desktop and mobile workflows are verified. Paid provider checks require a user-approved cost limit and are reported separately from offline checks.
- Keep all personal agents, credentials, private catalogs, live transcripts, and account details out of public fixtures and commits.

## Baseline inventory

Bundled chat catalog generated 2026-08-30T12:51:09.280Z, inspected 2026-08-31:

- 39 provider catalogs; 1,291 model entries (provider/model pairs, not unique foundation models).
- 1,035 reasoning entries; 738 inherit at least one generic lower-level thinking default. This is a review queue, not proof those entries are incorrect.
- Two automatic-router entries contain negative unknown-price sentinels after per-million conversion. Preserve their availability while making unknown pricing explicit.
- Dynamic-only providers, image-generation catalogs, private overrides/caches, and account entitlements are not covered by this initial inventory.

Reproduce without credentials or provider requests:

```sh
node scripts/audit-model-capabilities.mjs
node scripts/audit-model-capabilities.mjs --json
```

The version-2 JSON output lists every bundled entry, effective legacy thinking levels, inherited defaults, remaps, native-control coverage/evidence dates, structural errors, and unknown pricing. It does not claim whole-model verification or emit endpoints, headers, arbitrary evidence references, or request payloads. Current native-control coverage is 27 entries: three OpenAI, eleven Google, and thirteen Anthropic. The shared price classifier marks 112 entries unknown, including unclassified all-zero rates as well as the two negative router sentinels; explicit zero-price overrides remain distinguishable.

## Findings and implementation tracking

| Priority | Finding | Work / status |
| --- | --- | --- |
| P1 | Browser lists the same four thinking choices for every reasoning model. | Changed to the shared runtime helper; regression coverage includes all bundled models and custom overrides. |
| P1 | Remote refresh previously checked only that each entry had an ID, silently discarding malformed entries. | Shared validation covers fetched, cached, and published snapshots. Retained warnings and source/age disclosures reach chat and Builder. Unavailable-endpoint checks no longer invalidate last-good body age. Full composition and recovery coverage remains open. |
| P1 | Generic defaults/remaps can overstate real provider options, including whether thinking can be disabled. | Provider/adapter verification and explicit capability metadata remain open. |
| P1 | Reasoning mode and speed tier are not first-class shared controls. | Shared schemas/evidence plus native OpenAI Responses, Google Generate Content, and Anthropic Messages paths are implemented, including reviewed Anthropic Fast speed. Other adapters, access disclosure, and full user-facing workflows remain open. |
| P1 | Unknown router prices are negative; browser protocol only permits non-negative prices. | Shared cost status and normalization prevent negative credits or false free-price claims. Mixed-session aggregation, billed-cost ingestion, and exact processing-tier pricing remain open. |
| P1 | Browser projection drops context-dependent pricing tiers. | Shared projection preserves tiers/status and the price tooltip lists thresholds. Desktop/mobile rendering still needs validation. |
| P1 | Model availability currently largely means provider credentials are configured. | Separate access evidence and verification status remain open. |
| P1 | CLI could not select native controls, and fallback custom IDs could inherit another model's option claims. | Native flags, explicit replacement/default/legacy semantics, SDK pre-persistence validation, and capability isolation for fallback IDs are implemented. Newer harness support and CLI/TUI disclosure remain open. |
| P2 | No per-capability source/date/freshness or reviewed coverage report. | Per-model catalog lineage, source-window freshness, and warning UI are implemented. Catalog age is distinct from capability review; complete per-capability evidence/confidence and coverage remain open. |
| P2 | Reopened saved candidate displays “Unsaved changes” without new edits. | Fixed: restoring a linked candidate now records its saved form as the clean baseline, separately from the active agent. Desktop/mobile save, reload, edit, and revert checks passed with the optional capabilities service deliberately unavailable. |

## Native-control foundation (2026-08-31)

The shared runtime resolves explicit model controls first, then a narrow reviewed overlay for exact first-party OpenAI Responses connections. Current reviewed coverage is GPT-5.6 Sol/Terra/Luna reasoning mode and effort, plus Sol processing tiers. It is not a claim that the other 1,288 catalog entries are verified, or that every account can access these models.

- `reasoningMode`, `reasoningEffort`, `reasoningBudget`, and `processingTier` have separate schemas. Choices carry an evidence kind, reference, and review date. Missing controls mean unverified or unimplemented, not supported.
- Public API evidence does not transfer to Codex OAuth, gateways, different endpoints, or similarly named models. Resolved authentication endpoints are rechecked before dispatch.
- Private `models.json` definitions and topmost model overrides preserve their own controls. An explicit empty override disables native controls. Returned options are limited to adapter-implemented values without mutating private metadata.
- Backend validation rejects unsupported native selections before auth resolution in Models/ModelRuntime and before provider dispatch. Payload hooks cannot change an explicitly selected native option silently.
- OpenAI Responses sends mode, effort, and processing tier independently. Omitted native settings preserve provider defaults. Native controls cannot be combined with the legacy simple thinking selector; that ambiguous request fails rather than silently changing effort.
- Assistant execution metadata separates requested, serialized, and provider-reported settings. Missing response metadata stays unknown. The reported processing tier takes precedence for current cost estimates, including Fast/priority aliases and default-tier downgrades.
- The browser protocol carries capabilities, selected settings, and execution metadata without model endpoints or credential headers. Session commands and backend persistence are connected; user-facing controls are still pending.

The OpenAI SDK was updated from exact version 6.40.0 to 7.8.0 after reviewing the release notes and API types. It now types reasoning mode, max effort, Fast service tier, and explicit prompt-cache options directly. Its Node 22 minimum fits Pi's existing Node 22.19 minimum. Installation used `--ignore-scripts`; no lifecycle scripts ran. The lockfile, shrinkwrap, and install-lock changes are limited to the SDK pin and its metadata; no `undici` version changed.

Still open: remaining provider/connection coverage, semantic option interactions, general capability/access/freshness evidence, cache-warning UI, whole-file corruption recovery guidance, mixed-session and processing-tier pricing, legacy normalization disclosure, chat/Builder/agent/CLI settings persistence, and desktop/mobile lifecycle verification. Existing legacy thinking behavior outside native-control requests has not been removed or presented as verified.

## Catalog recovery and price accounting (2026-08-31)

- Shared validation rejects duplicate IDs, provider mismatches, malformed metadata, invalid timestamps, and unsafe ETags before replacing a catalog. Provider-owned publications validate before either persistence or synchronous state changes.
- Unreadable/invalid cached snapshots produce warnings and allow independent provider refreshes. Last-good in-memory data remains usable. Valid fetched data can repair a malformed provider entry inside a valid store file.
- File storage preserves malformed whole-file content instead of overwriting it. It isolates provider errors and safely handles prototype-like provider IDs. Whole-file automatic quarantine/repair is not implemented.
- Remote checks do not trust future timestamps or an HTTP 304 without a usable cached body and validator. Failed requests do not advance freshness timestamps or suppress the next retry. Warning results exist, but startup warning retention and user-facing freshness diagnostics are not connected yet.
- A dependency-free shared pricing module classifies estimated, unknown, and explicitly reported costs. Unknown values never become credits; explicit zero-price estimates are distinct from missing rates. No adapter newly ingests actual billed-cost fields yet.
- Core calculation preserves context-tier thresholds and marks missing rates, invalid usage, and non-finite results unknown. Protocol transport retains price tiers and status. Browser pricing uses the pure module directly rather than importing provider SDKs.
- The current-session service now uses the existing server model projection, removing duplicate capability/pricing projection. Its `authenticated` flag still indicates a configured connection, not proven account access.
- A session-price helper supports partial known subtotals, but transcript aggregation has not yet been wired to it. CLI/TUI totals and provider-specific processing premiums still require review.

## Google native controls (2026-08-31)

The exact-ID public Generate Content overlay covers eight Gemini 3 entries and three Gemini 2.5 entries. It does not transfer to Vertex, gateways, rolling aliases, or other endpoints.

The reviewed table allows `medium` for Gemini 3.1 Pro and excludes `minimal` for Gemini 3.7 Flash. Gemini 2.5 uses a budget with model-specific ranges and explicitly declared automatic/disabled sentinel values. A budget is guidance, not a guaranteed usage ceiling. [Google thinking reference](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

Native requests preserve defaults and reject unsupported values, level-plus-budget combinations, mixed legacy/native settings, and payload-hook model or thinking changes. SDK serialization is tested offline; execution metadata records requested and sent values without inferring provider-reported settings from token counts. Legacy thought suppression remains unchanged, but its serialized thinking setting is now recorded rather than described as actual thinking-off. The browser still uses the legacy selector until the native settings workflow is connected.

## Anthropic native controls (2026-08-31)

The exact-ID, public API-key overlay covers all thirteen bundled Anthropic entries. It does not transfer API-key evidence to OAuth, alternate injected clients, gateways, or future model names. Explicit private overrides remain authoritative within adapter-supported syntax.

- Thinking mode and effort are independent. Opus 4.5 supports effort with manual thinking; Sonnet/Haiku 4.5 do not advertise effort. Fable 5 cannot disable thinking. Opus 5 rejects disabled thinking with `xhigh` or `max`. [Thinking configuration table](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), [effort reference](https://platform.claude.com/docs/en/build-with-claude/effort).
- Manual thinking requires an explicit budget of at least 1,024. Its ceiling depends on final request settings, so capability metadata can omit a fixed maximum. Budgets must stay below the output cap unless that model/request supports manual interleaving with tools. Required beta headers survive caller header overrides. Google retains its separate numeric auto/off sentinels. [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
- Native requests preserve provider defaults and thought-display defaults. Invalid mode/effort/budget combinations, conflicting temperature or forced-tool choices, mixed legacy/native controls, changed models, and payload-hook attempts to introduce speed/tier changes fail before dispatch. Requested and serialized settings are recorded separately; provider-reported settings are not inferred.
- Anthropic Fast was initially unimplemented; the later Fast slice below adds its separate `speed` mapping and pricing treatment. Priority-capacity `service_tier` is not the same option. [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode).

These are source-reviewed options and deterministic serialization tests, not account-access or live-behavior verification. The installed Anthropic SDK already types the required effort values; no dependency change was needed for this slice.

## Agent/session settings persistence (2026-08-31)

Problem: serializing controls correctly is insufficient if the next tool turn or session restore silently returns to a generic thinking level. A resolved legacy default is not an explicit request to erase native settings.

- Agent state distinguishes absent native settings (legacy), an empty native object (provider defaults), and selected native values. State assignment/read and request snapshots copy selections. Malformed state fails without replacing valid settings.
- Every native agent turn validates against its current model before credential lookup. Unsupported model changes stop with normal error events and preserve the requested values. Turn-boundary updates can explicitly replace settings or return to legacy settings with their budget overrides.
- Session logs store `model_controls_change` entries separately from LLM messages. Settings survive disk reopen, branch extraction, and compaction; malformed active entries fail rather than silently enabling defaults. Only an explicit null clears native mode. SDK restoration therefore does not mistake a resolved legacy default for user intent.
- AgentSession setters persist changes. Model changes can carry replacement controls together; incompatible changes fail before auth and state mutation. Explicit legacy-selector changes clear native mode. Compaction and branch-summary requests inherit native settings instead of injecting legacy effort.
- Tree navigation retains current user model preferences and records them on the new branch, so reopening cannot reactivate historical Fast settings. Raw session-tree reads still reconstruct the settings on the selected historical branch.
- The proxy transport forwards native selections and retains execution metadata on success and error. No requested tier is relabeled as provider-reported.

This is the backend persistence path, not a finished UI. Saved-agent package fields are connected in the later slice below. Visible chat/Builder controls, CLI flags/status, newer harness session-format integration, full replacement flows, and desktop/mobile tests remain open. The complexity review kept validation shared and reused existing AgentSession/session-log paths rather than introducing a separate browser settings policy.

## Browser session settings transport (2026-08-31)

Problem: a retained native selection was invisible to browser clients, and the serve transcript mapper discarded requested/sent/reported settings and pricing status.

- Session snapshots now expose native selections. Create and model-change commands accept controls; `set_model_controls` replaces them. Omission retains the existing selection on a model change, `{}` explicitly selects provider defaults, and `null` explicitly returns to legacy thinking. The client lease and RemoteSession APIs retain these distinctions.
- Model-and-control replacement is one command, using AgentSession's shared validation and persistence. Rejected requests leave the previous model/settings intact. Native and legacy create options cannot both be selected.
- Typed selection errors become actionable `invalid_request` responses. Unexpected runtime/authentication/storage failures are not reclassified as safe user-input errors. A rejected legacy replacement does not erase native settings.
- Hosted helper creation forwards native options through the SDK. Incompatible newly created helper settings are rejected and the unexposed session is disposed. This does not add saved-agent package controls or prove the complete Builder lifecycle.
- Serve transcript projection retains requested/sent/reported execution settings and uses the shared usage projection for estimated, unknown, and reported pricing. No billed-cost ingestion or live verification is implied.
- Transport-independent tests exercise framed commands, attached observers, detach/reacquire, defaults/legacy transitions, mixed-input rejection, and client state after failure. The root TypeScript alias now resolves server testing types from workspace source instead of stale build output.

The complexity review kept option policy in the model/session layers; transport layers forward selections and translate typed errors. Native browser controls, workflow rendering, and desktop/mobile lifecycle checks remain open; saved-agent backend configuration is connected below.

## Saved-agent settings and execution (2026-08-31)

Problem: managed agent definitions and Builder's durable draft records retained only legacy thinking, so provider-native settings could disappear during save, candidate proof, promotion, or worker startup.

- Managed definitions and Builder configurations now retain exact native settings. An omitted field uses legacy thinking; `{}` selects provider defaults. Native settings require an explicit model and cannot be stored alongside legacy thinking. Invalid shape, unknown fields, and unsupported selections fail before replacing the saved definition or draft.
- The registry delegates capability checks to the existing shared model validator. Stored selections remain readable after a catalog change, but saving and starting native-controlled runs recheck current support. Run-specific model overrides must remain compatible; failed validation occurs before worker creation and credential resolution in the managed-run path.
- Chat's `configure_agent` tool preserves omitted settings, accepts explicit native replacements, and supports an explicit return to legacy mode. It retains settings through initial publishing, candidate proof, and promotion without changing the active revision before promotion. The tool description does not authorize automatic premium processing.
- Isolated workers pass saved controls into the SDK. Tests use the actual worker, SDK, and adapter against a loopback HTTP fixture; they verify effort/tier serialization, omitted provider defaults, and no request for an invalid selection. This is not paid-provider or successful model-output verification.
- Opening a saved agent as a browser helper inherits its controls. Explicit model/default/legacy overrides are honored, and incompatible helper creation is rejected without exposing a new session or changing the saved package.
- The complexity review chose shared validation callbacks plus existing registry/lifecycle persistence over a second saved-agent capability table. Draft parsing does not require a live account or treat catalog presence as proven access.

The next slice below connects browser fields and native settings preservation. Native controls in CLI and the newer harness format, complete pricing/freshness/access display, and exhaustive workflow validation remain open. Private user agents and the live Pi process were not touched.

## Native chat and Builder controls (2026-08-31)

Problem: a legacy-only form could erase saved native settings during an unrelated edit. Immediate per-field requests would also send incomplete coupled settings, such as manual thinking without its required budget.

- Chat and Agent Builder now share an Apply-based model settings dialog. It uses the protocol's capability projection, not a browser provider table. Mode, effort, budget, and processing tier remain separate; provider defaults stay unset, and premium processing is never injected automatically.
- The dialog retains unsupported saved values for correction and can replace the model and native settings together. A pure selection/marker module checks shape and projected values; the backend remains authoritative for provider interactions and final request limits. Returning to legacy mode is explicit. Legacy model-plus-thinking changes still use the existing sequential commands, not a new combined legacy command.
- The unused legacy Thinking selector is hidden in native mode. Chat controls are guarded against busy, inspector, artifact, external-agent, and saved-agent views. Chat prompts wait for pending model-setting updates. Builder runtime settings remain independent of its helper chat settings.
- Managed agent forms, draft signatures, autosave inputs, candidate saves, duplication inputs, full definition writes, and target-directory edits retain native settings. Missing catalog model references stay visible rather than turning into inheritance. Package summaries identify native control changes.
- Partial chat markers preserve settings; explicit `{}` selects provider defaults, `null` or a valid legacy thinking selection leaves native mode. Malformed/mixed/incompatible marker settings are rejected without partially changing model controls.
- Browser transcript disclosures distinguish requested, sent, and provider-reported fields. A missing report is not inferred from token counts. Mixed-cost sessions display a known subtotal plus an unknown remainder. Configured model counts no longer claim verified account access.
- Browser testing found and fixed CSS rules overriding hidden native/legacy controls. The dialog keeps Apply/Cancel visible with 44 px action targets and a separately scrollable settings area at the tested 390×844 mobile size.
- Browser testing also found that a rejected optional Builder service prevented a fulfilled candidate load from being applied. Independent settled results now restore staged model settings even when capabilities/routines are unavailable, while retaining an actionable service error.

The software-complexity review chose one shared editor with atomic Apply over immediate requests from separate control implementations. Pure projection checks are separate from DOM rendering so deterministic tests do not import browser globals into the Node configuration.

This is an implemented UI slice, not completion of the full goal. Remaining work includes every-provider/connection capability review, CLI/new harness support, access/freshness diagnostics, exact premium/billed pricing, full replacement/concurrency paths, comprehensive end-to-end workflow coverage, and cost-approved live checks. No personal agent or live Pi process was used for UI testing.

## Retained catalog refresh status (2026-08-31)

Problem: startup and credential synchronization discarded recoverable catalog warnings. The browser could list configured models but could not explain whether the most recent catalog pass reported a problem.

- The shared model runtime retains the last non-cancelled pass for each refreshable provider: cache-only/network-allowed scope, completion time, failure flag, and warning flag. This includes initial cache restoration and credential synchronization. Missing/static provider status remains unknown.
- Per-provider operation tokens prevent superseded passes from publishing status, including when the same provider object is recomposed. Cancellation preserves the previous completed result for an unchanged provider instance. Replacement invalidates the old instance's status, and targeted refreshes leave unrelated provider status alone.
- These fields describe an operation, not data freshness. A network-allowed pass may skip its network phase because auth is unconfigured or the provider's freshness policy skips a request. Completion does not establish a source review date, successful network request, model-level currentness, or account access. A source-mode compatibility refresh that returns no result cannot create a completed-status claim.
- The strict protocol projects only these safe fields. Error text, causes, endpoints, paths, headers, and credentials are not sent with catalog status. Detailed errors remain in the existing refresh result for host callers; this slice does not add a host diagnostics viewer.
- Settings shows a catalog-warning badge and recovery guidance. Chat and Builder's shared model settings dialog uses a compact expandable disclosure, available for both native and legacy controls. Mobile review found that showing the entire explanation initially displaced the controls; the compact disclosure keeps the warning visible without consuming that space.
- The software-complexity review chose runtime-owned status and a dependency-free presentation helper instead of separate browser refresh bookkeeping. Option validation and provider refresh policy remain in their existing owners.

This closes the retained-status/UI visibility gap only. Actual per-model source/age/freshness, structured problem-specific recovery, whole-file cache repair, continuous status updates, and diagnostics for providers with no visible models still require work. The original provider/connection, CLI/new harness, pricing, lifecycle, privacy, and cost-approved live-validation criteria remain in force.

## Per-model catalog source and age (2026-08-31)

Problem: a successful provider refresh cannot establish the origin or age of every model in a merged list. For example, a bundled model can remain beside a cached remote entry, and a private price/option override does not inherit verification from either source.

- Provider catalog owners now expose optional per-model lineage. Bundled baselines, remote overlays, provider-factory dynamic data, private replacement definitions, and extension replacements are distinct sources. Partial configuration/transport/OAuth-model overlays are listed in application order; topmost private model overrides remain last. Missing optional provenance stays unknown.
- Source state changes with the same guarded publication as its model data. The shared runtime produces a credential-blind, allowlisted snapshot with source, cache/refresh origin, generation/modification time, successful body-check time, source refresh interval, and partial overlays. Malformed/throwing optional metadata cannot disable a model or leak arbitrary provider fields.
- Source-window freshness is `unknown`, `within-refresh-window`, or `refresh-due`, calculated centrally when the model metadata snapshot is requested. Future source dates produce an explicit warning and unknown freshness. A generation date or recent cache-only pass does not become a capability review date or verified account access.
- Persistent catalogs distinguish `validatedAt`, the last successful body retrieval/revalidation, from `checkedAt`, the last completed endpoint check. Existing cache timestamps without successful-body evidence remain unknown rather than being retroactively called verified.
- Fixed 404/501 handling: preserve the last-good body's modification/successful-check times, discard only the unusable HTTP validator, retain retry suppression, and report a warning. Offline restart no longer discards an otherwise valid newer remote overlay. If the cache is corrupt but a valid in-memory body exists, an unavailable endpoint preserves that body and its original dates for the next restore.
- Extension-refresh model lists now pass shared structural validation before replacing their prior list or advancing their source timestamp. This does not establish whole-model provider support or complete validation of every later private/OAuth composition transformation.
- The browser protocol carries only the allowlisted snapshot. Settings reports mixed source counts instead of assigning the first model's source to its entire provider. The shared chat/Builder disclosure shows each selected model's age, refresh-due state, overrides, and the limits of those facts; changing the selection updates the disclosure.
- The software-complexity review chose source tracking at catalog merge/publication boundaries over reconstructing provenance in the browser or reading cache files again in the runtime. Provider policy remains source-owned, and freshness calculation remains shared.

Still required: complete capability-level evidence and confidence for every provider/connection, verified access semantics, continuous age/status delivery to long-lived browser snapshots, complete composition/failure recovery, CLI/new harness support, exact premium/billed pricing, and full lifecycle/live checks under the original goal. These changes track catalog lineage; they do not certify every model or account.

## CLI native controls and startup (2026-08-31)

Problem: browser/saved-agent native settings were preserved in session state, but CLI startup exposed only legacy thinking. A resumed Fast selection must not be silently merged into an explicit new effort-only selection.

- Added independent `--reasoning-mode`, `--reasoning-effort`, `--reasoning-budget`, and `--processing-tier` flags, plus `--model-defaults`. Value flags accept separate or equals syntax. Budget parsing rejects fractional, unsafe, and malformed numbers; the shared model validator determines whether an integer or sentinel is actually supported.
- Explicit native flags replace the entire saved native selection. Omitted native fields use provider defaults; they do not inherit saved Fast or legacy thinking budgets. With no control flags, resume retains the saved selection, including an intentionally saved processing tier. `--model-defaults` alone selects an empty native object; combined with native value flags, those explicit values still apply.
- Native controls cannot be combined with `--thinking` or a parsed `--model ...:thinking` shorthand. Actual model IDs containing `:high` remain distinguishable from shorthand. Explicit legacy input passes `null` before SDK construction, so saved native settings are cleared deliberately rather than after startup.
- CLI selection uses shared capability validation. SDK-selected default models also validate explicit native options before appending preference entries. Restored values remain available for correction and are still revalidated before requests. This does not repair structurally malformed active session entries.
- Custom model IDs retain their existing transport fallback without inheriting the baseline model's native capability claims. Users can define reviewed native capabilities for such models in their private catalog. Legacy fallback metadata remains a separate review item.
- Earlier SDK validation exposed a helper-session error-mapping gap. The browser service now catches typed selection errors during factory construction as well as after it, reports `invalid_request`, and does not publish a failed helper. Unexpected storage/auth/runtime errors retain their original classification.
- The software-complexity review chose thin CLI translation into the existing model-control contract over a second CLI capability table. Main remains responsible for CLI precedence; SDK/model validation and transport error translation stay in their existing owners.

Still required: native support in the newer agent harness/session format and experimental CLI; CLI/TUI effective-setting and price disclosure; malformed-session recovery; full provider/connection, access, pricing, freshness-delivery, and lifecycle acceptance criteria. No live Pi restart or paid provider validation was performed.

## Durable harness settings and experimental CLI (2026-08-31)

Problem: the newer v4 session format and SQLite decoder did not recognize native selections. Settings in memory alone would be lost on recovery, while treating an explicit legacy reset as a missing value could reactivate default Fast processing.

- Added a distinct `model_controls_change` entry to the newer session contract. Selected values, `{}` (provider defaults), and `null` (explicit legacy mode) remain distinct. These entries never become LLM messages. Native selections replace the complete previous selection rather than merging an old processing tier into new effort-only settings.
- The shared session boundary and implemented memory, JSONL, and SQLite backends validate native shapes before changing entries, records, sequence numbers, or lane state. Run intents, queued entries, and deferred writes retain and validate their provisioned selections. Catalog-specific option validation still belongs at execution; storage does not claim current support or account access.
- JSONL recognizes the new entry and treats malformed complete settings as schema corruption, not a torn append. It leaves the original file untouched. SQLite decodes native entries, validates nested recovery records, and rejects corrupt settings before copying raw payloads into a fork.
- Context reconstruction reads configuration before compaction/message transforms. The pure lane reducer carries native defaults and committed selections without silently clearing them on model/thinking entries. Pending selections remain pending until their entry is committed. Explicit null removes native defaults rather than reviving them.
- Added backend conformance cases shared by memory, JSONL, and SQLite, plus corruption, compaction, branch/lane, pending-write, and separate SQLite close/reopen coverage. Experimental CLI tests verify that its existing Pi command forwards native options through the shared parser and refuses invalid input before dispatch; unsupported experimental server/client options remain rejected.
- The software-complexity review kept one validation/reconstruction contract and reused the existing durable entry and conformance infrastructure. A transient stream-option-only design would not preserve settings or make explicit resets reconstructable.

Upstream dependency: `AgentHarness.create` rejects persisted recovery records with `HarnessNotImplemented("create.restore")`; prompt, resume, navigation, compaction, and execution are also scaffold operations. Its existing scaffold tests confirm this. This slice validates implemented storage and pure recovery contracts, not a functioning newer harness lifecycle. Building that entire upstream engine is not included as an incidental fix. The working coding-agent chat/Builder/CLI path is separate. Full new-harness execution validation requires that upstream implementation first.

Still required under the original goal: remaining provider/connection and capability evidence, access semantics, full composition/cache recovery, long-lived browser freshness updates, terminal disclosure, exact premium/billed pricing, malformed legacy-session recovery, asynchronous editing and complete desktop/mobile lifecycle validation. Paid provider checks still require a user-approved cost cap. No live instance was restarted or personal agent modified.

## Complete catalog composition and private configuration recovery (2026-08-31)

Problem: validating an extension's fetched list before OAuth transformations and final private overrides allowed a later layer to invalidate the published catalog. Recomposition could also discard a usable dynamic snapshot when the next fetch failed.

- One composition function applies the existing layer order, validates the complete result, and publishes detached models and provenance together. OAuth callbacks receive copied models and credentials. Model reads return copies of the accepted snapshot instead of rerunning callbacks.
- Failed final transformations retain the previous composed models and source dates. A separately owned base catalog may accept its own valid update without forcing an invalid higher-layer result into the composed view. Superseded publications do not replace accepted state.
- Runtime recomposition retains accepted dynamic inputs for the same base/extension binding. Valid private overrides can apply to those inputs even if the next fetch fails; changed connections do not inherit their dynamic state merely because they reuse a provider ID.
- Invalid registration or private configuration changes preserve the accepted provider binding, including API-key source and request headers. Other valid providers can still update. Registration inputs and configuration getters are defensively copied.
- A malformed whole `models.json` file retains the last successfully loaded private definitions in memory and reports a warning. A valid repair applies normally; an explicitly valid empty file removes private definitions. This is not a persisted secret-bearing backup or whole-file catalog-cache quarantine/repair.
- The software-complexity review kept composition order and final validation together, using the existing provider snapshot/publication contract. It did not add a second browser catalog or duplicate layer ordering in a validator.

Still required: remaining provider/connection evidence, access and cost semantics, whole-file cache recovery, continuous browser freshness delivery, terminal disclosure, malformed legacy-session recovery, and full desktop/mobile lifecycle validation. These tests establish structural integrity and recovery, not provider support or account access.

## Anthropic Fast processing and estimates (2026-08-31)

Problem: mapping OpenAI's Fast wire field onto Anthropic would select a different concept. Anthropic's reviewed Fast models are Opus 5 and Opus 4.8; access remains a restricted research preview. Opus 4.7 rejects Fast, while legacy Opus 4.6 requests can report standard speed. [Fast reference](https://platform.claude.com/docs/en/build-with-claude/fast-mode).

- Pi's existing processing selector now offers `standard`/`fast` for those two reviewed public-API models. The adapter maps these values only to `speed`, retaining independent thinking mode/effort. Omission stays unset. Priority-capacity selection/reporting is not implemented by this selector and is never substituted for speed.
- Required beta headers survive caller headers. Native payload-hook changes to speed, including clearing it, fail before dispatch. OAuth and alternate endpoints do not inherit public API evidence; explicit private capability declarations remain separately supported. No new client-side standard-speed fallback was added.
- Requested and serialized speed remain separate from `usage.speed`. The last non-null speed report controls the estimate; missing reports are not fabricated. Existing legacy-hook requests can disclose an Opus 4.6 standard-speed result without advertising native Fast support for that model.
- Reviewed public estimates use the Fast multiplier and cache rates, including updated one-hour cache-write breakdowns. US inference applies its additional multiplier. Unknown geography, unsupported actual fallback models, custom prices, or unreviewed connections produce unknown premium costs instead of silently using ordinary rates or replacing private prices. These are estimates, not billed-cost data. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), [data residency](https://platform.claude.com/docs/en/manage-claude/data-residency).
- The software-design review retained the existing processing-choice contract rather than adding a second UI-only speed setting. Exact Fast model scope and premium-price policy share a small SDK-independent module; the adapter owns wire fields, required headers, and response processing.

The installed SDK already types the beta speed fields; no dependency update was needed. Tests cover synthetic HTTP/SSE and shared chat/Builder/session selection paths. This does not establish preview entitlement, paid API behavior, rendered desktop/mobile Fast workflows, comprehensive priority-capacity controls, or complete provider coverage. Feature-specific preview/access disclosure and premium price presentation before Apply remain part of the wider UI/access work.

## Pre-selection processing guidance (2026-08-31)

Problem: a valid processing choice still needs an explanation before Apply. OpenAI's unset tier can inherit project-level Fast; Anthropic's Fast requires preview approval. Neither a configured credential nor a published rate establishes account eligibility or the user's actual bill.

- Choice capabilities now carry optional, bounded text guidance through the shared protocol. The reviewed OpenAI/Anthropic processing entries explain access limits, premiums, and explicit Standard versus unset defaults. Existing dated provider evidence applies to the guidance; private declarations preserve their own text without inheriting first-party claims.
- Chat and Builder render that text directly below the choice, with an accessible description link. No provider-name or pricing rules were added to the browser. Selections remain unchanged until Apply; the new text does not insert a processing default.
- The connection gap found during this slice was that `CurrentSessionService.listModels` projected catalog capabilities without the runtime's authentication binding. The next slice closes that selection/request mismatch; guidance alone did not fix it.

## Connection-aware selection and request validation (2026-08-31)

Problem: a catalog's public API-key options were advertised to a stored OAuth connection that the adapter would reject. A provider being configured is not proof of its actual transport, model access, or premium entitlement.

- Auth checks and resolved requests now carry internal transport facts separately from credential-storage type. Anthropic OAuth-like tokens in API-key fields, explicit authorization headers, ordinary API keys, and unknown command-backed keys remain distinguishable. Internal endpoint facts are not a safe public payload and are not added to browser metadata.
- ModelRuntime owns the checked connection view used by serve model lists and selection validation. Provider replacement invalidates prior checked support. A custom availability check without transport facts stays unknown rather than inheriting API-key evidence. Listing choices does not execute configured key/header commands or refresh stored OAuth tokens.
- The shared capability resolver restricts implicit first-party overlays to reviewed API-key connections and endpoints. Explicit private capability declarations remain authoritative within adapter-supported syntax; they do not inherit public review evidence. Empty native defaults remain valid when explicit options are unverified.
- Session selection, SDK construction, and the serve registry use the runtime validator. Final request preparation revalidates actual resolved auth, endpoint, and transformed headers before dispatch. An explicit request API key is evaluated as that request's connection, not as the stored OAuth credential it overrides.
- The design review retained two useful stages in the existing runtime: side-effect-free checked capabilities for selection, and authoritative final request validation. It did not add a browser-specific provider policy or resolve secrets merely to populate a dropdown.
- This does not complete every provider's capability/access audit, continuous updates to an already-open browser catalog, all stale-editor races, or account/paid-provider verification. Unsupported saved values remain available for explicit correction rather than being silently erased.

## Official sources to verify against

Reviewed guidance informs the implementation, but does not certify every listed model:

- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode): renamed July 30, 2026; accepts `fast` and `priority`; GPT-5.6 and earlier report `priority`, and downgraded requests report `default`.
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning): effort and mode vary by model.
- [Codex app-server model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist): discovery can supply supported/default efforts. Pi's direct ChatGPT backend connection is not this app-server interface.
- [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort): model-specific effort and thinking modes.
- [Gemini generateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking): distinguish level, token budget, and thought visibility; do not mix APIs.
- [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning): model-specific effort semantics.
- [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/): enabled/disabled thinking and effort are separate.
- [OpenRouter model discovery](https://openrouter.ai/api/v1/models): provider-specific capability and pricing metadata; router pricing needs special interpretation.

## Validation record

Initial foundation validated on 2026-08-31:

- `npm run check`: passed, including browser type/bundle checks, dependency pins, import policy, shrinkwrap/install-lock checks, TypeScript, and browser smoke checks.
- AI targeted tests: 79 passed across model validation, generated-data validation, thinking levels, strict generation, and model runtime.
- Coding-agent targeted tests: 19 passed across current-session model metadata and remote catalogs.
- Credential-free inventory script tests: 5 passed.
- `git diff --check`: passed.

These checks validate the initial metadata/refresh fixes, not the complete goal. Provider-specific capability verification, richer controls, pricing semantics, cached-input handling, private/dynamic inventory, and desktop/mobile lifecycle tests remain outstanding. No paid requests, live-server restart, personal-agent changes, commits, merge, or deployment performed for this goal.

Native-control foundation validated on 2026-08-31:

- `npm run check`: passed with no remaining diagnostics, including the regenerated browser bundle and both dependency artifact checks.
- AI targeted tests: 253 passed in 17 files. Includes 36 independent mode/effort/tier combinations through the real SDK with an injected offline fetch, pre-auth checks, endpoint changes, provider-reported tiers, compatibility paths, strict generation, and existing model runtime tests.
- Coding-agent targeted tests: 47 passed in six files, including private controls, override precedence, runtime preflight, remote catalogs, current-session metadata, and auth/extension compatibility.
- Server protocol tests: 12 passed, including independent requested/sent/reported settings and credential-blind capability transport. Server tests now use workspace source aliases rather than stale built dependencies.
- Inventory script tests: 5 passed. `git diff --check`: passed.
- The isolated strict-generation fixture now includes its pinned schema runtime; it still verifies failure before any generated catalog mutation.

These are deterministic offline checks, not live provider or account-access verification. The formal goal remains active.

Cache/pricing foundations and Google controls validated on 2026-08-31:

- Full `npm run check`: passed with no remaining diagnostics. Browser bundle regenerated after protocol changes.
- AI targeted tests: 358 passed across 23 files, including cache corruption/publication recovery, cost status/tiers, native controls, real-SDK offline serialization, and existing adapter/runtime regressions. No conditional provider E2E files were run.
- Coding-agent targeted tests: 80 passed across nine files; one existing POSIX file-mode check skipped on Windows.
- Server protocol: 17 passed, including automatic/disabled budget metadata and negative-sentinel transport validation.
- Credential-free audit script: seven passed. Audit reports zero structurally invalid bundled entries, 14 native-control entries, and 112 unknown-price entries. These counts are not account-access or whole-model verification claims.
- `git diff --check`: passed. No live provider calls, paid tokens, personal-agent modifications, restart, commit, merge, or deployment.

Next: expand provider/connection evidence and adapter coverage; retain and expose cache/access diagnostics; wire native selections and cost status through chat, Builder, saved agents, and CLI; validate desktop/mobile workflows. The acceptance criteria above remain unchanged.

Anthropic controls and agent/session persistence validated on 2026-08-31:

- Full `npm run check`: passed without remaining diagnostics; browser bundle regenerated for the optional request-bound budget ceiling.
- AI: 553 passed across 29 targeted files, including native Anthropic SDK serialization and existing authentication, temperature, adaptive-thinking, SSE, pricing, and catalog regressions.
- Agent core: 62 passed across four files, including malformed state, repeated/tool turns, explicit native/legacy transitions, model-switch preflight, and proxy metadata.
- Coding-agent: 123 passed across thirteen files, plus 55 passed across three faux-provider session/runtime/compaction files. One existing POSIX permissions check skipped on Windows.
- Server protocol: 17 passed. Credential-free inventory: seven passed; 27 native-control entries and zero structurally invalid bundled entries.
- Total: 817 targeted checks passed, one platform skip. These are offline checks; no conditional provider E2E files were run.
- No paid provider calls, live restart, personal-agent changes, commit, merge, push, or deployment. The formal goal remains active.

Browser session settings transport validated on 2026-08-31:

- Full `npm run check`: passed, including regenerated browser protocol/client code and workspace source type checks.
- Protocol: 65 passed in two files. Client: 12 passed in three files. Server: 20 passed in three transport-independent/projection files.
- AI: 300 passed in five native-control/preflight adapter files. Coding-agent: 43 passed in six session, serve, helper-host, and remote-client files. Total for this slice: 440 targeted tests passed.
- The existing Unix-socket session suite was attempted on Windows: all fourteen tests failed before exercising session behavior with listener `EACCES` errors. The two newly added tests were moved to a framed, transport-independent fixture and pass; the pre-existing Unix test file is unchanged. Unix listener behavior is not claimed validated on this host.
- `git diff --check`: passed. No provider requests, paid tokens, private-agent changes, live restart, commit, merge, push, or deployment. The formal goal remains active.

Saved-agent settings validated on 2026-08-31:

- Full `npm run check`: passed after the final code change, including source types and browser/dependency artifact checks. `git diff --check`: passed.
- Eleven affected coding-agent files passed sequentially: 81 tests. After adding the proof-retry evidence-preservation guard, all 26 tests in the three affected lifecycle/tool files passed again, including the additional regression (82 distinct tests covered in this slice).
- Four tests use the actual isolated worker and SDK against a loopback HTTP fixture. Two use the real serve host, HTTP registry endpoint, browser WebSocket transport, and client without prompting a provider. Other new tests use synthetic execution results for draft/proof/promotion behavior.
- The initial parallel run passed 80 tests and timed out in the existing child-crash test. That test passed alone, and its entire suite passed in the sequential run. Inspection found a 10 ms fixture exit delay after IPC delivery, which can precede asynchronous host-action startup under load; this is a timing-sensitivity finding, not a demonstrated native-settings regression. The existing fixture/test were not changed.
- No paid provider calls, personal-agent changes, live restart, commit, merge, push, or deployment. Native browser forms and desktop/mobile workflow validation remain required before this slice is ready to deploy. The formal goal remains active.

Native browser controls validated on 2026-08-31:

- Full `npm run check`: passed after the final implementation change, including regenerated browser bundle, TypeScript, dependency pins, lock artifacts, and browser smoke checks.
- Five targeted files: 59 tests passed (browser selection/partial-marker checks, cost presentation, native session transport, saved-agent helpers, and saved-agent lifecycle). These are deterministic, credential-free tests.
- An isolated browser fixture exercised chat native effort/tier changes, numeric budget rejection/correction, automatic budget selection on mobile, incompatible-model value retention, and separation of requested Fast from a provider-reported default. The mixed usage fixture displayed `$0.300+` as a known subtotal.
- Desktop Builder editing saved low effort/default processing as candidate revision 2 while the active agent remained revision 1/high effort. The Builder chat stayed unchanged. HTTP inspection verified the stored values. The reload test exposed the optional-service restoration bug; after its fix, a seeded durable candidate restored low effort despite the fixture's deliberate capabilities-service 503.
- Final mobile inspection at 390×844 verified the saved native selection, independently scrollable settings, and visible 44 px Apply/Cancel actions. The browser tab was closed, viewport reset, and final test server stopped through its fixture-only shutdown endpoint. Cleanup of the first interrupted disposable fixture directory and ignored test bundle was denied by execution policy; those local test artifacts may remain and contain only synthetic data.
- Fixture services deliberately omit unrelated integrations and disable execution. This does not verify paid provider behavior, real account access, all optional services, all asynchronous editing races, or the complete agent proof/promotion lifecycle through the browser. Earlier backend lifecycle tests remain separate evidence.
- No personal-agent changes, live Pi restart, paid requests, commit, merge, push, or deployment. The formal goal remains active with its original acceptance criteria.

Retained catalog status validated on 2026-08-31:

- Full `npm run check`: passed after the implementation changes, including source types, regenerated browser bundle, pinned dependencies, lock artifacts, and browser smoke checks. `git diff --check`: passed.
- Coding-agent: 97 tests passed across nine targeted files, with one existing POSIX permissions test skipped on Windows. Coverage includes initial corrupt-cache warnings, repair, detached/redacted snapshots, unconfigured network skips, static/unknown providers, cancellation/late warnings, overlapping refreshes, provider replacement/removal, credential synchronization, protocol projection, and native UI settings regressions.
- Protocol: 65 tests passed in two files. Server: 19 tests passed in two transport-independent/projection files. Total: 181 passed, one platform skip; no paid or conditional provider E2E tests.
- The synthetic UI fixture displayed the warning in desktop Settings and at 390×844. The final mobile dialog kept the warning summary and Apply/Cancel visible, showed mode/effort/tier controls in its scrollable area, and expanded to show scope, time, recovery guidance, and explicit freshness/access limitations.
- The test tab was closed, viewport reset, and both test-server runs stopped using the fixture-only endpoint with normal disposable-directory cleanup. The previously denied cleanup of the earlier synthetic fixture and ignored bundle was not bypassed.
- This is not a live catalog-freshness, account-access, or full Builder proof/promotion verification. No personal agents, live Pi instance, paid provider calls, commits, merges, pushes, or deployments were used. The formal goal remains active.

Per-model source/age validated on 2026-08-31:

- Full `npm run check`: passed after the final code change, including browser bundle/source checks, dependency pins, lock artifacts, TypeScript, and browser smoke checks. One transient Windows file-open error during browser generation cleared on a normal retry; no permission workaround or file deletion was used.
- AI: 109 tests passed in five targeted files. Coding-agent: 121 passed in eleven files, with one existing POSIX permissions check skipped on Windows. Protocol: 65 passed in two files. Server: 19 passed in two files. Total: 314 passed, one platform skip.
- Coverage includes timestamp validation and future-date disclosure, source-window boundaries, credential-blind allowlisting, unchanged bundled baselines, dynamic overlay publication/restore, invalid extension refresh rejection, source-layer precedence, cache 404/501 retention across restart, legacy cache dates, 304 body revalidation, superseded-refresh provenance, and current-session protocol projection.
- The isolated browser fixture showed mixed bundled/remote source counts on desktop. Chat selection switched from stale cached remote data with a private override to a bundled model with unknown freshness; incompatible legacy thinking remained visible and Apply stayed disabled. Builder showed the same stale-source/override facts while retaining its high-effort/default-processing settings.
- Final 390×844 inspection verified independently scrollable details and visible Apply/Cancel controls in Builder. Inspection did not apply model edits or start a proof. The tab was closed, viewport reset, and fixture server stopped through its dedicated endpoint with normal temporary-directory cleanup. Existing previously denied cleanup was not bypassed.
- No real provider requests, paid tokens, personal-agent changes, live Pi restart, commit, merge, push, or deployment. The full formal goal remains active.

CLI native controls validated on 2026-08-31:

- Full `npm run check`: passed after the final code change, including TypeScript, browser checks, pinned dependencies, and lock artifacts. `git diff --check`: passed.
- Final targeted run: 251 tests passed across twelve coding-agent files. Coverage includes native CLI parsing and precedence, custom-ID capability isolation, explicit defaults/legacy transitions, SDK-service restore and request forwarding, existing model resolution, saved-agent lifecycle, real isolated workers against loopback HTTP, and browser-helper error translation.
- Three subprocess cases launch the source CLI through the repository's TypeScript loader with a minimal credential-free environment: help advertises native controls, mixed native/legacy settings fail, and malformed numeric budgets fail. No provider prompt is sent by those startup checks. Worker serialization tests use only synthetic loopback requests.
- An expanded diagnostic run also exposed three failures in unchanged tests: two SDK session-path assertions assume slash formatting that differs on Windows; the raw-Node session-ID subprocess loads stale compiled workspace packages and fails on the missing `ModelControlCapabilitiesSchema` export. Captured stderr confirmed the latter before CLI startup. These are recorded, not counted as passing. No build, test weakening, upstream-facing edits, or live restart was used to hide them; the source-loader subprocess tests pass.
- The earlier-validation change initially caused a browser-helper regression (`internal_error` instead of `invalid_request`). The service boundary was corrected and the final complete targeted run above passes, including two new factory-error classification tests.
- Disposable test directories were cleaned by their fixtures. A separate synthetic import diagnostic directory was retained at this checkpoint; it contained only the diagnostic script, with no credentials or agents.
- No personal-agent changes, paid provider requests, live Pi restart, commit, merge, push, or deployment. The newer harness/experimental CLI, terminal disclosure, comprehensive provider/access/pricing/freshness, and full lifecycle criteria remain open; the formal goal is active.

Durable harness settings validated on 2026-08-31:

- Full `npm run check`: passed after the final code changes, including TypeScript, browser/dependency artifacts, and browser smoke checks. `git diff --check`: passed.
- Agent: 286 tests passed in eight targeted session/context/reducer/scaffold files. SQLite: 71 passed in six targeted conformance/repository/query/corruption files. Coding-agent: 92 passed in three native and experimental CLI files. Total: 449 passed; no conditional provider E2E suite or paid API was run.
- New coverage distinguishes empty provider defaults, explicit null, numeric sentinel budgets, and selected values across reopen and forks; rejects malformed native entries and pending records before mutation; verifies no silent JSONL truncation; and tests a separately opened SQLite database rather than relying only on an existing repository object.
- SQLite emitted Node's existing experimental-feature warning. It is not a test or repository-check failure, and the backend remains experimental. The newer harness scaffold test remains unchanged and passing; no complete harness execution is claimed.
- No personal-agent changes, paid provider requests, live Pi restart, commit, merge, push, or deployment. The original acceptance criteria remain active.

Complete catalog composition validated on 2026-08-31:

- Full `npm run check`: passed after the final implementation changes. `git diff --check`: passed.
- Final coding-agent regression run: 108 passed across ten files, with one existing POSIX permissions test skipped on Windows. Coverage includes complete composition, OAuth mutation/failure isolation, private configuration repair, dynamic snapshot retention, provenance, refresh status, credential synchronization, auth compatibility, remote catalogs, and model storage.
- An additional filtered registry run passed nine registration/override/removal tests; 74 tests were excluded by its name filter, not validated or counted as platform skips. The full registry file was not run because an existing stream comparison could dispatch through ambient provider credentials.
- The new composition suite has 18 cases. Its superseded-publication case uses a declined publication callback; an actual overlapping composed-refresh test remains useful additional coverage. Existing runtime status-overlap tests passed, but are not substitutes for that model-publication scenario.
- No personal-agent changes, paid provider requests, live Pi restart, commit, merge, push, or deployment. The formal goal remains active.

Anthropic Fast validated on 2026-08-31:

- Full `npm run check`: passed after final code/test changes. `git diff --check`: passed.
- AI: 291 tests passed in nine Anthropic/control files, plus 145 in five other adapter, preflight, pricing, and structural-validation files. Coding-agent: 110 passed in six browser-selection, session, private-config, CLI, saved-agent, and price files. Credential-free inventory: seven tests passed. Total: 553 passing targeted tests.
- Real-SDK tests inject synthetic fetch responses. They exercise all reviewed mode/effort combinations with both speeds, beta merging, reported-speed changes, missing reports, cache/residency costs, actual fallback model pricing, unsupported selections/connections, payload mutations, and HTTP 429/529 with no automatic standard-speed fallback.
- An initial regression run exposed omitted final-event usage and a weak SDK-type mismatch in the new cost callback. The callback now accepts omitted usage, preserving the existing SSE contract; the unchanged SSE regression passes. The final full check has no remaining diagnostics.
- The inventory still contains 1,291 entries, 27 models with some reviewed native controls, and zero structurally invalid entries. Processing-choice coverage rises to three entries (one OpenAI and two Anthropic); this is not whole-model or account-access verification.
- No personal-agent changes, paid requests, live Pi restart, commit, merge, push, or deployment. The original goal remains active.

Pre-selection processing guidance validated on 2026-08-31:

- Full `npm run check`: passed, including regenerated browser bundle. `git diff --check`: passed.
- AI: 369 tests passed in four native-control/adapter files. Protocol: 17 passed. Coding-agent: 47 passed in browser projection, private configuration, and serve selection files. Total: 433 targeted tests passed. New cases cover guidance shape/length, private text preservation, projection, and no default injection.
- An isolated 1280×720 browser fixture verified readable guidance adjacent to processing choices in chat and Builder, accessible description linkage, independent effort, retained saved choices, and visible 44 px Apply/Cancel actions. Chat's draft Fast selection was cancelled; no candidate settings were saved and no proof ran. Mobile rendering of the new guidance has not yet been retested.
- The test tab was closed and fixture-only server stopped successfully. Its newly created synthetic temporary directory was removed by normal fixture cleanup; no previously denied cleanup was retried.
- No paid requests, personal-agent edits, live Pi restart, commit, merge, push, or deployment. Connection-aware filtering, wider provider coverage, and the remaining original acceptance criteria are still open.

Connection filtering and desktop/mobile settings validated on 2026-08-31:

- Full `npm run check`: passed after the final code changes, including TypeScript, browser artifact/smoke checks, pinned dependencies, and lock artifacts. `git diff --check`: passed.
- Final targeted runs: AI 428 tests in seven files; coding-agent 161 in eleven files; protocol 17 in one file. Total: 606 passing tests, with no conditional provider E2E suite. Earlier partial runs are not added to this total.
- New cases cover API-key/OAuth/header classification, credential changes, provider replacement, custom checks without transport evidence, command-free inspection, expired OAuth without refresh, private overrides, explicit request keys, final transformed headers, browser/backend agreement, and rejected selection without session-log mutation. An existing exact auth-result assertion was updated to include the new connection metadata.
- At 1280×720 and 390×844, the isolated browser fixture exercised independent effort and processing choices, adjacent accessible guidance, Apply/reopen persistence, and correction of retained unsupported values. Mobile guidance wraps without horizontal overflow; both 44 px actions remain visible while fields scroll.
- Mobile chat switched to a synthetic unverified connection only after explicitly clearing incompatible effort/tier values. Builder retained unsupported values and disabled Apply; Cancel preserved its original candidate settings.
- Builder saved candidate revision 2 with low effort/Fast on mobile and restored those values after page reload. Disk inspection confirmed the active agent remained revision 1 with high effort/default processing. Chat stayed on its independently selected unverified model with unset defaults. No proof or promotion was run.
- New UX finding at this checkpoint: after reopening that saved candidate, Builder reported “Unsaved changes” despite restoring the saved values and without new edits. The subsequent saved-candidate validation below fixes this. The fixture's optional capabilities service deliberately returns 503, so that failure path is part of the reproduction.
- The test tab was closed, viewport restored, and fixture server stopped through its own shutdown endpoint. Its new disposable directory was removed normally; previously denied cleanup was not retried. No personal agent, live Pi process, paid provider, commit, merge, push, or deployment was used.
- The bounded connection/settings checkpoint is validated, not the complete formal goal. Wider provider evidence, pricing/access details, continuous freshness, remaining recovery/race behavior, and full lifecycle/live checks remain open.

Saved-candidate dirty state validated on 2026-08-31:

- Root cause: opening Builder captured the active agent as the clean baseline before asynchronously restoring a saved candidate. Restoration now updates that baseline for linked candidates. The existing form comparison stays authoritative; the active-versus-candidate package comparison and unpublished draft Publish behavior are unchanged.
- Full `npm run check` and `git diff --check`: passed. Four affected coding-agent files passed all 60 tests: browser model settings, saved-agent settings, serve lifecycle model controls, and serve page. No new unit test was added; the specific regression was exercised through the existing deterministic synthetic browser fixture.
- At 1280×720, changed high/default to low/Fast and saved candidate revision 2. Reloading and reopening kept both Save buttons disabled and displayed “No changes to apply.” A new effort edit enabled Save; reverting it disabled Save again.
- At 390×844, applying unchanged settings remained clean. Changed processing back to default and saved again (build revision 3, candidate revision 2). Reloaded without resizing and used the mobile Sessions and Workflow drawers to reopen Builder: low/default restored, both Save buttons stayed disabled, and no unsaved warning appeared.
- Disk inspection confirmed the active agent remained revision 1/high/default, with no proof history. Optional capabilities remained deliberately unavailable, so successful restoration does not depend on that service. No provider call, personal-agent edit, live restart, commit, merge, push, or deployment was performed. Wider provider and full lifecycle acceptance remain open.
- Cleanup finding at this checkpoint: the test tab closed and viewport reset, but the fixture-only shutdown endpoint stalled with an established HTTP connection after its listener closed. A later listener fix added explicit active-connection draining and a regression test; the final lifecycle fixture exited normally and removed its disposable directory.
