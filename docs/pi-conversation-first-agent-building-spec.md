# Pi conversation-first agent building specification

## Status

Implemented and locally validated on `codex/model-settings-gear` on 2026-09-02.
This specification refines the Agent Builder experience without replacing the
existing agent registry, build lifecycle, task service, approval service,
improvement workflow, or routine scheduler. Commit, merge, push, and paid
provider verification remain separate user decisions.

Implementation record:

- durable session/build links retain assumptions, material clarifications,
  source message references, exact proposals, and recovery state;
- direct form and conversational writes share version-checked build revisions;
- immutable unpublished candidates can be tested and accepted before registry
  publication;
- exact chat proposals bind action payload, build revision, session, expiry,
  and the user's later confirmation text;
- a bare `yes` is rejected when several proposals are pending;
- `publish-and-schedule` records publication, promotion, and routine creation
  as ordered results, including partial completion evidence;
- read-only build inspection lets Pi report proof, evidence, questions,
  readiness, and pending approval in the current conversation;
- Agent Builder displays assumptions, open decisions, readiness blockers, and
  the newest proposal while Workflow/Attention restores actionable builds; and
- capability grants, model controls, browser policy/profile, and browser
  workflow grants survive candidate testing and publication.

Validation record:

- 64 focused lifecycle, coordinator, exact-approval, HTTP, and browser-setting
  tests passed;
- the repository non-e2e test gate (`./test.sh`) passed;
- `npm run check`, generated-browser verification, dependency-lock checks, and
  `git diff --check` passed;
- desktop, 390×844 phone, and 884×1104 resized/foldable browser flows passed
  with zero browser-console errors; and
- one live host is listening on port 4173, while user-specific agents and
  lifecycle state remain excluded by `**/.pi/*`.

## Outcome

A user can describe an agent in ordinary conversation, answer only material
clarification questions, test the candidate in the current chat, refine it from
observed results, and say `publish` or `publish and schedule` when ready.

Agent Builder is the inspectable package view behind that conversation. It is
available at any time for direct editing, but completing a form is not the
normal creation path.

The intended experience is:

1. The user describes the outcome they want.
2. Pi creates a useful draft immediately and identifies material ambiguity.
3. Pi asks one concise clarification at a time when the answer would change
   meaning, authority, cost, delivery, or acceptance.
4. The user tests the candidate without leaving the current conversation.
5. Results and feedback update a candidate revision and its improvement
   criteria.
6. Pi presents a short readiness review with assumptions and unresolved risks.
7. The user requests publication or automation in chat.
8. Pi presents the exact proposed actions for a yes/no decision.
9. The deployed agent appears in the persistent Agents roster and keeps one
   durable inbox.

## User-visible principles

- **Conversation first.** Natural language is the primary interface. Structured
  controls are a view and escape hatch, not a prerequisite.
- **Draft early.** Pi should produce a provisional package before seeking
  cosmetic details. A question must not prevent safe, reversible progress.
- **Clarify selectively.** Ask only when choosing silently could materially
  change what the agent does or what authority it receives.
- **Show assumptions.** Reversible defaults are chosen and disclosed instead
  of becoming questions.
- **Test where the idea began.** Candidate tests and results appear in the
  current conversation, with detailed evidence available in the drawer.
- **Feedback becomes criteria.** The user's wording is retained and translated
  into observable improvement and non-regression checks.
- **No implied deployment.** Drafting, testing, publishing, granting authority,
  and scheduling remain distinct actions.
- **Inspectability.** The complete package, changes, evidence, permissions, and
  schedule remain reviewable in Agent Builder.

## Problem

The existing lifecycle safely supports candidate configuration, proof,
acceptance, promotion, feedback, later edits, and scheduling. The remaining
experience gap is that users must understand the package structure too early.

For example, a user may say:

> Build an agent that sends me an Ozark outdoor brief every morning.

A form-first flow asks for name, persona, model, tools, schedule, location,
output format, and success criteria. Most of those choices can use safe
defaults. One cannot: `Ozark` may mean the Missouri Ozarks, the city of Ozark,
or a broader region. Choosing silently can produce consistently wrong work.

The solution is a conversational layer that drafts what is known, asks about
the material geographic ambiguity, and leaves safe defaults visible for later
inspection.

## Design alternatives

### Alternative A: add chat around the existing form

Chat fills fields, but the form remains the workflow owner and determines the
next required input.

This is easy to add, but preserves the configuration burden. Every new package
field creates another conversational step, and users still experience a wizard
whose questions happen to appear as messages.

### Alternative B: treat the conversation transcript as the agent definition

The model reconstructs the complete package from chat history whenever it
tests or publishes.

This feels fluid initially, but makes state, revisions, unanswered questions,
and exact approval targets difficult to inspect. Restart, concurrent tabs, and
later editing can reconstruct different definitions from the same prose.

### Alternative C: conversation coordinator over the existing lifecycle

The conversation proposes versioned patches to the existing build record. A
small coordinator owns links between a session, source messages, outstanding
clarifications, assumptions, and lifecycle operations. The existing services
continue to own validation, proof, acceptance, promotion, scheduling, grants,
and execution.

**Decision:** use Alternative C. It preserves a low-friction conversation while
keeping one authoritative definition and one security lifecycle. The added
coordinator absorbs conversational ambiguity without becoming another agent
runtime or deployment path.

## Authority and module ownership

```text
Current Pi conversation
  └─ ConversationBuildCoordinator
       ├─ links source messages to one AgentBuildRecord
       ├─ records assumptions and material clarifications
       ├─ applies version-checked draft patches
       └─ projects lifecycle state back into chat and the drawer

Existing authoritative services
  ├─ AgentBuildLifecycleService → candidate, proof, acceptance, promotion
  ├─ AgentRegistry              → deployed revision
  ├─ AgentTaskService           → agent inboxes and ordinary work
  ├─ AgentRunManager            → immutable candidate test attempts
  ├─ CapabilityApprovalService  → exact action approval
  ├─ CapabilityBroker           → governed capability execution
  └─ AgentRoutineScheduler      → automation definitions and dispatch
```

The coordinator may propose and present. It cannot deploy, grant, install,
authenticate, schedule, or execute a consequential external action directly.

### Information hidden by the coordinator

Callers should not need to understand:

- how source messages map to a build record;
- how draft revisions prevent stale conversational patches;
- how assumptions and answered questions survive restart;
- how a candidate test is correlated back to the initiating message;
- how lifecycle events become compact conversation cards; or
- how a pending natural-language confirmation binds to one exact action set.

The coordinator does not own package validation, provider capability policy,
permission policy, proof evaluation, task persistence, or schedule calculation.

## Canonical state

`AgentBuildRecord` remains the authoritative candidate lifecycle record. The
conversation layer adds linkage and decision evidence, not a second lifecycle.

```ts
interface AgentBuildConversationLink {
  buildId: string;
  sessionId: string;
  mode: "create" | "edit" | "improve";
  sourceMessageIds: string[];
  assumptions: AgentBuildAssumption[];
  clarifications: AgentBuildClarification[];
  activeProposalId?: string;
  lastPresentedBuildRevision: number;
  updatedAt: number;
}

interface AgentBuildAssumption {
  id: string;
  topic: string;
  value: string;
  rationale: string;
  sourceMessageId?: string;
  status: "active" | "replaced" | "confirmed";
}

interface AgentBuildClarification {
  id: string;
  topic: string;
  question: string;
  reason: string;
  blockingActions: AgentBuildActionKind[];
  status: "open" | "answered" | "withdrawn";
  answerMessageId?: string;
}

type AgentBuildActionKind =
  | "test"
  | "publish"
  | "publish-and-schedule"
  | "install"
  | "connect"
  | "grant"
  | "schedule";
```

Presentation labels such as Discovering, Ready to test, Reviewing, and Awaiting
approval are derived from this link and the existing build stage. They are not
persisted as another state machine.

Full conversation text remains in the session transcript. Build linkage stores
message references and bounded summaries; it does not copy private transcripts
into agent definitions or public packages.

## Conversation contract

The model-facing surface should express user outcomes rather than expose
storage operations:

```ts
interface ConversationBuildCoordinator {
  begin(request: BeginConversationBuild): Promise<ConversationBuildView>;
  applyIntent(request: ApplyBuildIntent): Promise<ConversationBuildView>;
  answerClarification(request: AnswerBuildClarification): Promise<ConversationBuildView>;
  testCandidate(request: TestConversationBuild): Promise<ConversationBuildView>;
  recordFeedback(request: RecordConversationBuildFeedback): Promise<ConversationBuildView>;
  prepareActions(request: PrepareBuildActions): Promise<ExactActionProposal>;
  inspect(buildId: string): Promise<ConversationBuildView>;
}
```

Every mutation includes the expected build revision. A stale patch fails with
the current view and a concise conflict explanation. It never overwrites a
newer form edit, another browser tab, or a later conversation turn.

`prepareActions` creates a proposal only. Execution continues through existing
exact action-bound approval and lifecycle operations.

## Selective clarification policy

### Ask when the answer is material

A clarification is material when two plausible answers would change at least
one of these:

- the core outcome or subject;
- geographic, organizational, account, or audience scope;
- a consequential external action or recipient;
- data sources, workspace boundaries, or private information access;
- required plugins, connections, tools, or permission grants;
- recurring schedule, timezone, delivery destination, or duration;
- paid usage, processing tier, or a user-stated budget;
- success criteria or a condition required for safe publication; or
- whether the request is a new agent, an edit, or an improvement to an existing
  agent.

Examples:

| User statement | Behavior |
| --- | --- |
| “Cover the Ozarks.” | Ask which geographic scope because results change materially. |
| “Send it to the team.” | Ask which destination and recipients before granting or publishing delivery authority. |
| “Run every morning.” | Ask for local time; infer the user's configured timezone and disclose it. |
| “Use a good model.” | Choose a supported default and disclose it; do not ask unless cost or capability changes materially. |
| “Make the wording friendly.” | Apply a reversible style assumption and show it in the draft. |
| “Choose whatever you think is best.” | Make the decision, record the assumption, and continue. |

### Do not ask for safe defaults

Do not block the common path on:

- agent name, icon, or persona;
- exact phrasing or formatting;
- model choice when a supported default satisfies the stated work and no paid
  premium mode is implied;
- optional capabilities not required by the requested outcome;
- automation details when the user has not requested automation; or
- settings already available from the current project, locale, or explicitly
  selected agent.

### Question behavior

- Ask at most three tightly related questions in one turn; prefer one.
- Explain why an unusual or consequential answer is needed.
- Offer two or three likely choices when they genuinely cover the decision.
- Accept free-form answers and explicit delegation such as “you decide.”
- Draft all unaffected fields while a question remains open.
- A question blocks only the actions listed in `blockingActions`.
- Never repeatedly ask a question answered by a later message or a direct form
  edit.
- Never represent a model confidence number as user certainty. Readiness is a
  checklist of known facts, assumptions, evidence, and unresolved decisions.

## End-to-end interaction

### 1. Detect and begin

Explicit requests such as “build an agent,” “turn this into an agent,” “make a
bot for this,” or “improve my weather agent” begin or resume a build. Pi states
its interpretation in one sentence and creates a draft build record.

Ordinary brainstorming does not silently create a build. Pi may offer a
non-mutating `Build this agent` action when intent is plausible but not explicit.

One session may retain several linked builds, but only one is active in the
composer at a time. Switching is explicit through the build chip or drawer.

### 2. Draft and clarify

Pi converts the user's stated outcome into a versioned candidate patch. It
records inferred defaults as assumptions and emits only material questions.

The response should be compact:

> I drafted a daily outdoor brief using your local timezone. One decision
> changes the sources and forecast area: do you mean the Missouri Ozarks, the
> city of Ozark, Missouri, or another region?

The right drawer shows the structured package immediately. It updates after
each accepted patch and marks assumptions distinctly from user-confirmed facts.

### 3. Test in the current conversation

“Try it,” “test it,” or an equivalent action starts an immutable candidate test
through the existing run manager. The candidate is not added to the deployed
registry.

The center conversation receives:

- a compact test-started card;
- streamed or summarized progress consistent with normal task presentation;
- the candidate result;
- evidence and criterion status; and
- `Refine`, `Test again`, and `Review package` actions.

Candidate capabilities use the same grants and approvals they would use after
deployment. A test cannot borrow the current Pi session's credentials,
approvals, browser ownership, or unrestricted tools.

### 4. Convert feedback into an improvement candidate

Statements such as “make it more local,” “that included Arkansas but I only
want Missouri,” or “keep the forecast but shorten the news section” are stored
as feedback linked to the relevant test run.

Pi proposes:

- required improvement criteria derived from the requested change;
- non-regression criteria for behavior the user asked to keep; and
- advisory preferences that should not block promotion.

The user's original wording and source run remain visible. Pi may propose a
measurable evaluator, but it must not rewrite a subjective preference as an
objective fact or claim that a candidate improved before proof.

The active deployed revision, if any, remains unchanged until the candidate is
proved, accepted, and promoted.

### 5. Readiness review

Before requesting publication, Pi presents a concise review:

```text
Ready to publish
Outcome: Daily Missouri Ozarks outdoor brief
Test: Passed 4 required checks; 1 advisory preference
Schedule: 7:00 AM America/Chicago, daily
Delivery: Agent inbox only
New authority: Web research and weather lookup; no external writes
Assumptions: Uses Springfield as the forecast reference point
Open decisions: None
```

Readiness is blocked when required proof failed, a material clarification is
open for the requested action, required capability health is unavailable, or
the exact candidate changed after proof.

### 6. Publish and schedule through exact approval

A natural-language command requests an action; it does not bypass action
review. Pi creates an exact proposal containing:

- build ID and candidate revision;
- accepted proof ID and evaluation digest;
- deployed agent ID and resulting revision;
- every capability grant being added or widened;
- plugin installation or connection steps, if any;
- routine prompt, cron expression, timezone, destination, and enabled state;
- execution order and possible partial outcomes; and
- expiration and live session authority.

The proposal appears at the top of the assistance drawer and may also be
represented by a compact card at the current conversation position. The user
never needs to find an old message by scrolling.

If Pi has just shown exactly one live proposal and asks a yes/no question, a
chat reply of “yes” confirms that proposal. The confirmation is bound to its
proposal ID, digest, session, and expiration. “Yes” is rejected as ambiguous
when several proposals are pending or the candidate changed.

`Publish and schedule` may be reviewed in one proposal, but the receipt records
each action separately. Execution order is publish, then routine creation. If
publication succeeds and routine creation fails, the agent remains published,
the partial result is explicit, and the user receives a retry action scoped only
to scheduling. The system must not claim atomicity it cannot provide.

### 7. Continue after publication

Publication adds or updates the persistent roster entry immediately. The
current conversation shows `Open agent`, while the right drawer remains
available for package inspection.

Later user-initiated Edit or Improve actions reopen the same package and
lifecycle history. A later conversation creates a candidate revision; it does
not edit the active definition in place.

## Agent Builder package view

The drawer is a synchronized view of the current build record, not a separate
draft owner. It contains:

- **Summary** — outcome, audience, status, assumptions, open questions, and
  readiness blockers;
- **Instructions** — candidate purpose, behavior, output contract, and persona;
- **Model & Tools** — resolved model controls, tools, plugins, connections,
  permissions, and availability;
- **Automation** — routine prompt, schedule, timezone, destination, and next
  run previews;
- **Criteria & Evidence** — required improvements, non-regressions,
  advisories, proof runs, and feedback sources;
- **Changes** — candidate-to-active semantic diff; and
- **History** — draft revisions, tests, acceptance, promotion, and later edits.

Direct form edits use the same version-checked patch operation as
conversation-generated edits. The conversation is notified when a form edit
replaces one of its assumptions or answers a clarification.

Advanced controls remain available without burdening the normal flow. Hidden
controls may not carry an undisclosed permission, premium processing, external
delivery, or destructive behavior.

## Drawer and responsive behavior

- The right assistance drawer slides over or beside the current conversation;
  opening it does not navigate away from the source session.
- Pending questions, approvals, failed tests, and partial actions contribute to
  an Attention count visible at the top of the interface.
- Dismissing the drawer does not reject or approve anything. The user may keep
  chatting while a proposal waits.
- Reopening Attention restores the newest actionable item, not the oldest chat
  position.
- On desktop, package review and conversation may remain visible together.
- On phone widths, the drawer becomes a full-height overlay with a clear back
  action and preserves the conversation scroll position.
- On foldable and resized layouts, navigation, center conversation, and details
  panes retain independent size constraints.
- Approval cards use explicit action text and accessible controls. Status is
  not conveyed by color or an unexplained symbol alone.

## Events and recovery

The browser receives bounded projections of these event families:

```text
agent-build.linked
agent-build.draft-updated
agent-build.clarification-opened
agent-build.clarification-answered
agent-build.test-started
agent-build.test-finished
agent-build.feedback-recorded
agent-build.proposal-created
agent-build.proposal-expired
agent-build.published
agent-build.scheduled
agent-build.partial-action
```

Events contain identifiers, revisions, status, and short summaries. Full
transcripts, secrets, and large evidence are retrieved through authenticated
resources.

After restart:

- session-to-build links and unanswered clarifications are restored;
- stale running tests recover through the existing run lifecycle;
- action proposals are revalidated or expired, never silently replayed;
- accepted proof remains bound to the exact candidate revision;
- a draft may resume from chat or Agent Builder without reconstruction; and
- successfully published agents, inboxes, and routines remain authoritative in
  their existing stores.

## Security and privacy invariants

- Conversation text is untrusted input, not authorization by itself.
- A short “yes” is valid only for one exact, current, live proposal that Pi just
  presented in the same session.
- Draft generation cannot install code, authenticate a connection, widen a
  grant, publish, schedule, or perform an external write.
- Candidate tests use immutable configuration snapshots and live run
  authority.
- Credentials and authentication challenges never enter build records,
  assumptions, clarifications, definitions, prompts, transcripts, or browser
  projections.
- Model/provider capability claims come from the existing reviewed capability
  owner; conversation does not infer controls from model names.
- The user must see premium processing, estimated cost, external recipients,
  write authority, browser access, and schedule state before approval.
- Feedback and evidence may reference private task/run IDs but are not copied
  into exportable agent packages.
- Personal agents and build history remain in ignored user storage.

## Error behavior

- **Stale draft:** return the current revision and show the conflicting changes;
  never apply a last-write-wins patch.
- **Lost context:** reopen the linked build from durable state rather than
  asking the user to repeat the request.
- **Ambiguous confirmation:** leave every proposal pending and ask which action
  the user intends.
- **Expired proposal:** generate a fresh exact review; do not reuse approval.
- **Candidate changed after proof:** invalidate readiness and require a new
  proof before promotion.
- **Unavailable capability:** preserve the draft, identify the unavailable
  requirement, and offer configuration or a reduced-scope candidate.
- **Failed test:** retain evidence and offer refinement; do not auto-publish.
- **Partial publish/schedule:** retain each completed action, report the exact
  remainder, and make retry idempotent.
- **Browser disconnect:** preserve the build and continue host-side work that
  already had authority; presentation catches up by event sequence.

## Proposed implementation goals

### Goal 1: conversational build contract and decision policy

Implement durable session/build links, assumptions, clarifications,
version-checked intent patches, and the material-clarification policy over the
existing lifecycle.

Review gate:

- an underspecified request produces a useful draft plus only material
  questions;
- reversible defaults become visible assumptions;
- the Ozark example blocks geographic proof/publication until resolved;
- form and conversation edits cannot overwrite each other silently; and
- restart restores the active build and its open decisions.

### Goal 2: in-conversation testing and feedback refinement

Project candidate tests into the initiating conversation and translate user
feedback into reviewed improvement, non-regression, and advisory criteria.

Review gate:

- tests use immutable candidate snapshots without deployment;
- test progress, result, evidence, and controls remain in the current chat;
- feedback retains its source wording and run reference;
- the active deployed revision remains unchanged during refinement; and
- changed candidates cannot reuse stale proof or acceptance.

### Goal 3: readiness, exact chat approval, and package synchronization

Add the concise readiness review, exact action proposals, unambiguous yes/no
confirmation, partial publish/schedule handling, and synchronized Agent Builder
sections.

Review gate:

- one “yes” can approve only the single exact proposal just presented;
- multiple, expired, or changed proposals cannot consume ambiguous consent;
- publish, grants, install/connect, and schedule remain separately recorded;
- direct form edits and conversational edits share one draft revision; and
- publication immediately updates the persistent roster without restart.

### Goal 4: responsive lifecycle validation and documentation

Exercise one isolated creation-to-improvement lifecycle and one later edit at
desktop, resized-pane, phone, and unfolded-foldable layouts.

Review gate:

- the lifecycle completes without requiring the user to fill the structured
  form or scroll backward for an approval;
- drawer dismissal, reconnect, restart, cancellation, and partial failure are
  deterministic;
- affected tests, `npm run check`, generated-browser verification, dependency
  audit, privacy audit, and `git diff --check` pass; and
- commit, merge, push, deployment, and paid provider tests remain separate
  explicit decisions.

## Acceptance scenarios

### New agent with material ambiguity

1. User requests an Ozark outdoor brief.
2. Pi creates a draft with safe defaults and asks for geographic scope.
3. User selects Missouri Ozarks.
4. Pi updates the draft and runs a candidate test in the same chat.
5. User requests a more local result.
6. Pi records the feedback, adds observable criteria, and proves a revision.
7. User says “publish and schedule it for 7 AM.”
8. Pi presents exact publication, grants, timezone, and routine details.
9. User says “yes.”
10. The agent appears below Sessions, its routine is visible, and its inbox
    contains the test, publication, and schedule receipts.

### Safe inference without unnecessary questions

1. User requests a code-review agent for the current project and delegates
   model choice to Pi.
2. Pi infers the project root, selects a supported default model without premium
   processing, drafts a name and persona, and discloses each assumption.
3. Pi asks no cosmetic questions and offers an immediate test.

### Ambiguous approval

1. A plugin installation and a separate agent publication are both pending.
2. User says “yes.”
3. Neither action executes; Pi asks which proposal the user means.

### Later improvement

1. User selects Improve from the persistent roster.
2. The current deployed revision becomes the immutable baseline.
3. Conversation feedback creates a candidate and required/non-regression
   criteria.
4. Testing and proof occur without changing the active agent.
5. Exact acceptance and promotion create the next deployed revision.

## Deliberate non-goals

- A second agent definition, task, approval, scheduling, or execution system.
- Autonomous publication based on a model-generated confidence score.
- Treating a free-form transcript as the canonical package.
- Asking the user to review every inferred cosmetic or reversible setting.
- Sharing Pi-session credentials or approvals with candidate agents.
- Unbounded self-improvement or recursive agent creation.
- Remote multi-user building, cloud federation, or marketplace publishing.
- Paid provider verification without a separately approved cost limit.
