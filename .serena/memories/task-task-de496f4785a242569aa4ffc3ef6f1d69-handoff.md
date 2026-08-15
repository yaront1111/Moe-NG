# QA APPROVED — runtime-to-activation binding (2026-08-14, reopen#2)

`task-de496f4785a242569aa4ffc3ef6f1d69` -> DONE. Approved by `qa-50f0d628` at HEAD `2f4281f`.

## Why the reopen#2 defect was gone without a worker write
QA reject #2 said "commit the fixture". Between the reject and the retry, foreign whole-tree
commit `671409f` (task-1615065497) swept the restored working tree in — the same mechanism that
reverted it (`71ae334`) re-landed it. `git status --porcelain -- packages/runner/src` was EMPTY,
so the declared gate ran on committed bytes. Worker correctly wrote zero bytes and did NOT amend,
revert, or mint a claiming commit. See `gotcha-foreign-whole-tree-commit-can-also-reland-your-revert`.

## Evidence I recorded
- `pnpm --filter @moe/runner typecheck` exit 0; `pnpm --filter @moe/runner test` exit 0,
  **58 files / 1841 tests**.
- Repo-wide `pnpm typecheck` / `pnpm test` exit 1, 100% foreign and disclosed:
  `apps/daemon/src/http/event-stream.ts(66,3) TS2739` (WireEvent missing identity/ledgerObservation/
  seamObservation) and `tests/runtime/package-loadability.test.ts` ERR_MODULE_NOT_FOUND
  `event-stream-observation.js`. Both trace to UNTRACKED/dirty `apps/daemon/src/http/*` — live peer
  TDD. Owned intersection EMPTY.

## Shape at HEAD (do not re-derive)
- Single source: `effect-grant.ts:167 refuseRuntimeObservationDrift`, `:185 validateRuntimeBinding`.
  `effect-activation.ts:216` delegates. No launcher-local copy.
- `claude-launcher.ts:174-181` guard, operand `runtime.value.quotedObservationDigest` (NEVER
  `freshObservationDigest`), in try/catch, strictly between `validateCommit` (:164) and
  `consumeGrant` (:183). Distinct `PHASE.binding` at `:66`.
- Fixture builds QUOTE + both commits at MODULE scope (documented deviation from the plan's
  `beforeAll`: module-scope consumers reading `COMMIT.grant` would see `undefined`). `COMMIT` is the
  matched one (QUOTED_DIGEST), `DRIFTED_COMMIT` is plain `makeActivationRequest()`.
- Lines: claude-launcher 215, effect-grant 195, effect-activation 257 (pre-existing, unchanged),
  fixture 265 (test file, not a production source). Pre-existing >250 in providers/claude and NOT
  this task's: capabilities 289, observation 300, render 372, runtime-pin 301,
  runtime-pin-closure 281, stream-anomalies 265.

## Drills I ran (production had changed since QA #2, so I did not trust "already verified")
| drill | mutation | result |
|---|---|---|
| D1 | helper never refuses (`if (true) return null`) | 15 failures across BOTH suites — single source proven |
| D2 | neuter ONLY `if (bound.kind === "REFUSED")` in launcher | 4 launcher failures, supervisor GREEN |
| D4 | move guard block below the grant phase | ordering assertion reds: `['runtime','validate','consume'] != ['runtime','validate']` |
| D5 | `COMMIT` back to plain `makeActivationRequest()` | 27 failures |

Restore by `cp` backup + `sha256sum -c` (never `git checkout`). All 3/3 OK each round.

## Two traps I hit while drilling
1. **Flipping `===` to `!==` in `refuseRuntimeObservationDrift` is the WRONG D1.** It makes the
   helper refuse on EQUAL, so the matched fixture throws at module load and you get
   `Test Files 2 failed / Tests no tests` — a load error, not an outcome redden. The correct dead-guard
   mutation is unconditional `return null`.
2. **My first D5 perl regex matched nothing** because the real call has a second arg `, "matched")`.
   `D5_EXIT=0` read as a passing guard. Always echo the mutated lines back before believing a green
   drill. See `mutation-drill-that-applied-nothing-reads-as-green`.
