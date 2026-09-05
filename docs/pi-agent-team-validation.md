# Conversational team validation

Later wrong-file, arithmetic, and team-format findings and their retests are
recorded in [Bound input review validation](pi-bound-input-review-validation.md).
The results below are historical and are not the final reliability assessment.

Validated on 2026-09-05 (America/Chicago), using the working tree and the visible
Pi web console. Live inference used Anthropic `claude-haiku-4-5`, thinking off.

## User flow

Asked the builder in plain language for an inventory team: a calculator, an
auditor, and a coordinator, operating read-only in the current folder and only
when asked. The builder prepared three ordered roles. Reviewed the team card,
clicked **Launch team**, and submitted requests through one coordinator chat.
No bundle JSON, role IDs, tool syntax, or workflow wiring was supplied by the user.

The new `configure_team` tool compiles this common request into the existing
bundle review, installation, and workflow services. It accepts two to six
ordered roles, limited to read/ls tools, and inherits the current model and
workspace. Preparation does not install or run the team. Broader capabilities
still use the existing package/binding review path.

## Live results

| Scenario | Outcome | Retained workflow run |
| --- | --- | --- |
| Initial inventory review | Three real workers completed; calculator read the CSV, auditor checked the arithmetic, coordinator reported $26 | `b3048469-4cce-4424-b4d2-5df99d9fc409` |
| Changed request to missing file, before fix | Failed semantic check: reused inventory.csv and reported $26 | `abe71e14-6f6b-486e-8ed8-62eaa31d4dad` |
| Stop during execution | Chat showed cancelled; calculator finished, auditor stopped, coordinator never started | `7c503435-4681-4a10-ab24-84fc04999bed` |
| Missing file after fix | Calculator and auditor attempted the requested file; coordinator reported the missing input and no valuation, without substituting inventory.csv | `81673db4-b320-426e-b16b-48a0f0359765` |
| Recovery with valid input | All three workers completed; coordinator reported the verified $26 total; specialist evidence expanded correctly in the UI | `fdca1e93-2c68-4729-8038-24c36c8a0a0c` |

The fixture contains four notebooks at $4 and five pens at $2. The $26 is the
fixture's inventory value, not inference cost. Provider cost metadata was unknown.

The failed changed-input run exposed ambiguous prompt composition: reusable
role instructions followed the new request and repeated the original filename.
Workflow prompts now separate assigned responsibilities, predecessor evidence,
and the current request, explicitly preserving the requested input and scope.
New team role instructions also treat example filenames as defaults and prohibit
impersonating another specialist. The passing retest used the already installed
team, demonstrating the runtime fix without manually rewriting its roles.

The chat now shows the coordinator's final answer first. Specialist reports are
retained under **Team steps**, and running progress uses role names instead of
internal agent IDs.

## Automated checks

- Team drafting/installation test: deferred deployment, sequential dependencies,
  read-only permissions, omitted optional tools, and idempotent reviewed launch.
- Chromium conversation regression: plain-language builder request, reviewed
  launch, one coordinator chat, three worker starts, predecessor result handoff,
  concise final display, and expandable specialist reports.
- The same browser regression injects a checker failure and verifies a visible
  failed outcome with no coordinator execution. This failure uses mocked workers
  and faux inference; it is separate from the live cancellation test.
- Fifteen focused tests passed across team drafting, team conversation, agent
  services, and bundle installation. `npm run check` and `git diff --check` passed.

## Evidence and limits

Workflow records are in
`output/playwright/live-agent-ui/agent/serve/workflows/runs/<run-id>/run.json`.
Task records and worker transcripts are retained in the adjacent `tasks` and
`runs` directories. This isolated test store also contains credentials; do not
copy or publish the entire store as a validation artifact.

These are representative smoke tests, not a reliability guarantee across all
providers or arbitrary tasks. The ordered execution and handoff are controlled
by code; the arithmetic and prose remain model-generated. Exact operations
should use deterministic capabilities and independently checked output contracts.

Two presentation limitations remain: a completed workflow denotes completed
worker execution, including a valid report of missing input; and the filesystem
boundary currently reports a nonexistent file as unavailable/outside the
workspace. The final report makes the inability to value that input explicit.
No schedules or external messages were created.
