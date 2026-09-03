# Upstream review: 2026-09-03

The fork uses `r33n3/pi-Agents`; its upstream remote is
`earendil-works/pi`. The reviewed upstream head is
`1d9787c11` (2026-09-03), with shared base `853a80d26`.

## Integration decision

Import focused fixes first. Upstream has 436 commits beyond the shared base,
changing 657 files. A read-only merge preview against the fork's collaboration
commit `e80c14d2b` reports 32 conflicting paths, including modified files that
upstream deletes. No full upstream merge was applied.

The larger update replaces parts of the harness, session/client/server protocol,
and storage interfaces, and adds the Chord package. Those interfaces support the
fork's browser console, workers, model controls, and durable tasks. Accepting the
upstream versions wholesale would require a migration and regression review.

## Imported fixes

| Upstream commit | Change | Verification |
| --- | --- | --- |
| [6f35de5b5](https://github.com/earendil-works/pi/commit/6f35de5b598037c28e05f52e23a00301e1275819) | Give concurrent session shares separate temporary directories so one session cannot upload or remove another's export. | Offline concurrent-share regression with mocked uploads. |
| [c6b00676b](https://github.com/earendil-works/pi/commit/c6b00676b8fea5e8e2bddd618943c6e73a38c9b3) | Continue scanning JPEG metadata when an XMP segment precedes EXIF orientation. | Image conversion regression checks rotated output dimensions. |
| [e44d75c20](https://github.com/earendil-works/pi/commit/e44d75c20a51142abc056c243b13c1d7bb4be687) | Allow branch summaries up to 4096 output tokens, capped by the model's declared maximum. | Faux-provider tests cover the cap, smaller model limits, and incomplete-summary rejection. |

These source and regression-test patches apply without the runtime migration.
Upstream release/changelog entries were not copied into the fork's history.
Regression comments identify the originating upstream issues.

## Dependency security maintenance

GitHub reports three open alerts in the standalone
`packages/extensions/pi-claude-code-acp/package-lock.json`:

- `fast-uri` 3.1.5 to 3.1.6 addresses the reported hostname/SSRF issues.
  The [maintainer release notes](https://github.com/fastify/fast-uri/releases/tag/v3.1.6)
  recommend this update for the 3.x line.
- `qs` 6.15.3 to 6.16.0 addresses the reported array-limit bypass. Its
  [changelog](https://github.com/ljharb/qs/blob/v6.16.0/CHANGELOG.md)
  also describes an optional stringify depth limit and parsing/stringifying fixes.
  Existing callers retain the default depth setting; stricter array-limit
  enforcement is the intended security behavior.

Only these two resolved versions, URLs, and integrity hashes changed. Direct
dependency pins, root dependencies, and lifecycle-script metadata are unchanged.
Resolution used `--package-lock-only --ignore-scripts` with the normal two-day
release-age gate. A clean install in a temporary directory used
`npm ci --ignore-scripts`; its audit reported zero vulnerabilities in 105
packages. No user credentials or live Claude session were used.

## Validation and deferred work

- The three focused source suites pass: 16 tests.
- `npm run check` passes, including browser bundling, TypeScript, and lockfile
  consistency checks.
- The preceding collaboration/lifecycle changes passed 205 focused tests, then
  the protected Linux and Windows CI checks and CodeQL scans before PR #23 merged.
- GitHub's separate optional AI review could not run because the account lacks
  a Copilot license; it did not report a code finding. Repository protections
  were not changed.
- Protected-branch Linux and Windows CI remain mandatory before merging.

A later runtime migration should map the fork's protocol/model-control additions
onto upstream's new session services, retain durable task and approval semantics,
and exercise worker cancellation, restart recovery, browser reconnection, and
storage conformance before replacing the current interfaces. Independent fixes
such as forked-session compaction boundaries can be reviewed in another batch.
