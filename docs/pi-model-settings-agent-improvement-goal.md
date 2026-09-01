# Model settings and agent improvement release goal

Status: release candidate validated; awaiting separate authorization to commit,
merge, restart, and perform the user live test. Accepted 2026-08-31.
Implementation branch: `codex/model-capability-accuracy`.

The detailed implementation history is retained in
[pi-model-capability-accuracy-goal.md](pi-model-capability-accuracy-goal.md). That
archive is evidence, not the current completion contract.

## Outcome

Ship a release candidate in which Pi exposes trustworthy native model settings
for explicitly reviewed provider/model/connection combinations and preserves
those settings through one complete, human-controlled agent improvement
lifecycle.

Catalog presence, configured credentials, connection type, reviewed option
support, account access, and live verification remain separate facts. Models
outside the reviewed set remain available, but Pi must not infer or advertise
native controls for them.

## Reviewed native-control boundary

The current offline inventory contains 1,291 bundled provider/model entries. It
reports 27 entries with source-reviewed, adapter-implemented native controls:

- OpenAI Responses API-key connections: three GPT-5.6 entries. Sol exposes mode,
  effort, and processing tier; Terra and Luna expose mode and effort.
- Google Generate Content API-key connections: three Gemini 2.5 budget entries
  and eight Gemini 3.x effort entries.
- Anthropic Messages public API-key connections: thirteen Claude entries with
  exact-ID mode, effort, budget, and/or Fast support as declared by their
  reviewed capability records.

These are control-support claims, not whole-model certification, account
entitlement, or paid live verification. OAuth, alternate endpoints, gateways,
and similarly named models do not inherit public API-key evidence. Explicit
private capability declarations remain authoritative within adapter-supported
syntax.

Reproduce the boundary without credentials or provider requests:

```sh
node scripts/audit-model-capabilities.mjs
node scripts/audit-model-capabilities.mjs --json
```

The JSON report must have zero structural errors. Its `nativeControls`,
`verification`, `accountAccess`, and `liveRequest` fields are the machine-readable
evidence boundary.

## Release requirements

1. **One capability owner.** ModelRuntime resolves catalog, connection, private
   override, and adapter evidence. Browser, CLI, Agent Builder, saved agents, and
   workers consume that result rather than maintaining provider policy.
2. **Independent controls.** Reasoning mode, effort, token budget, and processing
   speed remain distinct. Unsupported combinations fail before dispatch. No path
   automatically opts into premium processing.
3. **Connection-aware claims.** Public API-key evidence is exposed only for the
   reviewed connection and endpoint. Configured credentials do not imply account
   access. Final resolved headers and endpoint are revalidated before dispatch.
4. **Exact persistence.** Native values, provider defaults (`{}`), and explicit
   legacy replacement remain distinct through chat, CLI, Builder candidate save,
   reload, proof execution, acceptance, promotion, session storage, and worker
   startup.
5. **Human-controlled improvement.** A candidate cannot replace the active agent
   before a current-candidate proof succeeds against every required criterion and
   a human explicitly accepts it. Promotion applies exactly the accepted
   candidate revision. Rejection retains the active agent and evidence history.
6. **Honest execution and price display.** Requested, serialized, and
   provider-reported settings remain distinct. Estimated, unknown, and reported
   costs remain distinct. A reported downgrade is shown as reported, not inferred
   from the request.
7. **Recovery and privacy.** Invalid refreshes retain the last valid catalog.
   Explicit private overrides survive refresh and remain outside public protocol
   details, fixtures, and commits. No personal agent, credential, transcript,
   private catalog, or account detail enters the release changes.
8. **Verification.** Deterministic affected tests and full `npm run check` pass.
   Desktop and 390x844 mobile flows verify settings correction and persistence.
   One isolated browser lifecycle verifies package review, candidate edit, save,
   clean reload, proof, evidence review, human acceptance, promotion, and the
   pre-promotion active-agent invariant.

Paid provider requests require a separately approved cost limit. Offline SDK
tests with injected synthetic HTTP responses do not count as paid or live
verification.

## Current evidence

| Area | State | Evidence / remaining gate |
| --- | --- | --- |
| Runtime-owned schemas and validation | Done | Shared native controls, connection-aware resolution, final request validation, and protocol projection have deterministic coverage. |
| Reviewed adapter boundary | Done offline | 27 exact entries across OpenAI, Google, and Anthropic; inventory reports zero structural errors. Account access and live requests remain explicitly unverified. |
| Chat, CLI, storage, Builder, saved-agent, and worker persistence | Done offline | Native/default/legacy distinctions and rejected replacements are covered across the implemented paths. |
| Requested/sent/reported settings and cost status | Done offline | Synthetic adapter and browser evidence covers reported tier/speed changes and known-plus-unknown session totals. Billed provider cost remains unavailable and is not claimed. |
| Catalog recovery, source age, and private overrides | Done offline | Atomic composition, last-good retention, provenance, redaction, and stale-warning behavior are covered. |
| Desktop/mobile settings workflow | Done | Candidate save/reload and clean dirty-state behavior verified at 1280x720 and 390x844. |
| Complete isolated browser improvement lifecycle | Done | A credential-free synthetic fixture completed candidate edit, save, clean reload, proof, evidence review, explicit acceptance, skill creation, and promotion at desktop and 390x844 mobile sizes. Before promotion, revision 1 remained active with high effort/default processing while revision 2 was proven with low effort/Fast. After promotion, revision 2 was active and the candidate was cleared. |
| Final consolidated regression and release review | Done | `npm run check`, the offline audit, 47 affected test files (914 passed, one intentional Windows skip), lifecycle cleanup, and changed-file privacy review pass. Reviewed screenshots contain synthetic data and encoding metadata only. |
| Commit, merge, restart, and user live test | Awaiting later authorization | Prepare the candidate first. These actions are not implied by this goal. |

## Release-candidate validation

Validated on 2026-08-31 without credentials or provider requests:

- `npm run check` passed, including formatting, TypeScript, generated browser
  bundle consistency, pinned dependencies, lock artifacts, and browser smoke.
- The offline inventory reported 39 providers, 1,291 entries, 27 reviewed
  native-control entries, 112 entries with unknown pricing, and zero invalid
  entries. Native-control counts were 16 mode, 20 effort, 11 budget, and three
  processing-tier entries; controls may overlap on one model.
- Forty-seven directly affected test files passed 914 tests, with one existing
  POSIX-permissions case intentionally skipped on Windows. The coding-agent
  portion passed 295 tests across 24 files, with that one skip.
- Promotion now rechecks the accepted proof and exact candidate revision at the
  commit boundary. If that check fails after skill installation, the installed
  skill is removed and the active agent remains unchanged.
- Listener shutdown explicitly drains active HTTP/SSE connections. The final
  browser fixture stopped normally, removed its isolated agent/skill directory,
  released its port, closed its tab, and restored the viewport.
- `git diff --check` passed. The changed-file review found no personal agent,
  credential, transcript, private catalog, account detail, access URL, or
  temporary test identifier. Documentation screenshots were visually inspected
  and contain only synthetic demo data.

The repository-wide `test.sh` wrapper is not clean evidence on this Windows
checkout: WSL cannot load the checkout's Windows Rolldown binary, while Git Bash
mixes POSIX temporary paths with Windows subprocess paths and lacks symlink
permission. Direct Windows runs cover every affected test file and pass. This is
a host-wrapper limitation, not a hidden passing claim for the entire repository.

## Residual risks

- The remaining 1,264 bundled entries are available but do not receive reviewed
  native-control claims from this work.
- Account entitlement, provider-side option acceptance, and billed cost remain
  unverified because no paid live request was authorized.
- Provider catalogs and naming can change after the recorded evidence dates;
  stale provenance remains visible and requires a new source review.
- The final user test still requires the separately authorized commit, merge,
  restart, and live workflow. It must not be represented as already performed.

## Deferred, non-blocking work

- Exhaustive native-control review of every bundled model outside the 27-entry
  reviewed boundary.
- Unrelated broad UI redesign.
- Completion of the upstream newer-harness execution scaffold.
- Provider billed-cost data that the API does not return.
- Paid account-entitlement checks until a cost limit is approved.

Deferred work becomes blocking only if it violates a release requirement above.

## Completion evidence

Every release requirement now has current evidence. The isolated browser
lifecycle passed on desktop and mobile without modifying a personal agent, full
checks passed, the changed-file privacy review is clean, and this reviewed
release candidate plus residual-risk record is ready for the user's separate
commit/merge/restart/live-test decision.
