# Donor integration review — September 8, 2026

Origin: `r33n3/pi-Agents`. Donor: `earendil-works/pi`, fetched head
`6160683a4`. Origin main was `d576d2924` before this integration.

## Scope and decision

The donor has 489 commits beyond the shared ancestor, including 53 commits
since the September 3 review. This is a selective integration, not a full
upstream merge or an upgrade to the donor's release version.

A read-only merge preview reports conflicts across the session reducer,
JSONL storage, client/server protocol, provider types, dependency manifests,
and distribution scripts. The donor replaces interfaces used by the fork's
durable teams, approvals, workers, and browser console. Importing that migration
without adapting these consumers would not preserve the working product.

## Reviewed and imported patches

| Donor commit | Behavior | Validation |
| --- | --- | --- |
| `b2602be77` | Use amortized constant-time FIFO queues for streaming events and waiting consumers instead of repeatedly shifting arrays. | Donor tests exercise ordered buffering, interleaved consumption, completion, and waiting consumers. |
| `96617628e` | Send reasoning effort for reasoning-capable Mistral Medium aliases; retain thinking-off and non-reasoning behavior. | Donor payload tests use local failure endpoints and synthetic models. |
| `6aedd1066` | Download static musl fd/ripgrep binaries on Linux, including ARM64. | Reviewed asset-name changes; existing tool-management regression. Windows/macOS selection remains intact. Linux download execution requires CI or a Linux host. |

Source and test patches are imported without overwriting fork release history
or generated model metadata. There are no dependency or lockfile updates.

## Deferred groups

- Session/fork streaming, Chord protocol, storage, and remote runtime changes:
  require a coordinated migration of fork consumers and stored-state tests.
- Native clipboard, fullscreen TUI navigation, spinners, and search changes:
  require review with their intervening TUI changes; they do not repair the
  browser team's interface.
- Model-catalog refreshes and provider-routing changes: require reconciliation
  with the fork's generated catalog and model-control behavior.
- Runtime dependency updates: require release-note, lifecycle, and distribution
  review; no lockfile is replaced as a shortcut.
- Documentation eval infrastructure and release metadata: not required for
  this product integration.

The remaining donor commits have been triaged by scope, not certified as a
fully reviewed and tested migration. The September 3 integration remains
documented separately.

## Private data

Personal agent registries, vaults, schedules, reports, and local evidence remain
outside the commit. Workstation-only exclusions also cover live-run notes with
personal task identifiers and accidental Windows runtime caches. Public docs
use generic examples. Product source, synthetic tests, and reusable setup
documentation are included.

## Validation

- `npm run check` passes, including generated browser, types, dependency pins,
  install-lock consistency, and browser smoke checks.
- Focused AI regressions pass (27 tests), and protocol validation passes
  (56 tests). Team browser and bundle fixtures were updated to exercise the
  new editor sections and required conversation context version.
- The full isolated `./test.sh` run was attempted on Windows and fails;
  observed failures include symlink privileges, POSIX path assumptions, and
  shell quoting of the Node executable. This is not recorded as a passing
  full suite. Protected Linux CI and the Windows launcher check gate merging.
