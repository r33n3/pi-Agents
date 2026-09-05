# Bound input review contract

## Goal

A user selects one agent or a team in the sidebar and names a file in the main
chat. Every worker uses that request's input. Saved cards and older messages
cannot select a different file. Success requires host evidence for the bound
input, not a worker's claim that it read something.

## Design

The task service binds explicit read-only text-file review requests before adding
conversation history. Team rooms bind the raw user goal once and pass the same
workspace, canonical relative paths, and SHA-256 hashes through workflows,
task contracts, retries, and worker attempts. A new request binds fresh contents.

The isolated executor reads each input through the governed filesystem gateway
and supplies its contents to the worker. This removes file selection from the
model's work. Additional reads must match the binding; list/write actions are
denied for these reviews. Existing read grants and workspace boundaries still
apply. A changed file fails on the next read instead of silently changing the
assignment. Each worker uses the snapshot read for that attempt; this is not a
filesystem lock or a guarantee that the file remains unchanged after that read.

Only the parent executor supplies read evidence to the run manager. Missing or
mismatched evidence fails completion. Worker artifacts cannot forge that evidence.
Bindings and receipts persist with the run, so they can be inspected after restart.

Workflow prompts include their declared output schema. Bound team turns get at
most one correction attempt when execution succeeded but the output format failed
validation. The correction preserves the execution configuration, input binding,
and assigned goal. Both tasks remain in the workflow/room record; usage includes
both attempts. Cancellation and the room deadline still apply. A second invalid
response fails the turn. This correction does not replay unbound workflows or
retry failed tools, missing inputs, or model transport errors.

This replaces repeated prompt corrections with a shared execution rule. It does
not make every task deterministic. Model interpretation, role selection, and prose
remain probabilistic.

## Initial deterministic recipe

Live validation found a second failure: the single agent read the correct CSV but
reported 65 for 49 + 8 + 4. The isolated executor now supplies host-computed facts
for the initial inventory schema `item,quantity,unit_price`. It uses integer cents,
counts rows, computes line values and total, and flags repeated item names.
Structured JSON answers containing `rowCount` or `totalValue` are checked against
those facts before completion. Incorrect numbers fail; they are not silently replaced.

The first recipe accepts unquoted single-line item names, nonnegative integer
quantities, and nonnegative prices with at most two decimal places. Unsupported
or malformed rows fail explicitly. It does not infer currency from a CSV, validate
arbitrary prose, repair data, or implement general CSV dialects. Future recipes
should have explicit schemas and independent acceptance checks rather than broad
model-written validators. A passing team prose example is empirical evidence,
not a mathematical guarantee about every future team answer.

## Boundaries

- Automatic binding recognizes explicit CSV/TSV/TXT/JSON/MD review requests,
  with up to eight inputs and one MiB per input. Quote paths containing spaces.
- Mixed edit/write requests and historical follow-ups are outside automatic binding.
  Ambiguous multiple-file negation requests fail rather than guessing a selection.
- Bound reviews require the isolated harness, file-read permission, and no external
  capability tools or browser access. This prevents alternate input channels.
- Missing files fail before inference. The UI must show that error and preserve
  the draft; no fallback to a saved filename or prior total is allowed.
- Reusable role cards should describe expertise and constraints. The input belongs
  to the task. Conflicting old cards are retained during regression validation.

## Acceptance plan

1. Test binding, path boundaries, missing files, changed hashes, and restart parsing.
2. Use an actual isolated fixture worker to attempt the wrong read; inspect which
   host reads occurred and the receipts returned.
3. Test team inheritance and the completion gate with valid and missing evidence.
4. Test deterministic decimal arithmetic, the observed wrong answer, duplicates,
   invalid data, and unsupported formats.
5. Run single-agent and team requests in the UI, change filename and contents,
   and check real run records against independently calculated expected answers.
6. Retain failures in the validation report. Do not generalize these first cases
   into a guarantee across all inference providers or arbitrary agent tasks.
