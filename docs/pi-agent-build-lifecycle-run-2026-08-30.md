# Agent build lifecycle validation — 2026-08-30

## Scope

Validate the full draft, create, proof, review, refine, promote, and schedule
lifecycle with `ozark-outdoor-daily-brief` before turning the findings into an
implementation goal.

- Build: `build-716ed6c7-de57-4fa4-ac87-2bc771fecc33`
- Agent: `ozark-outdoor-daily-brief`
- Project: `C:\Users\bradj\Development\daily-mail-agent-feed`
- Intended schedule: daily at 10:00 America/Chicago
- Schedule status: inactive

## Lifecycle result

| Stage | Result | Evidence |
| --- | --- | --- |
| Draft | Passed | Existing staged build was recoverable from the current builder chat. |
| Create | Passed with UX issue | `Create agent` produced managed agent revision 1 and build revision 4. No routine was created. |
| Isolated proof | Runtime passed | Run `ffb2b938-5d84-4d25-9275-598bed1f55ed` completed and retained `run.json`, `transcript.json`, and `result.md`. |
| Proof quality review | Failed | The report rendered correctly but contained unsupported and geographically incorrect claims. The proof was rejected. |
| Rejection feedback | Passed | `Needs refinement` returned control to builder chat, where the user supplied concrete proof findings for the next revision. |
| Refine after rejection | Passed after recovery | The original builder turn stalled and the serve process exited. Restarting with the same capability token preserved the build, agent, proof, and feedback. The `Improve` flow then staged and applied agent revision 2. |
| Second isolated proof | Runtime passed, quality failed | Run `8a9ecbb5-bfe7-4877-886d-1df89ea4cdee` completed on agent revision 2, but reused the rejected report unchanged and repeated unsupported claims. The proof was rejected. |
| Promote | Not attempted | A rejected proof must not be promoted. |
| Schedule | Not attempted | No accepted proof or promotion exists, and the original 10:00 intent is no longer present in the build record. |

Current safe state: agent revision 2 exists, both proofs are rejected, and no
schedule is active.

## Improvement-loop result

The end-to-end feedback loop is functional but not yet reliable enough for
promotion:

1. `Needs refinement` retained the failed proof and returned control to the
   builder.
2. `Improve` collected an improvement goal, observable success criteria, and
   single-agent scope.
3. The generated improvement brief required a normal chat send before making
   changes.
4. The builder proposed a reviewed prompt-only update.
5. After two marker corrections, `Apply update` created agent revision 2 and
   moved the build to `ready-to-test`.
6. The identical proof task ran and retained a separate revision-2 transcript.
7. Human review rejected the result and returned the build to
   `needs-refinement`.

Revision 2 showed one process improvement: it called `feed_read` three times.
All three reads returned empty entry sets, so they did not verify any factual
claim. The agent nevertheless asserted that all events and sources were
verified. It made no `write` or `edit` call, left the prior report and state
unchanged, repeated the incorrect Lake of the Ozarks radius and direction
claims, retained inferred official alert wording, and left `messageCount` and
`actionCount` as `null`.

## Confirmed proof defects

### Search results were presented as verified sources

The agent made ten `searxng_search` calls and one `currents_search_news` call,
but made no `feed_read` call. It nevertheless said event data came from
verified official calendars. The prompt already said search snippets were
leads only, so prose instructions alone did not enforce the required evidence
boundary.

Required fix:

- Add a machine-checkable evidence ledger to the run result.
- Require a successful exact-page fetch for every event, venue, access, road,
  distance, and direction claim.
- Treat snippets only as discovery results.
- Omit claims whose exact source cannot be opened.
- Make proof review show source-fetch evidence instead of only the agent's
  self-authored summary.

### Geographic scope was not enforced

The proof called Lake Ozark/Lake of the Ozarks about 40 miles north and inside
the requested 45-mile driving radius. Independent route results place the trip
at roughly 102–108 driving miles. It also described Springfield destinations
as south of Ozark and Glade Top Trail as west, despite their actual directions.

Required fix:

- Store the anchor as Ozark, Missouri 65721 with resolved coordinates.
- Distinguish Ozark city, the Ozarks region, and Lake Ozark before research.
- Require route evidence for a claim stated as driving distance.
- Reject or omit candidates not proven within the requested radius.
- Prefer a smaller local result over regional filler.

### An official alert label was inferred

`weather_alerts` failed because XML was parsed as JSON. The report correctly
said alerts were unverified, but also displayed `Heat Advisory Notice` and
invented a possible 105°F+ heat index. A Heat Advisory is an official NWS
product and cannot be inferred from a daily high alone.

Required fix:

- Fix the provider's XML/JSON handling.
- Until fixed, label the section `Forecast-based heat caution`.
- Never use an official watch, warning, or advisory name unless the alert tool
  returns that product.
- Do not derive heat index without the necessary inputs.

### Self-checks overstated what ran

The result claimed valid HTML, all claims sourced, no fabricated data, and
successful verification. Its only post-write checks were reads of its own
files. It did not run an HTML validator or independently reconcile claims with
sources.

Required fix:

- Record actual validators and their results.
- Do not allow proof summaries to claim a check that has no retained evidence.
- Separate process success from goal success in the review UI.

### State was degraded

The run replaced existing `messageCount` and `actionCount` values with `null`.

Required fix:

- Preserve unknown or unrecomputed state fields.
- Update `state.json` only after report and index verification succeeds.
- Add a regression test for partial state updates.

## Pi Agents user-experience improvement backlog

These are product and interaction improvements exposed by the lifecycle test.
They are separate from defects in the generated Ozarks report.

### Keep approvals visible without blocking chat

- Put pending human decisions in a persistent, nonblocking approvals drawer.
- Keep the current chat usable while an approval is pending.
- Show the approval at the top-level interface instead of requiring the user
  to find an old control by scrolling through chat history.
- On mobile, expose the drawer through a visible attention indicator and keep
  primary actions within thumb reach.
- Allow direct chat approval such as `yes`, `approve`, `publish`, `run proof`,
  or `schedule it`, with an explicit confirmation of the interpreted action.
- Use yes/no approval prompts when the decision is binary and explain the
  consequence before the user answers.

### Make lifecycle state understandable

- Use consistent user-facing stages: Draft, Published, Testing, Needs
  refinement, Proven, Promoted, and Scheduled.
- Clearly distinguish publishing an agent from promoting a proven revision and
  enabling an unattended schedule.
- Keep drafts attached to their builder chat until publication.
- After publication, show the durable agent independently without losing its
  originating builder history.
- Put the current revision, proof status, and schedule status together in the
  persistent agent header.
- Separate runtime success from proof-quality success; a completed run must not
  visually imply that its result passed human review.

### Organize durable agents like persistent bots

- Place published agents in the left rail below Sessions.
- Keep the center area for the selected session, builder conversation, or agent
  conversation.
- Replace the right-side Agents tab with Activity and Approvals; keep Browser
  available there as a peer tool.
- Preserve the draft card in the current builder context until publication.
- Show agents as durable identities rather than as attention events or
  transient chats.

### Make improvement feedback the primary refinement path

- Treat normal builder chat as the canonical place for human findings and
  improvement requests.
- Seed `Improve` with the selected failed proof and its retained evidence.
- Let the user edit the proposed goal and success criteria before sending it.
- Show the exact configuration delta before Apply, including fields preserved
  from the previous revision.
- Warn when a proposed prompt edit replaces existing instructions instead of
  merging with them.
- After Apply, offer `Run the same proof` so revision comparisons use identical
  tasks automatically.
- Keep failed-proof findings attached to subsequent revisions until each
  criterion passes or the user explicitly removes it.

### Surface errors where the user can act on them

- Show unsupported draft fields and malformed marker JSON inline instead of
  silently leaving Apply disabled.
- If a turn stalls, show elapsed no-progress time, a reliable Stop action, and
  a retry that preserves the pending message.
- If the local host disconnects, show Reconnecting or Restart required instead
  of leaving the session in an indefinite turn state.
- After recovery, return the user to the same agent, builder transcript, and
  pending lifecycle decision.
- Explain why an action is disabled and what concrete condition unlocks it.

### Make proof review evidence-first

- Show the actual tool ledger beside the agent-authored result.
- Distinguish successful exact-source reads from empty or failed reads.
- Highlight claims that lack retained source evidence.
- Show files created or changed and flag when a proof reused an old artifact
  without modifying it.
- Present success criteria as individual pass, fail, or unverified checks.
- Keep Accept proof unavailable when mandatory machine-checkable criteria fail,
  while still allowing the user to override with an explicit risk decision if
  that policy is desired.

### Simplify delegation controls

- Replace the `Delegation connections` text button with a Pi-themed external
  agent icon beside Settings.
- Use a tooltip, accessible label, connection-state indicator, and a minimum
  44 px mobile target.
- Keep connection setup separate from individual delegation approvals.

### Preserve intent without enabling automation

- Retain a proposed cadence and timezone as inactive schedule intent throughout
  draft, proof, rejection, and refinement.
- Let the user say `publish and schedule` from chat after confidence is high.
- Require a clear final confirmation before enabling unattended execution.
- Show the next run time and an obvious pause control after scheduling.

## Confirmed UI and lifecycle defects

### Create/publish is hidden in chat history

Opening the draft returns to its builder chat at the previous scroll position,
while the `Create agent` control is rendered at the top of the transcript.
This is effectively unavailable on mobile without discovering that a long
scroll is required.

Required fix:

- Keep lifecycle actions in a persistent header or a nonblocking approvals
  drawer.
- Use the user-facing term `Publish` if publication is the intended concept;
  otherwise clearly distinguish `Create` from later promotion.
- Allow chat to remain usable while approval waits.

### Builder and Stop can remain stuck

After detailed rejection feedback was submitted, the builder session entered
`turn` but appended no model or error event for several minutes. Clicking
`Stop response` did not change phase or append an aborted event.

Required fix:

- Add first-event and no-progress timeouts to builder turns.
- Make abort independent of the blocked provider request and return promptly.
- Surface `Stopping...` and a bounded failure state.
- Add a recovery action that preserves the pending user message.
- Add a regression test for aborting a builder turn that produces no events.

The stalled turn eventually surfaced `Byte transport closed`, and the local
serve process exited. Restarting the process recovered all durable lifecycle
state and the existing authenticated URL, so persistence passed even though
turn recovery failed.

### Improvement draft fields are inconsistent

The improvement builder first emitted an `AGENT_DRAFT` containing
`systemPrompt`, but the browser draft parser accepts `persona` for the agent
instructions. `Apply update` therefore remained disabled with no visible parse
diagnostic. The first corrected `persona` marker also contained malformed JSON
with a stray empty property and was silently ignored. A third chat correction
finally produced valid JSON.

Required fix:

- Define one shared typed draft schema for the builder prompt, marker parser,
  form, and registry tool.
- Accept `systemPrompt` as an alias or require `persona` consistently.
- Validate markers and show the exact parse or unsupported-field error beside
  the assistant response.
- Test valid prompt-only edits, unsupported fields, and malformed JSON.
- Require prompt edits to merge with the current instructions unless the user
  explicitly approves full replacement.

### Schedule intent was lost

The original 10:00 America/Chicago request was described by the builder but is
absent from the current build record. Creation and proof correctly left the
routine list empty, but there is nothing to repopulate after promotion.

Required fix:

- Persist schedule intent separately from an enabled routine.
- Preserve it across refinements, creation, proof rejection, and promotion.
- Require a final explicit enable action after accepted proof and promotion.

### Navigation does not match durable ownership

The right `Agents` tab mixes durable agents with activity while the left side
is organized around sessions. The proposed information architecture is:

- Left, under Sessions: published durable agents, formatted like persistent
  bots.
- Center: the active chat or agent conversation.
- Right: Activity, Approvals, and Browser.
- Drafts remain builder sessions until publication.
- Replace the text `Delegation connections` control with a 44 px Pi-themed
  external-agent icon, tooltip, accessible label, and status indicator beside
  Settings.

## Visual review

The generated report itself passed layout checks:

- Desktop viewport: 1440 × 900.
- Mobile viewport: 390 × 844.
- Mobile document width equaled viewport width; no horizontal overflow was
  found.
- The only browser console error was a missing `favicon.ico`.

Artifacts:

- `output/playwright/ozark-proof-desktop-viewport.png`
- `output/playwright/ozark-proof-mobile-viewport.png`
- `output/playwright/ozark-proof-desktop.png`
- `output/playwright/ozark-proof-mobile.png`

## Next resume point

Do not promote or schedule revision 2. The next design goal should address
machine-checkable proof criteria rather than adding more prompt prose. Resume
with revision 3 only after the lifecycle can reject empty `feed_read` results,
unsupported validation claims, stale artifact reuse, out-of-radius candidates,
official alert labels without a confirmed alert, and null state regressions.

## Implementation outcome

The lifecycle goal was implemented and validated against the same Ozark daily
brief case. Drafts now retain their full package, candidate revisions remain
inactive, feedback and criteria are durable, proof checks distinguish Pass,
Fail, and Unverified, and promotion and scheduling require separate explicit
human actions. The same controls are available through chat tools and through
the persistent Workflow drawer on desktop and mobile.

The validation used build `build-716ed6c7-de57-4fa4-ac87-2bc771fecc33` with published revision 2 retained
as the active agent and revision 3 staged as the candidate. Its requested
schedule remained an inactive intent for daily 10:00 America/Chicago. No
routine was created.

Proof run `22b15998-4f8f-4428-8aa9-25141be65736` completed at the runtime level,
but the lifecycle correctly moved the build to `needs-refinement` instead of
accepting the model's success claim. The resulting checks were:

| Criterion | Result | Evidence |
| --- | --- | --- |
| Goal achieved | Unverified | Human review required |
| Output responsive | Unverified | Human review required |
| Workspace boundaries | Unverified | Human review required |
| Exact-source grounding | Fail | 0 of 1 `feed_read` receipts had non-empty structured results |
| Official-alert validation | Fail | The alert lookup produced a tool error |
| Report written | Pass | Two workspace mutations were observed |
| Report current | Pass | The report artifact changed during the proof |
| Local geography | Fail | The report still contained `Lake of the Ozarks` |
| Alert honesty | Fail | The report still contained `Heat Advisory Notice` |
| Message count persisted | Fail | `messageCount` remained `null` |
| Action count persisted | Fail | `actionCount` remained `null` |

The user feedback loop was also exercised with rating 2 and three structured
feedback aspects. That feedback and the 11 criteria remain attached to the
candidate package. A failed proof cannot be accepted, the Accept action is
disabled in the UI, the active revision is not replaced, and the inactive
schedule cannot be enabled. Proof attempts are now archived so later candidate
runs can show a baseline-versus-current comparison; the deterministic
regression test verifies a failed attempt is retained before a corrected rerun.

The workflow presentation was verified at desktop and 390 x 844 mobile sizes.
Durable agents appear under Sessions on the left, while the right Workflow
drawer presents pending actions without blocking chat. Selecting the Ozark
workflow item opens the candidate package and evidence review directly. The
external-delegation action is a Pi-themed accessible icon beside Settings.

Artifacts:

- `output/playwright/pi-agents-workflow-desktop.png`
- `output/playwright/pi-agents-workflow-mobile.png`
- `output/playwright/pi-agents-ozark-evidence-mobile.png`

Validation completed with 11 focused lifecycle and registry-tool tests passing.
The full `npm run check` pipeline also passed, including formatting, TypeScript,
generated browser assets, dependency checks, lockfile checks, and browser smoke
tests.

## Goal disposition

The product lifecycle goal is complete. The Ozark candidate itself is
intentionally rejected, not promoted or scheduled. This is the expected result:
the improvement loop found real regressions, preserved the safe active revision,
and gave the user actionable evidence for the next refinement.

## Pre-merge verification

After local execution access was restored, a broader focused run passed all
50 tests across seven lifecycle, registry, executor, WebSocket, service, and
serve-page test files. Two old UI-label assertions were updated to verify
`Publish agent` and `Save candidate revision`. The full `npm run check`
pipeline passed again with no formatting fixes required.

## Fork-owned hardening and candidate refinement

The follow-up implementation leaves inherited upstream Git-ref parsing,
regular-expression, provider-hostname, and publishing-workflow findings deferred
to upstream. It does not dismiss those security findings or claim they are fixed.

Implemented locally:

- A shared public HTTP reader enforces the 2 MB limit while streaming decoded
  body bytes, a 30-second total deadline, caller cancellation, five redirects,
  credential-free URLs, and public-address validation at actual socket DNS
  resolution. Redirect, error, oversized, and interrupted bodies are cancelled.
- Weather tools request JSON/GeoJSON explicitly. Named locations support
  state/country constraints and reject ambiguous results; callers can provide
  explicit coordinates. A malformed alert response is not an empty collection.
- RSS/Atom parsing distinguishes empty feeds, malformed XML, and ordinary pages,
  rejects document entities, uses bounded linear tag extraction for malformed
  CDATA, and decodes one entity layer. `fast-xml-parser`
  5.7.3 is an exact direct dependency; it was already present transitively.
  Lockfile and distribution-lock regeneration changed only that dependency edge.
- `page_read` retains exact URL, retrieval time, bounded static text, and a
  truncation flag. It does not execute JavaScript or independently verify claims.
  Its separate Pi Public Web capability starts quarantined and does not change
  the existing Everyday Data provider's trust digest.
- Windows `/cd` no longer passes project paths or arguments through `cmd.exe`.
  Encoded PowerShell transports a data payload and starts the native executable
  with Windows argument quoting. The intentionally visible interactive window is
  retained; failure to start the launcher leaves the existing session open.
- CI now supports manual dispatch, read-only repository permissions, no retained
  checkout credential, the isolated `test.sh` runner, and a fork-only Windows
  launcher regression job. Remote execution and required-check configuration
  remain pending a committed/pushed review branch and a successful real CI run.

Validation before the live proof:

- Full `npm run check` passed, including browser, TypeScript and distribution locks.
- 76 focused data, capability, lifecycle, registry, executor and serve-page tests passed.
- All seven Windows project-launcher tests passed, including real native argument
  round-tripping for spaces, quotes, metacharacters, Unicode, empty arguments,
  trailing backslashes and newline characters.
- Root `npm audit --json` reported zero known vulnerabilities across 418 dependencies.
- Live read-only provider checks resolved Ozark, Missouri to 37.02089, -93.20602;
  NWS returned a valid FeatureCollection; the official city home page returned text.

The existing build was updated through the builder lifecycle API, not by editing
the active agent definition. Active revision 2 remains unchanged; candidate
revision 3 now uses Ozark city as its sole origin, explicit Missouri coordinates,
exact page reads, honest alert semantics and qualified source evidence. Previous
feedback and the failed proof are retained. No proof was accepted, no skill was
promoted and no routine was created.

The candidate's legacy email counters are explicitly scoped to the current
non-email task: zero email messages and zero email actions, with a counts-context
explanation. This avoids inventing tool or token counts. The proof also requires
an actual successful alert receipt, so simply skipping the alert lookup cannot
pass. Text-based counter checks are narrow regression checks, not a JSON-schema
validator; source receipts likewise do not prove every claim in the report.

The same proof prompt, `Create today's Ozark, Missouri outdoor brief`, was started
as run `e6b168af-70c1-4b0d-8ae9-4bf44f834557`. The test server was restarted with
the same authenticated links. Pre-proof report, index and state backups are in
`C:\Users\bradj\AppData\Local\Temp\forkpi-fixes-20260830-a7f3`.

### First repaired-provider proof: still rejected

Run `e6b168af-70c1-4b0d-8ae9-4bf44f834557` succeeded at runtime. Eight machine
checks passed: five exact-page receipts, no alert-tool errors, a successful
official-alert receipt, three file writes, changed report, removal of the prior
unsupported advisory label, and both zero-valued counters. The geography check
failed: the new report still recommended Lake of the Ozarks as roughly 40 miles
away and Springfield as south of Ozark. It also reused snippet-only facts and
mislabelled UTC timestamps as local time. The lifecycle correctly kept it in
`needs-refinement`; the three human-review checks remained unverified.

An explicitly labelled automated review was retained as feedback, without human
acceptance. A further candidate refinement prohibits reusing rejected factual
content, preserves only its CSS/layout, names the known unverified destinations
to omit, and requires a smaller report when exact evidence is unavailable. It
also prohibits invented hourly weather and unsupported numerical safety claims.
The identical proof task was restarted as
`733a8e9a-5e0f-4ca1-884b-d5f1f9c5e303`; both earlier proof attempts remain archived.

### Second proof: machine checks pass, outcome review still fails

Run `733a8e9a-5e0f-4ca1-884b-d5f1f9c5e303` completed with all nine configured
machine checks passing and three human checks unverified. The known distant-lake
claim disappeared, five exact page reads succeeded, official alerts were parsed,
the report changed, and the state counters remained numeric zero. The candidate
therefore reached `proof-ready`, not accepted or promoted.

Source review still found unsupported claims. The report's own evidence ledger
admits that court details, fishing conditions, trail ratings and the Lions Club
race rely on snippets or inference, yet its body and final summary describe them
as verified. It also converts route directions starting in Springfield into an
Ozark-origin mileage estimate. Most UTC labels improved, but some ledger entries
still claim `21:20 CT`.

Playwright review at 1440 x 900 found no horizontal overflow. At 390 x 844 the
document width was 532 pixels: an unbroken RunSignup evidence URL overflowed.
This is a generated-report regression, not a new Pi console layout defect.

Artifacts:

- `output/playwright/ozark-repaired-desktop.png`
- `output/playwright/ozark-repaired-mobile.png`

These failures were retained as explicitly labelled automated feedback, returning
the build to `needs-refinement`. No human criteria were marked accepted. The
remaining candidate work is claim-by-claim evidence reconciliation, truthful
distance/time handling, and long-link wrapping with an actual mobile width test.
No direct hand-edit of the generated report was used to make the test pass.

The platform hardening has 83 focused tests passing in total (76 core and seven
Windows tests), a passing full check pipeline, clean whitespace checks, and valid
CI YAML with trigger/permission/runner/action-pin assertions. Remote CI and main
branch protection are not yet established: no commit, push, PR, merge, or GitHub
settings mutation was made in this implementation turn.

## Review branch and remote CI validation

The approved fixes were committed on `codex/fork-public-data-hardening`:

- `e3c0d4c90`: public-data hardening, Windows project launch and proof documentation.
- `dfc091be2`: Playwright packaging and CI browser prerequisites, plus the stale
  restart-recovery test assertion. Recovery remains `interrupted`, with a visible
  failure Attention item; production recovery behavior was not changed.

The first real GitHub CI run, [33338361046](https://github.com/r33n3/pi-Agents/actions/runs/33338361046),
passed Windows tests but failed Node bundling because esbuild followed Playwright's
optional browser-backend imports. Playwright now remains an installed, pinned
runtime dependency, retaining its own package-relative assets. CI explicitly
installs Chromium and passes only its binary-cache location through the isolated
test environment. A bundled CLI version check guards startup after packaging.

The follow-up [CI run 33338502343](https://github.com/r33n3/pi-Agents/actions/runs/33338502343)
passed both `build-check-test` and `windows-project-launcher`. This includes the
full build, check pipeline, bundled CLI smoke test, full isolated Linux test suite,
and seven Windows project-launch tests. Eight focused task-service/durability
tests and the full local check pipeline also passed.

Local full-suite limitations remain documented, not silently waived. Windows
tests encountered symlink-permission and Unix-path assumptions. A clean Ubuntu
source checkout initially lacked generated model data, compiled package entries,
`fd` and Chromium; GitHub's build/install steps supplied those prerequisites. An
unchanged upstream credential-cache test failed locally but did not fail the
complete GitHub run. No upstream auth code or assertions were changed to obtain
the CI result.

The branch is for review, not automatic merge. The Ozark build and its inactive
schedule were not changed during this commit/CI follow-up. Unrelated local
`output/` and `simple-webpage/` files were excluded from every commit.
