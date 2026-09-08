# Team operating setup

## Goal

Give a local team a purpose, usable tools, reusable working methods, explicit memory policy and evidence-based completion. Configuration stays in its existing chat and settings. A supervisor should persist requested changes and delegate useful work without requiring users to edit agent files.

## Design

Extend the existing team definition and revisioned chat updates instead of introducing a separate operating-plan store. The existing member notes carry role methods and success criteria; Pi's resource loader owns skill discovery. Confined workers can list and read discovered, model-invocable skill entry points through `read_agent_skill`, without arbitrary host file access. Skill references and executable scripts still require their corresponding tool grants.

The supervisor can save `memoryStrategy` and a `memoryPolicy` containing what to retain and the lifetime of observations. Strategy changes and policy changes participate in the same persistence, receipt, revision check and undo as standing instructions. Temporary user directions remain in the current request unless a persistent change was requested.

Memory projection retains decisions until correction or reset. Observations require a source URL and receive host timestamps; the default observation lifetime is 24 hours. A newer entry replaces the same key even after expiry, so an obsolete value never returns. Only completed runs contribute memory. Private entries are delivered only to their author; the user can inspect them. Historical conversation is still accessible as history and is not current evidence. Classification of a fact as a decision or observation depends on model behavior and role instructions; timestamps cannot prove source accuracy.

Before dispatch, tool configuration is revalidated. An unavailable assigned tool pauses the request with setup guidance. Unavailable tools on an idle member do not prevent healthy members from working. This checks configured availability; external services can still fail when invoked. Skill loading never expands tool permissions.

The environment catalog is available through `read_team_context` with `section: tools` and an optional search query. Normal turns include current grants, not the entire catalog of unrelated integrations. Historical context remains separately paginated. This preserves connection discovery while reducing repeated inference context.

Members awaiting a proposed tool are deferred until approval. A supervisor may explicitly declare `updateTeam.independentAgentIds` for useful work that does not need the new grant. Tests verify both deferred dependent work and preserved independent preparation. Observation schema validation happens inside the submission tool, allowing correction before the worker finishes rather than rejecting an otherwise completed handoff afterward.

Supervisor submission also requires a concrete `reassignmentReason` before requesting another contribution from an already completed member. A revision or a new prerequisite remains possible; an unqualified repeat is rejected while the worker can still correct its action. The quality of the stated reason and source interpretation remain model judgments, not semantic guarantees.

Presentation checks the current user goal against root-level HTML report filenames with at least three words. A unique plain-word match directly selects that report even if the model supplies an older file; history does not participate in that match. This covers descriptive names such as `flight-team-status.html`, not arbitrary semantic aliases or nested-file discovery. The browser test intentionally supplies an older file and verifies that the requested report renders.

## Validation

Targeted tests cover policy update and undo through supervisor turns, restart persistence, correction and expiry without stale resurrection, failed-run exclusion, private memory isolation, confined file work, tool revocation and resumption, discovered-skill reading, and rejection of arbitrary skill paths or disabled skills. Live validation uses the existing Flight Finder team; its personal configuration and artifacts stay in ignored local storage.

This remains a bounded local runtime with configured inference providers, context and cost limits. It does not provide unlimited context, autonomous credential setup, guaranteed website availability or universal task accuracy.
