# Handoff: foundation executable specification — REOPEN PASS DONE

QA rejected pass 1 (reopenCount 1). The specification design was explicitly
praised and NOT rewritten. The rejection was about GATE REACH, and that is what
this pass fixed.

## The rejection, restated

The declared verification `pnpm --filter @moe/testkit typecheck && pnpm --filter
@moe/testkit test` resolves to `vitest run --root ../.. packages/testkit/src`.
The task also owns `tests/fault/foundation/**`. That glob never matches it, and
no tsconfig in the repo included `tests/`. So 4 owned files / 667 lines / 43
tests were neither executed nor typechecked by evidence filed as `exitCode: 0`.
Full mechanics in `mem:gotcha-package-filter-cannot-reach-tests-dir`.

## What this pass added (7 files touched, ~311 net lines)

1. **`tests/fault/foundation/tsconfig.json`** (NEW, inside the owned glob — no
   foreign file touched). Extends `tsconfig.base.json`; `composite:false` because
   relative cross-package imports pull package sources into the program. 68
   errors on first run, 0 now.
2. **`foundation-harness.ts` fully typed** (95 -> 202 lines). New helpers, no
   `any` anywhere: `accepted`/`refused` (generic, return `Extract<T,{ok}>` so the
   caller keeps its own core/contracts type), `fixturePayload(id, typedConstant)`
   (asserts referential identity with the registered fixture instead of casting
   `payload: unknown`), `missingEvidenceOf`, `executorFor`. `produceAbsenceOutcome`
   and `missingEvidenceOf` throw on an entry of the wrong outcome kind.
3. **`foundation-gate-coverage.test.ts`** (NEW, 150 lines) — the recurrence
   ratchet. Lives under `packages/testkit/src` ON PURPOSE, inside the narrow
   command, so the check guarding the narrow command cannot itself fall outside
   it. Reads real tool config off disk: enumerates `.ts` under both owned dirs,
   asserts each test file is matched by a filed gate filter, pins testkit
   `scripts.test` positional to exactly `["packages/testkit/src"]`, asserts every
   owned file is in a tsconfig project extending the shared base.
4. `foundation-fault-schedule.ts` — comment stating probe ABSENT means
   "unexported", not "unimplemented" (QA's non-blocking item 3; the scheduler
   package's authority/lease modules DO exist, they are just not re-exported).

## THE GATE — use this, not the declared one

```
pnpm --filter @moe/testkit typecheck && pnpm --filter @moe/testkit test \
  && pnpm exec tsc --project tests/fault/foundation/tsconfig.json \
  && pnpm exec vitest run tests/fault/foundation
```
Strict superset of the declared command, so exit 0 proves the declared command
passed too. Result: testkit 18 files / 234 tests; tsc 0 errors; fault 3 files /
43 tests. Repo: `pnpm typecheck` exit 0, `pnpm test` 114 files / 1583 passed /
1 skipped.

## A real bug the typecheck found (not just annotations)

`j1-linear.test.ts` read `late.error.code` on a `GoalReducerResult` union.
`expect(late.ok).toBe(false)` above it does not narrow. Had the reducer started
accepting a post-cancel start — the regression that schedule exists to catch —
the next line would have thrown `TypeError` on undefined instead of failing the
schedule. Three more of the same shape in j4.

## Mutation proofs (all reverted; do not trust these by reading)

- Narrow `GATE_TEST_FILTERS` back to the rejected command -> RED naming exactly
  j1-linear / j3-crash / j4-replan-stale. The rejection reproduced by the ratchet.
- Add an uncovered `.ts` under the owned dirs -> RED. Delete the tsconfig -> RED.
- Repoint `probe:scheduler-authority-lease` at landed `previewGraphSnapshot` ->
  j4 RED (produced PASS_EXPECTED vs declared PRODUCTION_BEHAVIOR_ABSENT).
- Drop one executor from the J3 map -> 2 RED, one of them the named
  `ReferenceError: No executor for manifest entry ...`.

## Unchanged from pass 1 (still true, still the design)

Import discipline (`packages/testkit/src/foundation/**` imports ONLY
`@moe/contracts` + node + vitest + relative siblings; production packages reach
it solely through the harness). Probed-ABSENT ratchet. Partition completeness
(J1 12 / J3 13 / J4 14 = 39). Vocabulary `moe-foundation-expected-outcome/1`.
Pinned digests are hand-typed LITERALS — edit a payload and the spec test stays
red until you re-pin. Every file <=250 lines.

## Commits — review at the PATHS, not at any one commit

Owned files are now spread across FIVE commits, four of them foreign sweeps:
`4e8ac7c`, `f8db0a5` (pass 1), `cb3cb6a` (mine, pass 1), `4b7deb3` (foreign
sweep, took the new tsconfig + gate-coverage test MID-EDIT), `cda900b` (mine,
this pass, explicit pathspec, exactly 4 owned paths). See
`mem:gotcha-session-end-commit-sweeps-foreign-work` — including the diagnostic
that an EMPTY `git diff` on a file you just edited means you were swept, not
that your edit failed.

## Left for someone else

Oversize of the original 2228 lines is architect-owned; QA said do not self-split
and do not cite prior oversized approvals as precedent. The reviewer-calibration
corpus (design 15.3) is a separate unowned Phase-1 artifact — zero bytes here.
`tests/fault/**` still overlaps the Security fault-matrix task's ownership; the
carve-out is not recorded anywhere durable.
