# task-58029c26 — Independent review flow (@moe/review) — QA verdict: APPROVED

QA `qa-cbad3a29`, 2026-08-09. Commits `15b5cf9` + `a0a883b` (worker), plus the
harness `.moe` state commit `38856c6`.

## Gate re-run by QA, not trusted from the note

`pnpm --filter @moe/review typecheck && pnpm --filter @moe/review test` exits 0:
`Test Files 2 passed (2) / Tests 90 passed (90)` — counts non-zero, so the filter
did not miss. Root `pnpm typecheck` exits 0 and includes `packages/review`.

## DoD mapping

1. Author / prior mutating lease holder never independent; unresolvable capacity
   yields `UNKNOWN_REVIEWER_INDEPENDENCE` on a 3-valued lattice, and `UNKNOWN`
   produces no acceptance qualification. Read-only lease and a mutating lease over
   a *different* subject both stay INDEPENDENT (positive arm present — the rule
   cannot pass by refusing everyone).
2. Allow-list by construction (`ALLOWED_KINDS`); the four forbidden kinds refuse
   with `PACKAGE_ITEM_KIND_FORBIDDEN` at the `PACKAGE` layer. Six bound fields
   asserted by set equality twice: against a hand-transcribed DoD list AND against
   the production `REVIEW_PACKAGE_BOUND_FIELDS`. Sweep count asserted non-zero.
3. `PROOF_FAILED` and `PROOF_UNKNOWN` are separate refusals; repeats key on typed
   subject+rule and route `REJECT_PLAN`; escalation tested AT 2 / 3 / 4 rounds and
   a clean round after the cap still `ESCALATE`s.
4. Verified above.

## Per-file cap (wc -l, not Measure-Object)

contract 247, findings 220, eligibility 160, package 144, canonical 71, index 70.
All under the 250 target. Test file 651 — cap is PER PRODUCTION FILE, so not a bar.
`mem:moe-epic-rails-override-qa-loc-bar`.

## Independent mutation drill — 12 mutants, 12 killed, 0 survivors

QA ran its own drill (did not rely on the worker's 23). Every mutant neutralised an
operand with a constant; every file restored and verified by `git hash-object`
against an out-of-tree backup.

| mutant | killed by |
|---|---|
| allow-list -> accept-all | unknown-kind test (1) |
| deny-list never fires | 4 forbidden-kind tests |
| fingerprint keyed on `detail` | 4 repeat-detection tests |
| repeat detection never fires | REJECT_PLAN test |
| authorship always "known" | 2 UNKNOWN tests |
| every lease disqualifies | read-only-stays-independent test |
| escalation limit 3 -> 4 | 4 boundary tests |
| lineage attestation off | 3 digest-mismatch tests |
| package digest drops `bound` | all 6 per-field sweep cases |
| `PROOF_UNKNOWN` -> `PROOF_FAILED` | the distinct-facts test |
| policy codes not carried verbatim | the verbatim test |
| singleton ambiguity ignored | 3 duplicate-binding tests |

## Rail checks

`Date.now` / `Math.random` / `new Date(` : zero hits. No `.js` bridge files. No NUL
bytes left in any source (the `a0a883b` fix holds — `git diff 15b5cf9^ HEAD` renders
`review-package.ts` as 144 text insertions, not `Bin`). `pnpm-lock.yaml` gained
exactly one importer stanza (`packages/review` -> `@moe/core`). Worker commits carry
only owned paths; no debug/probe/scratch file.

## Non-blocking observations (NOT rejection reasons, recorded for the next toucher)

- `ACCEPTANCE_APPROVAL_NOT_CURRENT` is declared in `REVIEW_REASON_CODES` but no code
  path emits it. Dead vocabulary, harmless; approval currency is @moe/core's.
- `recordReviewRound`'s append-only guard keys on `lastRound(records)`, so a CLEAN
  round number can be replayed. Nothing is appended and no counter moves, so it is
  inert — but a later change that makes clean rounds record state would open a hole.

## Pre-existing red, foreign to this task

Root `pnpm test` is red at 1/2814: `tests/fault/foundation/j4-replan-stale.test.ts`,
`probe:scheduler-authority-lease` declared `PRODUCTION_BEHAVIOR_ABSENT` but observed
`PASS_EXPECTED`. Confirmed by QA: `git merge-base --is-ancestor 239aa4f 15b5cf9^`
succeeds, so the cause (task-8ee125d0 re-exporting `fenceAuthority`) predates every
commit of this task. Fix belongs in `packages/testkit/src/foundation/foundation-fault-schedule.ts`.
