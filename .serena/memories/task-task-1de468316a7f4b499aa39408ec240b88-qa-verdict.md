# QA verdict: schedule coverage checker (task-1de468316a) — APPROVED at fix commit 444e034

Reviewer qa-bdf27860, 2026-08-07. Supersedes the reject verdict on `c4f9f6a`.
Fix commit `444e034 fix(testkit): inject landed planning tables into schedule universe`,
4 files, +376/-155 (net 221, under the 400 bar). Forward fix, no revert.

## All three rejection issues re-verified as CLOSED
1. **Shrunken universe** — `CORE_TRANSITION_TABLES` (now in the new
   `schedule-universe-tables.ts:195`) injects GOAL, GRAPH_REVISION, PLANNING_RUN, PROJECT.
   Gate `schedule-coverage.test.ts:84` asserts the authored `(fromState|commandKind)` domain
   equals the domain re-derived from the four real reducer tables imported from
   `packages/core/src/index.js`. Universe grew 21 -> 53 transitions, 18 -> 50 race pairs,
   51 -> 64 schedules. `SCHEDULE_AGGREGATE_UNLANDED` no longer appears in the live manifest.
2. **Phantom command kinds** — `ABSTRACT_EDGE` deleted; `grep -rn "graph\.activate\|planning\.submit\|ABSTRACT_EDGE"`
   over `packages/testkit/src/schedule` + `tests/property/schedule` returns zero.
3. **Gate pinned the bug** — `schedule-coverage.test.ts:243` now asserts all four aggregates ARE
   injected, are keys of `RUNTIME_LIFECYCLES`, have non-empty edge sets, and are the exact set
   cited by schedules. The un-landed UNKNOWN path stays first-class at :259 by re-running the
   checker with GRAPH_REVISION's table withheld and asserting a named `SCHEDULE_AGGREGATE_UNLANDED`.

## Edge transcription checked against reducer bodies, not trusted
I read `graph-revision-reducer.ts`, `planning-run-reducer.ts`, `planning-run-submission.ts`,
`planning-results.ts` and confirmed all 32 new `(from, command, to)` triples, including every
multi-to-state branch: `decide()` PENDING_APPROVAL -> APPROVED (activation undefined) / -> ACTIVE
(compound) and APPROVED -> ACTIVE; `propose()` PLANNING -> PLANNING vs -> SUBMISSION_DRAINING
(`draining = livePlannerEffect && !proven`) and the SUBMISSION_DRAINING same-hash replay;
`finalize()` -> PLAN_REVIEW (seal) vs -> REJECTED (`rejectRun`); `approvePlan()` APPROVED -> APPROVED
idempotent; `revisePlan()` PLAN_REVIEW -> REJECTED; `activate()` -> ACTIVATED from PLAN_REVIEW and
APPROVED; `release`/`recoverAbsent` are PLANNING self-edges (no lifecycle patch); 6 `goal.cancel`
edges -> CANCELLED. Counts land exactly: 24 PLANNING_RUN + 8 GRAPH_REVISION.
Empty rows classified correctly: `planning.cancel` and `graph.supersede` are NEVER_LEGAL (both
routed to `illegal()` in `apply`), not genesis.

Race-pair arithmetic re-derived by hand: GOAL 15 + PROJECT 3 + PLANNING_RUN 29 + GRAPH_REVISION 3
= 50, and the four overlapping declared PLANNING subsets (lease/submission/seal/recovery) union to
exactly the 15 pairs of the 6-command PLANNING fan-in.

## Commands re-run by me, all foreground
- `pnpm test:property` -> exit 0, 2 files / 43 tests.
- `pnpm typecheck` -> exit 0, all 10 packages (packages/mcp now green too; the earlier red was
  foreign uncommitted work, since landed).
- `pnpm test` -> exit 0, 90 files / 1247 passed / 1 skipped (pre-existing).
- Sizes: checker 360, model 255, tables 211, invariants 117, scenarios 84, obligations 92 — all
  under 400; invariants SHRANK 203 -> 117 while the universe grew.
- Zero hits for `Date.now|new Date|Math.random|process.` and for `scheduler/src|@moe/scheduler/`.
- `git diff c4f9f6a 444e034` over schedule-model.ts / schedule-obligations.ts / schedule-checker.ts /
  schedule-checker.test.ts is EMPTY — the previously-cleared files are byte-identical, so the prior
  round's canonicalization and fail-closed verification still holds without redoing it.

## Mutation testing (both killed, tree restored clean)
- `runRevise` from-state PLAN_REVIEW -> APPROVED: 6 gate tests die, including the lockstep test and
  `SCHEDULE_TRANSITION_UNREACHABLE` reaching a FAIL verdict. This is exactly the escape class that
  produced the original reject; it is now caught.
- `REVISION_RACE.approved` emptied: 4 tests die with `SCHEDULE_UNIVERSE_UNCOVERED`.

## Residual limitation, recorded not rejected
The lockstep test compares only `(fromState|commandKind)`; to-states are asserted only for
membership in `RUNTIME_LIFECYCLES[aggregate]` and non-entry into GENESIS. A to-state that is wrong
but still a valid lifecycle name would be self-consistent with the derived universe and escape the
gate. I verified all 32 manually this round. See `mem:gotcha-transition-table-vs-reducer-tostate`.
Not a defect and not a DoD item — flagged for whoever injects the next aggregate.
