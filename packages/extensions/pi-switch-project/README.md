# pi-switch-project

Adds `/cd <path>` to [pi](https://pi.dev): switch to a different project directory, resuming the
current conversation there.

pi has no live in-place directory switch — one running pi process is bound to the directory it was
launched in for its whole lifetime. This command automates the real workaround instead: it
relaunches pi in the target directory with `--session <id>`, which resumes the same conversation
there (falling back to a fresh session if nothing has been persisted yet).

## Install

```
pi install npm:pi-switch-project
```

## Usage

```
/cd C:\path\to\other\project
```

## Notes

- On Windows this opens the resumed session in a **new console window** (not an in-place
  transform) — `detached`+inherited stdio doesn't hand off a console on Windows the way it does on
  POSIX, so a new window via `cmd /c start` is the reliable approach.
- If the current session hasn't persisted anything yet (e.g. `/cd` as your very first action),
  `/cd` opens a fresh session in the new directory instead of trying to resume.
