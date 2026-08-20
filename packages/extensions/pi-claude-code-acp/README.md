# pi-claude-code-acp

Delegate tasks to your local [Claude Code](https://www.anthropic.com/claude-code) CLI from
[pi](https://pi.dev) via [ACP](https://agentclientprotocol.com) (Agent Client Protocol).

Adds a `claude_code` tool: pi hands a project directory and a task prompt to Claude Code, which
works the task with its own tools (read/write/edit/bash) using your existing `claude` CLI login —
no separate API key needed — and reports the result back into pi's context.

## Install

```
pi install npm:pi-claude-code-acp
```

## Notes

- **All of Claude Code's actions are auto-approved**, with no per-action confirmation. This is an
  unattended delegation tool, not a supervised one — only use it for tasks you're comfortable
  letting Claude Code carry out on its own.
- Delegated sessions default to `claude-sonnet-5` (no 1M context) at medium thinking
  (`MAX_THINKING_TOKENS=8192`). Callers can pass a `model` id for a specific delegation.
- One ACP session is kept alive per project directory and model in TUI/rpc mode, so follow-up
  `claude_code` calls with the same directory and model continue the same Claude Code conversation.
