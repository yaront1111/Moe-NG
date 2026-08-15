# task-996e5318 Foundation activation ledger bridge — QA APPROVED (2026-08-15)

First-pass approve, reopenCount 0. Deliverable landed across commit 843445d (6 owned files) plus
FOREIGN whole-tree commit 79dcf18 which swept `foundation-activation-transition.{ts,js}`.
Verified all 8 owned paths with `git rev-parse HEAD:<p>` == `git hash-object <p>` — gated bytes ARE
committed bytes, so the foreign sweep was harmless.

## Gates I re-ran (separate runs, redirected to files, never chained/piped)
| leg | exit |
|---|---|
| `pnpm --filter @moe/daemon typecheck` | 0 |
| `pnpm --filter @moe/daemon test` | 0 — 77 files / 1661 tests |
| `pnpm --filter @moe/runner test` | 0 — 60 / 2014 |
| `pnpm verify:foundation` | 0 — 32 / 661 |
| `pnpm verify:store` | 0 — 42 / 502 |
| `pnpm typecheck` (root) | 1 — FOREIGN |
| `pnpm test` (root) | 1 — FOREIGN |

## Foreign red, attributed (do this before crediting or blaming a repo-wide red)
- `packages/mcp/src/http/http-shutdown.test.ts` TS2307 "Cannot find module './http-shutdown.js'":
  http-shutdown.{ts,js,test.ts} are UNTRACKED right now, http-server.ts modified. A live peer
  mid-TDD. Absent at HEAD and at this task's base 6482e5f1. The worker's own 13:59 gate was green
  here — the peer's bytes landed after. `git ls-tree <base> <dir>` is the cheap proof.
- `tests/integration/control-room/control-room-transport.test.ts`: 8 ms drift in
  `seamObservation.reading.value` inside a whole-payload deepEqual. Owner 4932d9b (task-371c80bd),
  and `git merge-base --is-ancestor 4932d9b <task base>` says NOT an ancestor → it entered after the
  baseline. Grepped the test's imports: zero activation/coordination symbols. See
  `mem:qa-new-nondeterministic-field-breaks-whole-payload-equality`.

## My own drills (independent of the worker's four)
- Drop `|| lease.ownerSessionRef !== sessionId` in `readCurrentEffectSessionBinding` →
  both suites red on the RIGHT assertions ("expected 'BOUND' to be
  'ABSENT:FOUNDATION_BINDING_QUERY_MISMATCH'"; coordination wrong-session flipped to bound:true).
- `false &&` on the committed-grant equality guard (authority:188) → "refuses a grant that is not
  the DURABLE activation's grant" red. NOTE: it died as `TypeError: Cannot read properties of
  undefined (reading 'code')` inside the test's own `refusalOf` extractor, not as a code assertion.
  That is still a kill — the test asserts `toStrictEqual {code,kind,layer,leg}` — but read the
  helper before concluding the test only checks "threw".
- Restore via `cp` from /tmp backups + `sha256sum -c`, never `git checkout` (see
  `mem:git-checkout-restore-destroys-uncommitted-work`).

## Design notes worth reusing
- The positive arm is proven non-vacuous the right way: coordination test asserts the SAME query
  refuses at COORDINATION_TERMINAL_BINDING_INVALID/ADDRESS, then seeds a REAL `activateEffect` +
  `commitActivationLedgerRecord`, then asserts BOUND. Only delta = the durable activation.
- Write-time does NOT compare a PROCESS_OBSERVED registration's lockIdentity against the stored
  PREFLIGHT's; only the read-time fold (`bindsActivation`) does. NOT a defect: the runner derives
  both phases' lockIdentity from the same `request.claim` (claude-launcher-lifecycle.ts:105), so
  drift is unreachable from production, and the fold fails closed if it ever happens.
- Per-file lines 296/294/328/250 — all under the 400 hard cap. Plan text said "<=250"; that is a
  target, not the bar. `mem:moe-epic-rails-override-qa-loc-bar`.
