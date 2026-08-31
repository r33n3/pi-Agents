# User data and repository privacy

Pi's source code belongs in this repository. A tester's agents, conversations,
accounts, schedules, reports, and projects do not. Publishing an agent in the Pi
console makes it available to that local runtime; it is not consent to commit,
push, export, or publicly share its package.

## Where to put private work

| Content | Location / policy |
| --- | --- |
| Agent packages, candidates, feedback, proof transcripts, memory, schedules, connections, vaults, and settings | Keep their existing Pi user-data location outside the checkout, or inside ignored `.pi/` directories. Nested project `.pi/` directories are also ignored. |
| Personal projects built while testing Pi | Use a sibling directory outside the checkout, or `.local/workspaces/<project>/` inside it. |
| Custom `PI_CODING_AGENT_DIR` | Point outside the checkout, or into `.local/pi-user/`. Arbitrary custom paths are not automatically protected by Git. |
| Screenshots, report HTML, recordings, exported packages, and validation logs | Put them under root `output/` or `.local/`. Do not copy live-session evidence into public docs or test fixtures. |
| Environment credentials | `.env` and `.env.*` are ignored at every depth. Only `.env.example`, `.env.sample`, and `.env.template` are eligible for sharing; use placeholders, never real values. |
| A reusable extension, prompt, skill, or theme | Private by default. Review it and its assets, replace personal examples, then add a narrow shared-source exception deliberately. |

The ignore rules do not move files, change where Pi stores data, delete agents,
or disable schedules. A project that already exists elsewhere in the checkout
needs its own local exclusion or an explicit move agreed with its owner. Git
cannot infer that an arbitrary source directory is a personal project.

For a workstation-only exclusion, add its exact repository-relative path to
`.git/info/exclude`, for example `/my-private-project/`. Do not put personal
project names in the shared `.gitignore`.

## Reuse the policy in another checkout

The [root `.gitignore`](../.gitignore) is the maintained, tested policy for this
repository. A minimal user-data block for another project is:

```gitignore
# Private Pi data, including nested projects and future stores
**/.pi/*
.pi_config/
.local/

# Local credentials; templates must contain placeholders only
.env
.env.*
!.env.example
!.env.sample
!.env.template

# Generated evidence and browser/attachment state
/output/
/playwright-report/
/test-results/
.playwright/
.playwright-cli/
.codex-remote-attachments/
```

Combine that block with the new project's language/build ignores. Do not copy
this repository's reviewed-source exceptions unless you intend to publish those
specific files. Avoid broad exceptions such as `!**/.pi/skills/**`: they can
expose a user's newly generated package or its bundled data.

For example, to share exactly one reviewed root-level extension:

```gitignore
!/.pi/extensions/
/.pi/extensions/*
!/.pi/extensions/shared-example.ts
```

This permits only that file; other extensions remain private. Reviewed directory
packages need equivalent narrow rules for each parent and intended source file.
Do not globally ignore `agents/`, `skills/`, `*.json`, or `*.md`: those names also
contain legitimate source, synthetic fixtures, and documentation.

## Before staging or publishing

Run from the repository root:

```sh
git status --short --untracked-files=all
git check-ignore -v --no-index .pi/agents/example.md
git ls-files --cached --ignored --exclude-standard
git diff --cached --stat
git diff --cached
```

`check-ignore` explains the matching rule; exit code 1 means no rule matched.
The `ls-files` command identifies already tracked files that now match an ignore
rule. Review that list; do not automatically delete it. Stage only explicit
reviewed paths. Do not force-add private files.

If a private file is already tracked, adding an ignore rule is insufficient.
After confirming its exact path with the owner, `git rm --cached -- path/to/file`
stops tracking it while retaining the local copy. Review and commit that index
change normally. Existing commits, PR diffs, forks, and previously shared exports
can still contain it. History removal is a separate coordinated operation; never
rewrite shared history as part of routine ignore maintenance. If a credential was
exposed, revoke or rotate it rather than relying on a later deletion.

Public case studies should preserve defects, acceptance criteria, and test
results while replacing names, locations, IDs, host paths, account labels, and
user prompts. Use synthetic fixtures and clean demo sessions for screenshots.
Review image contents and metadata, not just filenames. `.gitignore` is an
accidental-staging guard, not a secret scanner or export sanitizer, and does not
prevent an explicit upload, force-add, or a more specific ignore override.

Run `node --test scripts/gitignore.test.mjs` to verify private paths remain
ignored while reviewed source, public examples, and synthetic fixtures remain
available to Git. No live agents or credentials are used by that test.
