# pi-agent-builder

Create and update reusable local pi agents through chat while keeping their model,
tool restrictions, memory strategy, and persona configuration in one Markdown file.

## Install

```text
pi install ./packages/extensions/pi-agent-builder
```

The package adds:

- `configure_agent`, a model-facing tool for creating or updating agents under
  `~/.pi/agent/agents`.
- Confirmed recurring schedules. The default replaces an agent's existing
  schedule in place; an additional schedule must be explicitly requested.
- `/persona`, an interactive command for applying personas from
  [r33n3/Personas](https://github.com/r33n3/Personas).

Persona identifiers are normalized to lowercase and validated before they are used
as local paths or remote URL segments. For example, `Greybeard` resolves to
`greybeard`. Persona instructions and icons are cached under
`~/.pi/agent/personas`.

`configure_agent` never chooses a schedule time. The user must explicitly confirm
the cadence. Repeating the same schedule is idempotent, while changing it updates
the existing Windows scheduled task instead of creating a duplicate. Multi-agent
workflows and their run history remain managed through `pi --serve`.

The [building-agents skill](skills/building-agents/SKILL.md) distinguishes the
standalone tool from serve's durable draft lifecycle. To update an existing
installation, review and copy it to `~/.pi/agent/skills/building-agents/SKILL.md`,
then start a fresh session so old skill contents are not retained in the model
context. In serve mode, omitted workspaces preserve the existing draft/agent
directory or default to the current session directory for a new draft.
