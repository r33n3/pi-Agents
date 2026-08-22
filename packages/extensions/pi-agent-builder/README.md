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
- `/persona`, an interactive command for applying personas from
  [r33n3/Personas](https://github.com/r33n3/Personas).

Persona identifiers are normalized to lowercase and validated before they are used
as local paths or remote URL segments. For example, `Greybeard` resolves to
`greybeard`. Persona instructions and icons are cached under
`~/.pi/agent/personas`.

Recurring routines and multi-agent workflows are configured through `pi --serve`,
which owns their persistent schedules and run history.
