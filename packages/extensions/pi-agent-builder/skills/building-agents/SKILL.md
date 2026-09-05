---
name: building-agents
description: Build or edit local pi agents (like researcher, reviewer) through conversation — name, description, model, tools, persona, memory strategy, and recurring schedules. Use whenever the user asks to create a new agent, adjust an existing one's config, give it a persona/personality, add memory, or schedule it.
---

# Building agents

## Choose the active tool contract

Read the available tool descriptions first. When `configure_agent` describes a
durable draft, or `manage_agent_build` is available, use the serve workflow below.
The standalone Markdown-agent instructions later in this file do not apply in
serve mode. Do not mix the two catalogs, memory strategies, or scheduling paths.

## Serve: durable Agent Builder drafts

- Use `inspect_agent_build` to review drafts and proof status. `agents_list`
  belongs to the standalone catalog; an empty result does not mean no serve
  drafts or published agents exist.
- Stage a useful draft promptly with `configure_agent`. Only `name` is required
  when the session has a working directory. `projectRoot` preserves the existing
  draft/agent workspace when omitted; for a new draft it defaults to the current
  session directory. Specify it when the user needs another workspace. Report
  that workspace with the draft; do not infer permission to run or modify files.
- Use `description` for the outcome and `systemPrompt` for the workflow. Keep
  tool arguments concise; do not repeat the full workflow in descriptions,
  assumptions, and clarifications. Subsequent calls can contain only changes.
- Default to read-only access, no persistent memory, no browser access, and the
  inherited model unless the task calls for something else. Use only available
  tool names and canonical provider/model IDs. `memory` supports `none` or
  `notes`; do not send `mempalace`. `persona` is instruction text in this tool,
  not a standalone persona-catalog lookup.
- Retain material assumptions and unresolved questions with `assumptions` and
  `clarifications`. Ask at most one concise question that changes outcome,
  workspace scope, recipient, authority, data, cost, schedule, or acceptance.
  Do not delay a reversible draft for cosmetic choices.
- A draft is not a deployed agent. Test the unpublished candidate, review the
  retained evidence, and accept or reject the proof before activation.
  Skill export is optional and never activates a candidate.
  A failed model response or partial tool call is not a saved draft;
  inspect the build before trying again.
- For lifecycle actions, first call `manage_agent_build` without `proposalId`
  and with `confirmed: false`. Show its exact proposal. Only after the user
  approves that proposal, repeat the same action with its `proposalId`,
  and `confirmed: true`. The host checks the actual user message; a supplied
  `confirmationText` is not authority. With several pending proposals, ask for
  `approve <proposal-id>` rather than a bare yes. Do not
  treat the original request as approval of a proposal it has not seen.
- `scheduleTask`, `scheduleCadence`, and `scheduleConfirmed` retain a confirmed
  schedule as intent only. They do not create Windows tasks. Automation requires
  an accepted active revision and approval of the exact scheduling action.
  Candidate edits preserve existing active routines until explicit activation.
  Never invent a cadence or bypass this lifecycle by calling a shell scheduler.

When the serve contract is active, stop here. The remaining sections describe
only the standalone extension.

## Standalone: Markdown agents

Local agents live as `.md` files under `~/.pi/agent/agents/*.md` (frontmatter +
system-prompt body). `agents_list` shows the current catalog. Everything below is
applied with a single tool, `configure_agent` — one call per round of changes, safe
to call repeatedly as the conversation refines the config. Only `name` is required;
omitted fields are left as-is on an existing agent.

Ask concise questions one at a time rather than presenting a giant form, unless the
user has already given you everything in one message.

## What `configure_agent` sets

- `name` — lowercase-kebab-case identifier, required.
- `description` — one-line summary.
- `model` — e.g. `ollama/qwen3.8:latest`, `anthropic/claude-haiku-4-5`, `openai/gpt-5.6-luna`.
- `tools` — comma-separated pi tool names this agent may use when run standalone
  (via `subagent`) — this becomes a hard restriction on the spawned process, not a
  suggestion. Common picks: `read,grep,find` (read-only research), add `write,edit,bash`
  for anything that changes files. **Don't hand-manage the memory tool names here** —
  see Memory below, `configure_agent` reconciles those automatically from the `memory`
  field.
- `systemPrompt` — replaces the agent's own instructions (the part above any applied
  persona block). Omit to leave existing instructions alone.
- `scheduleTask` + `scheduleCadence` — both together register a recurring unattended
  run via Windows Task Scheduler. Cadence syntax: `"daily HH:MM"`, `"weekly <Mon..Sun>
  HH:MM"`, `"hourly"`, `"every Nm"` / `"every Nh"`.
- `scheduleConfirmed` — set to `true` only after the user explicitly selects or
  confirms the cadence. Never invent a time from words such as "morning".
- `scheduleMode` — omit or use `"replace"` for the normal one-schedule-per-agent
  behavior. Use `"additional"` only when the user explicitly asks for multiple
  schedules.

## Persona

Pass `persona: "<name>"` to apply a personality from the r33n3/Personas catalog
(fetched from GitHub and cached locally on first use — no manual setup needed).
It's baked into the agent's system prompt as a marked block; re-applying (same call,
different persona name) replaces it rather than stacking. A few names to suggest if
the user has no preference: `burned-out-sysadmin` (terse, evidence-first, ops),
`database-curmudgeon` (skeptical of new persistence tech), `forum-moderator` (firm,
orderly), `british-butler`, `corporate-survivor`. If they want to browse more, fetch
`https://api.github.com/repos/r33n3/Personas/contents/personas` for the full list.

## Memory strategy

Pass `memory: "none" | "notes" | "mempalace"`.

- **`none`** (default) — no persistent memory beyond the current session's own
  transcript.
- **`notes`** — grants the agent `remember`/`recall` tools: plain markdown notes under
  `~/.pi/agent/memory/<agent>/`, found later by substring match. Zero setup, zero
  dependencies, but only finds a note if recalled with roughly the words it was
  written with.
- **`mempalace`** — grants `mempalace_remember`/`mempalace_recall`: the same note
  files, but also indexed into a real local semantic-search engine (MemPalace,
  ChromaDB-backed; requires a separately installed MemPalace runtime). Finds
  notes by meaning, not exact wording — pick this when the agent needs to recall
  something it can't quote verbatim. Costs a little latency per call (local embedding),
  no API key or cloud involved.

`configure_agent` automatically keeps the agent's `tools` list in sync with whichever
memory strategy is set (adds the right tool pair, removes the other pair) — you don't
need to list `remember`/`recall`/`mempalace_remember`/`mempalace_recall` in `tools`
yourself.

## Typical flow

1. Ask what the agent is for, if not already clear.
2. Pick a name and a model (default to a local `ollama/*` model unless the task
   clearly needs a stronger one).
3. Ask whether it needs write/bash access or should stay read-only.
4. Ask if it wants a persona, and whether it needs memory across runs.
5. Call `configure_agent` with everything decided so far.
6. Only if the user wants it to run unattended: ask what it should do each run and
   the exact cadence. Do not infer a clock time from "morning" or treat a question
   about an existing schedule as an update request. After the user confirms, include
   `scheduleTask`, `scheduleCadence`, and `scheduleConfirmed: true` in the same or a
   follow-up `configure_agent` call. The default replaces the existing schedule in
   place and removes stale duplicates.
7. Confirm what was created/changed in plain language — don't just echo the tool's
   raw return text.
