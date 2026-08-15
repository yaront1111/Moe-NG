# task-3d5a72fea6db45cfb8df748b58b6aae4 — QA verdict: APPROVED

Goal-side graph epoch advance (`goal.advance_graph_epoch`). Reviewed at HEAD b24d2fd, merge-base bec1cc6c.

## What I re-ran (not trusted from the worker)
- `pnpm --filter @moe/core typecheck` exit 0.
- `vitest run --root . packages/core/src tests/property/schedule/schedule-coverage.test.ts` = 26 files / 399 tests pass. Core alone 25/382, matching the worker's claim exactly.
- Plain-node probe of `goal-results.js` bridge: loads 8 exports. The `.js` bridge convention in `packages/core/src/goal/` is real and was honoured.
- Hand-measured `grep -c ''` AFTER restoring my drills: contract 235, reducer 243, validation 245, results 61. All <=250. `packages/core/src/goal/` is still NOT swept by `planning-source-size.test.ts` — always hand-measure here.

## Mutation drills I ran myself (all 5 killed; SHA-restored + porcelain clean after)
1. Strip `layer` from `rejected()` in goal-results.ts -> 9 refusal tests RED. Proves the layer is a production discriminant.
2. Delete the predecessor guard -> exactly the named mismatch test RED.
3. Leak `activatedState` into the refusal result -> 3 epoch cases RED on `Object.hasOwn(result, "state")`. The byte-identical guarantee is structural, not incidental.
4. Empty `invalidEpochs` -> the non-zero count assertion RED.
5. Admit the command from DRAFT -> fence test RED.

## Two findings worth carrying forward
- **The DRAFT-admission mutant is shadowed by the handler.** `goal-reducer.test.ts`'s ALLOWED per-lifecycle table did NOT redden: in DRAFT, `activeGraphRevisionRef` is null, so the predecessor guard refuses with the same `ILLEGAL_TRANSITION` and the table still reads "refused". What actually killed the mutant is `goal-epoch-advance.test.ts:115`, which pins `GOAL_TRANSITIONS["goal.advance_graph_epoch"]` `toEqual(["EXECUTION_ENABLED"])` — a direct assertion on the production const. The worker's step-7 note said "table assertion saw DRAFT", which is imprecise about which assertion fired; the outcome is still the required one.
- **Guard ordering was checked for shadowing.** `advanceEpoch` refuses in order: (1) invalid refs / non-safe-integer epoch -> UNKNOWN_ERROR, (2) predecessor mismatch -> ILLEGAL_TRANSITION, (3) epoch != current+1 -> ILLEGAL_TRANSITION. The stale/equal/skipped cases all pass a MATCHING predecessor, so guard 3 genuinely answers them rather than guard 2. This was the specific way the sweep could have gone vacuous, and it did not.

## Scope calls
- `packages/testkit/src/schedule/schedule-universe-{tables,invariants}.ts` are out-of-plan but **forced**, not creep. `tests/property/schedule/schedule-coverage.test.ts:88` asserts the authored tables are lockstep-equal to the LANDED `GOAL_TRANSITIONS`, so adding a command kind mandates the twin edit. The 4 added races are exactly the derived `EXECUTION_ENABLED` command pairs — complete, not padded.
- Nothing written under `packages/core/src/planning` (task-aedcd01a's half). Confirmed by name-only diff.

## Foreign red, attributed by experiment rather than by prose
`tests/fault/foundation/j1-linear.test.ts` "incident:hot-claim-loop-on-gated-work" expects `PRODUCTION_BEHAVIOR_ABSENT`, receives `PASS_EXPECTED`. I copied all five touched production files back to their `bec1cc6c` bytes and re-ran: **still RED**. Not caused by this diff. Likely flipped by the scheduler work (task-e8e27f76 / task-069853) landing the capability the absence probe was asserting missing.

## Consumer (Clause 1)
task-aedcd01ad91245d9a036d9dac3b76a22 is real and landed — `packages/core/src/planning/graph-revision-reducer.ts:168` binds a durable `graphEpoch` from the activation, and `graph-revision-succession.test.ts` asserts against the successor's durable state rather than the emitted binding.
