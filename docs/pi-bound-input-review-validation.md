# Bound input review validation

Validated September 5, 2026 through the visible Pi chat UI and isolated workers.
The standalone reviewer used OpenAI `gpt-5.6-luna`; the team used Anthropic
`claude-haiku-4-5`. Both used their existing saved settings with thinking off.

## Changes proved

The host binds the requested input before adding history, supplies verified
contents to every worker, denies other file reads, and requires matching read
receipts. An inventory recipe computes exact decimal totals and checks structured
inventory answers. Team output schemas are included in the assignment, with at
most one correction for a malformed bound team turn.

The latest team responsibilities were edited through **Manage team** to remove
fixed filenames and describe short handoffs. Conversations remain in the main
chat, selected from the left sidebar. No conversation popup is needed.

## Live results

| Case | Expected and observed | Retained run |
| --- | --- | --- |
| Single agent, current stock file | 3 rows, total 61 | `7988bd14-1aa8-48f1-b7da-4191cd96b36d` |
| Team, conflicting saved filenames | Total 61; duplicate pens; all 7 worker receipts match stock-review.csv | `8017547e-6f10-43d2-b599-ad8f3cbf3213` |
| Single agent, different filename and decimal prices | 3 rows, total 15.45 | `464eccd8-db52-4e6a-af85-97251cfcbbd8` |
| Team, different filename and decimal prices | Total 15.45; duplicate clips; all 8 worker receipts match warehouse-review.csv | `80872f29-3e2b-4fdf-b9bd-73f88ce36ad2` |
| Single agent, same question after file change | 3 rows, total 23.95; did not reuse 15.45 | `eba71aee-1fb8-46a5-836e-203741f599f0` |
| Team, changed file and simplified roles | Total 23.95; duplicate clips; all 5 worker receipts match the new file hash | `85cb2a86-37c7-4bea-8534-580c50e6c253` |
| Single agent, missing-review.csv | Visible missing-input error; draft retained; no worker started | Preflight rejection |
| Team, missing-review.csv | Visible missing-input error; draft retained; no worker started | Preflight rejection |

The final team used five worker turns across four rounds: Coordinator assigned
Calculator and Data Quality Specialist; Calculator reported to Auditor; Auditor
verified; Coordinator delivered the final answer. No self-assignment loops or
unrelated work occurred in that final test.

Independent expected arithmetic:

- Stock: `7 × 7 + 4 × 2 + 2 × 2 = 61`.
- Warehouse, first version: `3 × 4.25 + 7 × 0.30 + 2 × 0.30 = 15.45`.
- Warehouse, changed version: `5 × 4.25 + 7 × 0.30 + 2 × 0.30 = 23.95`.

These are fixture valuations, not inference charges. Currency comes from the
example agent configuration; the CSV itself does not establish a currency.

## Failures retained

The first bound single-agent run read the correct stock file but returned 65.
Run `4da1a785-9425-44ba-af6e-56a1ade75fb7` was incorrectly marked successful by
the earlier implementation. This prompted the deterministic inventory recipe
and output check; its record has not been rewritten to hide the failure.

The first decimal team run returned correct prose without its required turn
JSON. Run `8b375201-1a2b-4e6a-aac3-438b62f4d995` failed visibly. The schema prompt
and bounded correction were added afterward. Automated tests force both a
successful correction and a second invalid response that remains failed.

The passing 15.45 team run still contained redundant self-directed assignments.
The role descriptions were then simplified in the UI; the final 23.95 run had
the clean five-turn sequence above. This distinction matters: correct totals
alone do not establish a natural team interaction.

## Automated verification

84 focused tests passed across 10 files, including actual isolated fixture-worker
attempts to read the wrong file and return the observed wrong total. Coverage
also includes changed hashes, missing evidence, team inheritance, restart loading,
invalid inventory rows, decimal arithmetic, bounded format correction, and the
main-chat team UI. These automated tests use fixtures/faux inference rather than
paid model APIs. `npm run check` and `git diff --check` passed.

The implementation contract and acceptance plan are in
[pi-bound-input-review-spec.md](pi-bound-input-review-spec.md). A selected-fields
local evidence report is retained at
`output/playwright/live-agent-ui/bound-input-validation.json`; original run/task
records remain in the isolated test store. Do not export the whole store, which
also contains credentials.

## Conclusion and scope

The first inventory cases now pass for both a single agent and a supervisor-led
team, including changed filenames, changed contents, decimal prices, duplicates,
and missing inputs. This is bounded evidence for these cases, not proof of
general agent reliability. Input receipts prove which contents were supplied;
they do not prove arbitrary interpretation. The numeric output check covers the
specified structured inventory answer, not every claim in free-form team prose.
The inventory recipe deliberately rejects unsupported CSV dialects and numeric
formats. Other task types need their own explicit acceptance checks.
