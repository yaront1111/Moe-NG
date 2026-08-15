# task-3d5a72fea6db45cfb8df748b58b6aae4 handoff

Status: implementation complete, handing to QA.

## Capability
- New `goal.advance_graph_epoch` command is admitted only from `EXECUTION_ENABLED`.
- The command carries `graphEpoch`, `predecessorGraphRevisionRef`, and `successorGraphRevisionRef`.
- The goal remains the sole epoch authority: `nextGraphEpoch(state)` is the one +1 calculation used by initial and successor activation.
- A valid advance rebinds `activeGraphRevisionRef`, increments graph epoch/version exactly once, and emits frozen `GoalGraphEpochAdvanced`.
- Missing/non-integer evidence returns `UNKNOWN_ERROR`; verified predecessor/epoch mismatch returns `ILLEGAL_TRANSITION`. Every refusal result carries production `layer: "GOAL"`.
- Consumer per Clause 1: task-aedcd01ad91245d9a036d9dac3b76a22 binds graph revision activation to the epoch issued here.

## Files and commits
Owned base-ref diff has 9 paths: 7 under `packages/core/src/goal` and the mandatory transition-manifest twins `packages/testkit/src/schedule/schedule-universe-{tables,invariants}.ts`.
- `4150c09`: final reducer/test hardening.
- `af48f92`: transition schedule synchronization.
- Foreign whole-tree commit `17bfb37` (task-04e436...) carries the earlier contract/results/validation/test bytes. Do not amend or reset it; review with `git diff bec1cc6c..HEAD -- <owned paths>`.

## Verification
- Fresh task gate: `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0; 25 files / 382 tests.
- Schedule coverage focused test: 17/17.
- Merge-base `bec1cc6c`: repo typecheck 0; repo test 216 files / 4059 pass / 1 skipped.
- HEAD `af48f92`: repo typecheck 0; repo test has one foreign red at `tests/fault/foundation/j1-linear.test.ts:225` (expected PRODUCTION_BEHAVIOR_ABSENT, received PASS_EXPECTED). Owned-path failure delta is empty.
- Physical lines: goal contract 235, reducer 243, validation 245, results 61; testkit invariants 119, tables 217.
- Plain Node `goal-results.js` bridge load passed. No planning path changed.

## Mutation evidence
Dropped predecessor guard, leaked refusal state, +2 increment, DRAFT admission, missing layer, and empty sweep were each killed by the named assertion; bytes were SHA-restored and focused green after every drill.