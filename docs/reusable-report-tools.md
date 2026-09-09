# Reusable report tools

The supervisor can assign **Create reusable report tools** to a designer, wait for its registered template, and assign that saved tool to a reporting member. The reporting member invokes the tool with new data; the host renders and saves the HTML. The designer's sample output is not the reporter's execution proof.

## Contract

- `report_tools` lists templates and registers immutable versions. Registration runs at least two distinct sample inputs and checks the supplied output assertions.
- Templates declare scalar fields and arrays of scalar records. Required but unavailable values use `null`, rendered as `Unavailable`.
- `{{field}}` inserts escaped text. `{{#each options}}...{{/each}}` renders a declared record array. Nested loops, raw HTML interpolation and executable scripts are unsupported.
- `{{freshness observedAt}}` uses host time and the registered observation lifetime. Invalid, missing/null and future timestamps are unverified. An old timestamp is stale. A recent timestamp does not prove source accuracy.
- A saved tool ID, such as `saved_report_trip_report_v1`, is independently assignable in team configuration or chat. The reporting member also needs workspace write access. Registration grants neither execution nor sending.
- Each invocation saves a unique HTML artifact under `reports/<tool>/` in the caller's workspace, returning its path and SHA-256. It does not require shell access or model-generated HTML on each run.
- Existing presentation and Gmail draft tools consume the returned path. Draft authorization comes from the current host-owned user request. It does not authorize sending or inherit unrelated historical requests.

## Handoffs

The supervisor requests the builder first and waits for the saved tool ID and validation result. It then assigns that tool to the reporter and requests the report. Multiple simultaneous assignments require an explicit declaration that their inputs and outputs are independent.

The supervisor's completion plan names every required member, including later consumers of a new tool. The host retains these requirements through tool approval and rejects completion before each named member contributes. This checks participation, not artifact correctness; tool results and rendered output still provide that evidence.

For report-tool creation or updates followed by reuse, `plan.toolHandoffs` names a builder and consumer. The worker attaches registration/render receipts from successful tool results; the model cannot submit those receipts itself. The room holds the consumer until the builder's newly registered ID is assigned. Completion requires a later render receipt for that exact version from the named consumer. Failed registration, a catalog listing, an older version, and another member's render do not satisfy the handoff. Requirements and receipts survive tool approval and reload; each assignment resolves the current saved member configuration again.

When the consumer is requested, the host prepares the exact assignment from the declared handoff and successful registration receipt. Existing team allowance and approval rules still apply. Approving that exact tool dispatches the waiting consumer directly, without another supervisor planning turn. If the budget is already exhausted, the assignment is saved but the execution remains bounded and unfinished. Recent memory is included in each prompt; full retained memory remains available through `read_team_context`, respecting member-private scope. Builders without saved-tool execution grants see list/register actions only; registration itself runs the sample validations.

If a worker finishes without submitting its team action, the host allows one submission-only repair with just `submit_team_turn` available. Existing tool effects are not rerun. Saved member instructions describe reusable methods; test routes, prices and one-run delivery restrictions belong in assignments, and member edits should leave the team memory policy intact.

Runtime submissions distinguish reasoning, execution, routing and blockers. Execution must cite successful tool-call IDs from that worker's current turn; invented IDs and context lookups do not qualify. This establishes provenance, not semantic proof that every sentence follows from a cited result. Reasoning-only submissions carry an explicit host notice that they do not certify execution effects.

A specialist's blocked turn returns to its supervisor for resolution before pausing the team. The supervisor can assign an approved tool, prepare a tool proposal, or surface the human decision. This routing grants no capabilities and does not bypass credentials or approval. Runs remain subject to the team's existing round, time and token limits; registered templates survive a bounded run.

## Design choice

Executing arbitrary generated scripts would require a separate packaging, execution and permission contract. Typed static templates cover reusable reports while keeping rendering in one host module. General executable tools and external connection setup remain separate capabilities.

## Validation

`report-tool-registry.test.ts` covers registration, persistence, separate-member execution, input validation, text escaping, missing/stale timestamps and required grants. `pi-team-reconciliation.test.ts` covers parallel admission and catalog discovery. `chat-draft-approval.test.ts` covers delegated wording, refusals and host-selected user evidence. Live team validation additionally checks registration, reporter invocation, the rendered artifact and the provider draft response.
