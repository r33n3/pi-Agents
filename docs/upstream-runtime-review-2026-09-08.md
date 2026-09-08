# Donor runtime integration — September 8, 2026

Reviewed donor head: `6160683a4` from `earendil-works/pi`.
Integration base: `f6e587bee` from `r33n3/pi-Agents`.

## Integrated

| Donor commit | Problem and resulting behavior |
| --- | --- |
| `fcff255b` | Built-in read, write, edit, bash and PowerShell definitions prefer strict JSON schema sampling without requiring experimental mode. Provider compatibility and explicit tool opt-outs remain supported. The fork's server harness receives the same default. Execution schemas and grants are unchanged. |
| `1f78cea7` | Extensions can call `ctx.modelRegistry.stream()` and `streamSimple()` through the configured model runtime. Custom provider authentication resolves through that runtime instead of requiring a global provider registration. |
| `faa9863c` | Direct steering and follow-up messages now pass through extension input handlers before skill/template expansion, just as normal prompts do. Handlers may transform or consume input. RPC calls carry the correct input source. |
| `6160683a` | Concurrent queue tests await asynchronous input processing before checking queue state. |

These are adapted patches, not an upstream branch merge. The fork's team
orchestration, approval records, model controls and persisted storage remain
on their existing interfaces. No dependencies or generated model catalog are
changed.

## Remaining integration work

- GPT-6 catalog/cache changes and Copilot routing must be reconciled with our
  model controls and generated pricing metadata together, then payload-tested.
- Anthropic per-turn effort changes include SDK and provider changes; they need
  dependency review and message replay tests before integration.
- The optional vLLM priority setting remains a separate provider feature.
- The donor's session/storage and Chord remote runtime migration requires
  adapting our teams, worker protocol, memory and approvals as one migration.
- TUI navigation and clipboard changes are separate from the Pi Agents browser.

No claim of complete donor feature parity is made. This review complements
`upstream-review-2026-09-08.md` and records the additional runtime patches.

## Validation

- Strict defaults, unchanged schemas, extension opt-outs and actual file reading.
- Faux-provider extension streaming verifies returned text and resolved auth.
- Queue regression verifies transformation, handled input and RPC source;
  concurrency tests cover steering, follow-up and message order.
- Pi Agents Playwright flows exercise agent creation, proof review, activation,
  scheduled routine approval, team launch, delegation, retained drafts, reconnect
  and specialist failure display using isolated synthetic data.
- A team reconnect assertion initially timed out under concurrent local tests;
  the full three-view team test passed on the subsequent run. Protected CI is
  required before merging.
- `npm run check` and focused tests are required locally; the protected Linux
  isolated suite and Windows launcher job gate the merge.

Browser execution tests use faux responses and a fixture worker. They verify
product plumbing, not live provider quality, flight prices or Gmail delivery.
Private agents, credentials, reports and schedules are excluded from the commit.
