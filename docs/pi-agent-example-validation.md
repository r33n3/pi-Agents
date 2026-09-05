# Live agent example validation

Validated on 2026-09-04 (America/Chicago), using the current working tree.

## Result

Ten live worker runs completed across OpenAI, Anthropic, and local Ollama.
Eight met their output checks. Two Anthropic model-only arithmetic attempts
failed acceptance checks despite completing successfully. Moving the arithmetic
into a deterministic host capability produced the correct result on Anthropic.
Those failures remain in the evidence; they were not counted as passes.

| Example | Inference | Checked behavior | Result |
| --- | --- | --- | --- |
| Backend probes | OpenAI `gpt-5.6-luna`, Anthropic `claude-haiku-4-5`, Ollama `gemma3:4b` | Real isolated worker returned the exact requested marker | 3 passes |
| Inventory reviewer | OpenAI `gpt-5.6-luna` | Read the actual CSV; returned valid JSON with total 22; proof checks and activation passed | Pass |
| Report writer | OpenAI `gpt-5.6-luna` | Read CSV and wrote `report.json`; parsed artifact exactly matched the expected object; proof and activation passed | Pass |
| Provider comparison, initial | Anthropic Haiku 4.5, reasoning disabled | Read correctly and calculated 26, but added prose and Markdown around JSON | Failed output format |
| Provider comparison, stricter prompt | Anthropic Haiku 4.5, reasoning disabled | Returned valid JSON, but total was 18 instead of 26 despite correct source evidence | Failed arithmetic |
| Scheduled inventory check | OpenAI `gpt-5.6-luna` | Reloaded persisted state; due-time dispatch used active revision 1 while candidate revision 2 stayed unaccepted; two identical ticks produced one task; changed input produced total 26 | Pass |
| Local inventory reviewer | Ollama `qwen3.5:9b` | Called the real read tool and returned valid JSON with total 26 | Pass |
| Deterministic calculator agent | Anthropic Haiku 4.5 | Called a granted, test-local host capability once; copied its exact calculated JSON with total 26 | Pass |

## Input and acceptance checks

The initial fixture was:

```csv
item,quantity,unit_price
notebooks,3,4
pens,5,2
```

The expected report was `{"total":22,"currency":"USD","items":2}`.
For the later runs, notebooks changed to quantity 4, making the expected total
26. The changed-data prompts did not supply the expected answer.

Checks used a strict JSON parser and exact object comparison, successful tool
receipts, actual output-file reads, retained execution configuration, and active
revision/task/routine assertions. Checking only for a nonempty assistant response
would have missed both failed provider-comparison attempts.

The deterministic example granted `validation.inventory-total` version 1 to a
separate disposable agent. Its host tool read only the assigned `inventory.csv`,
validated the fixture's columns and numbers, summed integer cents, and returned
the report object. The capability call retained an authorization decision and
outcome. This was a test-local adapter, not a newly installed built-in product
capability or a general CSV parser.

## Execution and cleanup

- Used the real `ChildProcessAgentExecutor`, worker, SDK, provider adapters,
  scoped tools, registry, lifecycle, task service, and routine scheduler. No faux
  inference or mocked worker results were used in these runs.
- Created fixtures and service stores in a disposable temporary directory.
  The scheduler test reloaded the earlier run's persisted state in a new process.
- Used a due-time tick directly; no operating-system scheduled task or persistent
  timer was installed. Disabled the disposable routine and disposed all workers
  before cleanup.
- Preserved eight successful host-action decision/outcome pairs. Existing
  personal agents, schedules, provider configuration, and credentials were not
  edited.
- Preserved reports, worker transcripts, configuration snapshots, audit records,
  and task evidence under
  `.artifacts/agent-validation/2026-09-04-533831d7/`.

## What this establishes

The tested agents can perform real file work, produce artifacts, activate after
review, run through scheduling, retain active/candidate separation, and use
different inference providers. The live tests complement the earlier Chromium
conversation test. A subsequent live UI pass is recorded below.

The failures support the deterministic-host design: use bounded code for
arithmetic and other exact operations, and validate outputs against the task's
contract. A successful worker exit or provider connection does not establish
correctness. Prompt tightening alone did not qualify the tested Haiku
configuration for model-only arithmetic.

These are representative smoke tests, not a statistical reliability claim for
all models or workflows. Grok/xAI and the standalone Codex, Claude CLI, and Hermes
connections were not exercised live in this pass. API pricing fields marked
unknown are not evidence of free usage.

## Live browser UI follow-up

Operated the visible Pi web console with real OpenAI `gpt-5.6-luna` inference.
Created `ui-inventory-reviewer` through the conversational builder, clicked
Try candidate, ran and reviewed its proof, accepted the correct JSON result,
activated revision 1, and submitted three tasks through its agent chat.
The proof and all three chat runs returned
`{"rowCount":2,"totalValue":26,"currency":"USD"}` against the updated CSV.

The first activation exposed a real defect: the tool returned its proposal ID
only in UI details, so the model omitted it after a plain "yes" and prepared a
replacement proposal. Explicit-ID approval recovered the run. The fix places
the ID in model-visible proposal and inspection text, and rejects confirmation
without an ID before it can replace the pending proposal. Nine targeted tool
tests and `npm run check` passed.

During navigation, clicking a stale Exit editing control after selecting the
agent left an empty chat view. Reopening the agent showed both retained replies;
a third task then appeared and completed automatically. No task result was lost.
A guard now ignores builder exit events once the user has selected another
view. The browser regression scenario also exercises this delayed event and
checks that the next inbox reply becomes visible.

After restarting with the approval fix, created `ui-checklist-agent` through the
same live builder. Its proof returned three relevant steps for organizing a
project folder. Accepted the proof and activated it with a single plain "yes";
the model supplied the exact proposal ID without manual assistance. A different
task in normal agent chat returned three relevant steps for reviewing a code
change. Both examples remained available after a further server restart.

Final verification: nine lifecycle-tool tests passed, the expanded Chromium
lifecycle/navigation/inbox regression passed, and `npm run check` passed. The
browser regression uses faux inference; the two examples above used live
inference and were operated in the visible UI.

Fixtures, retained conversations, task records, and proof results are in the
isolated `output/playwright/live-agent-ui/` workspace. The local server uses its
own agent store. No routines or external messages were created.
