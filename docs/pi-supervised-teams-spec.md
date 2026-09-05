# Supervised teams

## Goal

Organize agents under named teams in the sidebar. A team supervisor receives the
user goal, selects relevant members from that roster, and recruits a specialist
when expertise is missing. Members exchange targeted requests in the same team
conversation. Membership does not grant access to agents outside the team.

## Design

Extend AgentRoomService with an explicit supervisor and optional recruitment.
Reuse its persisted conversation, task execution, workflow evidence, stop and
resource limits. Keep existing fixed workflows and round-based rooms available.
An alternative unrestricted agent-spawning tool would scatter membership,
permissions, and termination policy across worker prompts; the room owns these
decisions instead.

- Supervisor runs first, unless the user explicitly addresses a roster member
  with `@name`. Requests schedule only named recipients. A specialist
  without further requests returns control to the supervisor. Only the supervisor
  can finish the team task or recruit a role.
- Each turn receives the same user goal, team roster, assigned role, and prior
  messages. Member messages are evidence, never authority to change that goal.
- New roles are scoped to this team, inherit the supervisor's model/workspace,
  and have only its read/ls tools. They get no schedules, credentials, external
  capabilities, or recursive delegation. Recruitment is explicitly enabled at
  team setup and limited to eight members. Existing roles are reused by name.
- Sidebar team groups expose member roles. The team conversation displays actual
  authored turns, routed requests, final result, and stop/continue controls.
- Users can edit the roster between runs and submit subsequent requests to the
  same team. Run evidence preserves the roster used for that run.

## Validation

Exercise existing-member selection, peer requests, supervisor return, missing-role
recruitment, rejected outsider targets, recruitment disabled, limits, cancellation,
restart persistence, and unchanged legacy rooms. Validate sidebar grouping,
membership editing, and conversation use in Chromium, then run a live UI example.

## Using it

Click **Team +** in the left sidebar. Name the team, choose its supervisor,
select existing members, and describe the goal. Enable **Allow supervisor to add
missing specialists** when the supervisor may staff new roles. Each member keeps
its existing model; recruited roles inherit the supervisor's model.

The sidebar groups the roster under the team. Clicking the team or supervisor
opens its shared conversation in the main chat panel. Clicking a specialist
prepares an `@name` message there; the host routes that request to the selected
member first. The supervisor receives the result afterward. Use the team's **…**
control to edit membership between runs. Earlier requests remain in the chat.
Team tabs allow switching conversations while retaining unsent team drafts.
The normal composer sends requests, stops running work, and answers blocking
questions. Conversation use opens no dialog; team configuration still uses one.

Recruited roles remain saved in this team for reuse, with no automatic schedules.
They are not automatically deleted after a run. This first implementation creates
read-only specialists; additional write tools or external account access must be
configured through the existing agent controls.

## Validation record — 2026-09-05

The Chromium regression creates a team, enables recruitment, observes a specialist
appear in the sidebar, sends a follow-up, changes membership, and reloads the page.
Service tests cover targeted peer communication, supervisor return after pending
specialist work, direct addressing, recruitment, denied outsider requests, denied
recruitment, turn limits, cancellation, and persisted run/roster evidence. Legacy
room and fixed-team tests are retained.

Live UI test: **Inventory operations**, initially Coordinator, Calculator, Auditor,
using Anthropic `claude-haiku-4-5`. The first run rejected a recruitment format
mismatch (`8c3b420f-d4fe-4df5-a05c-4e45d52c4259`); no new role was created. The
decision format now accepts a list of at most one new role per turn.

The next run (`fca64566-e17a-479c-a982-68aad9ae6c1f`) recruited a real Data Quality
Specialist, routed member requests, and returned the expected inventory value of
26. It retained ten actual worker tasks. It also exposed redundant supervisor
scheduling, which now defers the supervisor until requested specialist work ends.

A direct follow-up correctly reached the specialist after restart, but the
supervisor unnecessarily reopened the earlier report. That is a semantic failure,
not a transport pass. Prompt composition now puts the current goal last and
explicitly excludes earlier completed assignments from the completion criteria.

The identical direct request then passed without corrective steering after another
restart (`42287844-e3c1-4978-99c9-d4a97805b33f`). Only the Data Quality Specialist
and Coordinator ran, in that order. The specialist confirmed no missing fields or
duplicates, and the supervisor completed without requesting more input or work.
The four-member roster remained intact. The supervisor still included the earlier
verified total in its short answer; semantic concision remains model-dependent.

Final checks: 30 focused tests passed across room service, supervised-team UI,
fixed-team UI, team drafting, and bundle installation. The final room/UI changes
were retested (23 tests), and `npm run check` and `git diff --check` passed.

Evidence is retained under
`output/playwright/live-agent-ui/agent/serve/rooms/runs/`, with referenced workflow,
task, and worker records in the same isolated serve store. Do not publish the
whole agent store; it contains credentials. Live smoke tests do not establish
statistical reliability across providers. Exact arithmetic remains model-generated
unless a deterministic capability is configured. Cost metadata can be unknown;
turn, message, token, and duration limits still apply.

## Plain-language proof — 2026-09-05

Submitted through the live team chat without naming or assigning any agents:

> Please review stock-review.csv, tell me what the stock is worth, and flag any
> problems with the data. Keep the final answer brief.

The first attempt (`0d02254c-2b3a-43e5-9fa7-871a3da1e868`) selected specialists
and found the duplicate item, but Calculator read its saved default inventory.csv.
Auditor corrected the total to 33. Repeating after changing the input exposed a
second failure: the supervisor repeated the old answer without fresh evidence
(`675960e7-3aff-4d0c-9d73-104780936f9d`). A further attempt
(`2db414c9-4e01-4875-be34-33bf841e5537`) refreshed the result to 47, but still had
specialists reading the default file. These are not clean passes.

Worker system and task prompts now share one identity description that labels
saved filenames as defaults before presenting the persona. Current inputs replace
those defaults without changing permissions or standing access restrictions.
New reviews require fresh evidence; earlier answers remain historical. Team
guidance also asks for short messages addressed directly to teammates.

The next attempt (`0c237411-ab9e-4a15-820a-8078a9d97a33`) selected Calculator,
Auditor, and Data Quality Specialist and returned 47 with the duplicate pens
finding. Calculator's retained transcript includes a real read of stock-review.csv.
No corrective user message or manual role assignment was supplied during the run.

28 focused tests passed (executor prompt contract, room service, supervised-team
UI, and fixed-team UI), and `npm run check` passed. Prompt assertions protect the
instruction contract; they do not establish statistical model reliability.

The final changed-data run (`4bfb8c4b-d880-4fbe-a8f8-a50af748f52a`) returned the
correct new total of 61, but Calculator again read inventory.csv. Auditor caught
the wrong-file calculation. Input selection remains inconsistent with these old
file-specific cards; prompt changes alone have not proved reliable behavior.

Following UI feedback, team conversations moved from room dialogs to the existing
main transcript and composer. Browser regression coverage includes team creation,
recruitment, main-panel rendering without a dialog, switching to Pi and back,
preserved drafts, supervisor selection, direct specialist addressing, blocking
questions answered through the composer, stopping after switching away and back,
membership editing, and retained messages after reload.

Final main-chat validation: all 28 focused tests and `npm run check` passed.
In the live browser, selecting Coordinator opened the retained team conversation
in the main panel. Sending “Which item was duplicated in the last review? Keep it
to one sentence.” through the normal composer produced the correct one-sentence
answer about pens in that same panel, without a conversation dialog.
