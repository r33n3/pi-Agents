# Building a subagent

This directory contains reusable agents for the `subagent` extension. An agent is a Markdown file with YAML frontmatter and a system prompt. The frontmatter controls how the agent is dispatched; the prompt defines how it works.

## 1. Define the job

Give the agent one clear responsibility. A good agent definition answers:

- What kind of task does it accept?
- What output must it return?
- What work is outside its scope?
- Which files or tools does it need?

Prefer a narrow role such as `scout`, `planner`, `reviewer`, or `worker`. Do not create a general-purpose agent when a specialized prompt and smaller tool set will make its behavior safer and easier to verify.

## 2. Add the definition

Create `agents/<name>.md` using lowercase kebab-case for the name:

```markdown
---
name: api-reviewer
description: Reviews API changes for compatibility, validation, and tests
tools: read,grep,find,ls,bash
model: anthropic/claude-haiku-4-5
---

You review API changes in the current project.

Before reporting:
1. Read the relevant files completely.
2. Check callers, tests, and documented behavior.
3. Report findings ordered by severity, with file paths and line references.
4. Distinguish confirmed defects from risks and open questions.
5. Do not edit files.
```

`description` is used when selecting an agent. `model` is optional; when omitted, the agent inherits the dispatching session's model and thinking level. Use the exact provider/model identifier from the model catalog when setting it explicitly.

## 3. Grant only required tools

The `tools` field is a hard restriction, not a suggestion. Start with the smallest useful set:

| Need | Typical tools |
| --- | --- |
| Read-only investigation | `read,grep,find,ls` |
| Run checks or inspect command output | Add `bash` |
| Modify files | Add `write,edit` |
| Delegate work | Add `agents_list,subagent` |

Do not grant write or shell access to research and review agents. Do not list memory tools manually; memory is configured separately for managed agents and is not part of this example's Markdown format.

## 4. Write an operational prompt

The system prompt should describe behavior, not repeat the agent's name. Include:

1. **Role** — what the agent owns.
2. **Process** — the order of investigation or implementation.
3. **Constraints** — what it must not change or assume.
4. **Output contract** — the format and evidence the caller receives.
5. **Failure behavior** — how it reports missing files, failed commands, or uncertainty.

Require evidence. For example, a reviewer should cite paths and lines, while a planner should identify affected files, dependencies, risks, and validation commands. A worker should summarize edits and checks rather than claiming success without running them.

Keep prompts deterministic and bounded. Avoid instructions such as “do everything necessary” unless the tools, file ownership, and acceptance criteria are explicit.

## 5. Choose scope deliberately

Agents can be loaded from two locations:

- `~/.pi/agent/agents/*.md` — user-level agents, loaded by default.
- `.pi/agents/*.md` — project-level agents, loaded only when the caller uses `agentScope: "project"` or `"both"`.

This example is installed by symlinking its `agents/*.md` files into the user agent directory. Project-local agents are repository-controlled prompts and should be enabled only for trusted repositories. If both scopes contain the same name, the project definition overrides the user definition.

## 6. Add the agent to a workflow only when needed

A definition is enough for single-agent dispatch. Add or update a prompt in `prompts/` when the agent is part of a repeatable workflow:

```markdown
---
description: Review an implementation and return actionable findings
---
Use the `reviewer` agent to inspect the implementation for: $@
```

Use:

- single dispatch for one bounded task;
- a chain when a later agent needs the earlier agent's result;
- parallel dispatch only for independent tasks with separate file ownership; and
- a coordinator for a multi-package effort with dependencies and acceptance criteria.

Set a lower concurrency limit when agents share a constrained local model or can touch the same resources.

## 7. Install and test locally

From the repository root, install the example's extension, agents, prompts, and any skills as described in `README.md`. Then verify discovery and behavior with small tasks:

```text
Use api-reviewer to inspect the API changes in packages/example.
/scout-and-plan add validation to the request parser
```

Check that:

- the agent appears with the expected name and description;
- unavailable tools are not requested;
- the agent respects its read/write boundary;
- failures are returned instead of hidden;
- chained agents receive the intended prior result; and
- parallel work does not overlap files or external state.

For code changes, run the repository's required checks after the agent finishes. An agent's report is evidence for validation, not a substitute for running the checks.

## 8. Safety rules

- Treat project-local agent prompts as executable instructions.
- Never put credentials, tokens, or private transcript data in prompts or task output.
- Keep delegation targets explicit; an agent does not gain authority merely because it has a coordinator persona.
- Do not claim a task is complete when a command failed, a required file was not read, or validation was skipped.
- Preserve partial results and report the failed step when a workflow stops.
- Keep file ownership explicit for parallel work.

## Checklist

Before adding an agent, confirm:

- [ ] The name is unique and lowercase kebab-case.
- [ ] The description states a specific responsibility.
- [ ] The model identifier is valid, or the model is intentionally inherited.
- [ ] The tool list is the minimum required set.
- [ ] The prompt defines process, constraints, and output evidence.
- [ ] Scope and trust requirements are understood.
- [ ] Workflow changes have explicit dependencies and file ownership.
- [ ] A small discovery task and the relevant repository checks pass.
