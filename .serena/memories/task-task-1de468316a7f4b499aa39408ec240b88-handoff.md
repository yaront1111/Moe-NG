# Handoff: schedule coverage checker — DONE (QA-approved at 444e034)

Task task-1de468316a, epic M5 GA evidence. Two commits: `c4f9f6a` (initial, rejected on defect)
then `444e034` (forward fix, approved 2026-08-07 by qa-bdf27860). Not reverted.

## Shipped surface
`packages/testkit/src/schedule/` (no index export, scheduler-fairness precedent):
- `schedule-model.ts` (255) — ScheduleDefinition, canonicalization (placeholder-normalize ids,
  STRIP timestamps/seeds, sorted-key serialize, sha256 identity), stratum-keyed frozen minima,
  manifest types, `SCHEDULE_COVERAGE_MANIFEST_VERSION`, `RELEASE_SCHEDULE_FLOOR` (10000, UNKNOWN).
- `schedule-obligations.ts` (92) — frozen 36-obligation registry, CORE-I1..I22 + CORE-S1..S14.
- `schedule-checker.ts` (360) — `checkScheduleCoverage`, derives the edge and two-event race-pair
  universe from INJECTED tables (testkit keeps no @moe/core dep) and checks BOTH directions.
- `schedule-universe-tables.ts` (211) — EDGE/RACE/RUN_RACE/REVISION_RACE/FAULT, GENESIS_COMMANDS,
  NEVER_LEGAL_COMMANDS, CORE_TRANSITION_TABLES (4 aggregates), defineSchedule.
- `schedule-universe-invariants.ts` (117) / `-scenarios.ts` (84) — 40 + 24 = 64 schedules.
Gate: `tests/property/schedule/schedule-coverage.test.ts` + `schedule-checker.test.ts`,
root script `test:property`. Universe: 53 transitions, 50 race pairs, 64 schedules.

## Live manifest state
All 36 obligations UNKNOWN for `SCHEDULE_EVIDENCE_ABSENT` ALONE — execution evidence does not
exist yet and that is the designed verdict (design 1153/1267), not a gap. Zero FAIL,
`SCHEDULE_AGGREGATE_UNLANDED` no longer appears live; the gate keeps that path exercised by
re-running the checker with GRAPH_REVISION's table withheld. Injecting synthetic evidence for all
64 identities flips 36/36 to PASS, so absent evidence is the only thing holding it at UNKNOWN.

## For the next aggregate that lands
Any new reducer exporting a transition table MUST be injected into `CORE_TRANSITION_TABLES` or the
lockstep assertion at `schedule-coverage.test.ts:84` goes red BY DESIGN. Doing it means:
transcribe every edge with its to-state read out of the REDUCER BODY (the table carries from-states
only), classify each empty row as GENESIS vs NEVER_LEGAL, then extend schedules until reverse
completeness claims every new edge and race pair.

## Known residual weakness (QA-recorded, deliberately not blocking)
The lockstep test compares only `(fromState|commandKind)`. To-states are asserted only for
membership in `RUNTIME_LIFECYCLES[aggregate]` plus "no edge into GENESIS". A to-state that is wrong
but still a valid lifecycle name is self-consistent with the derived universe (the checker derives
the universe FROM this same data) and no test catches it. QA hand-verified all 32 planning edges
against the reducers this round. The durable fix is executing the reducer in the gate to prove the
to-state; whoever injects the next aggregate should do that.

## Verified at approval (do not redo)
`pnpm test:property` exit 0 (43 tests), `pnpm typecheck` exit 0 all 10 packages,
`pnpm test` exit 0 (90 files / 1247 passed / 1 pre-existing skip). All modules under 400.

See `mem:task-task-1de468316a7f4b499aa39408ec240b88-qa-verdict`,
`mem:gotcha-transition-table-vs-reducer-tostate`,
`mem:gotcha-stale-dependency-check-pins-shrunk-universe`.
