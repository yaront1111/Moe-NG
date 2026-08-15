# Planning graph lifecycle core — CLOSED OUT to REVIEW (2026-08-07, worker-2edeee3c)

Supersedes the earlier architect-blocked handoff. Task moved BLOCKED -> PLANNING -> WORKING -> REVIEW.

## What happened

Human approved task-rail proposal `prop-2eaa632d2b594efd90efc141e7be2361`: a **one-time
historical size exception scoped to commit `bcdc2f6` only**. The governor's reopenReason
explicitly forbade re-planning and re-implementation — BLOCKED -> REVIEW is not a legal
daemon transition, so the PLANNING pass existed *purely to route* the already-landed work.

The worker pass therefore authored **zero bytes**. Two plan steps, both verification-only.

## Landed state (unchanged)

- `bcdc2f6` "feat(core): add planning graph lifecycle" — 13 files, +3116/-0, ancestor of HEAD.
- `git status --porcelain -- packages/core/src` EMPTY and `git diff` on
  `packages/core/src/planning` + `packages/core/src/index.ts` EMPTY. Root exports untouched.
- Fresh gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0,
  9 test files / 189 tests, run twice identical.

## DoD evidence sites (re-read cold, not taken on QA's word)

- `planning-run-submission.ts:118-125` — approvePlan requires exact `sameHashes` equality vs
  `sealedHashes`; re-approval idempotent only on an identical 4-tuple.
- `planning-run-submission.ts:139-152` — atomic J1 `activate`, validates graphHash+qualityHash
  against the same seal before emitting PlanApproved + PlanningRunActivated, single version bump.
- `planning-validation.ts:153-156` — `executionBearingKeys` derives the admission count from the
  witness; a caller-supplied count is never trusted. Gate sits at submission, not activation.
- Hash mismatch = zero state change on both aggregates; graphEpoch authority stays in the goal
  aggregate.

## Still open for the next agent

The **permanent** <=250-line production+test rule STANDS. Six decomposition children own the
split and must keep root exports unchanged:
`task-866713137aee4794a51973fe4e6e3f44` (planning-contract 368),
`task-5a95354855304c24a6af27538ab9e131` (graph-revision-reducer 259),
`task-ca32f538d8e249b39d7b99eb5424b317` (planning-run-reducer.test 514),
`task-cefb2442deda44fcb0e62ca8bbbcd27b` (graph-revision-reducer.test 288),
`task-7cb6ffc3cb95450fb0b564c81a49eda3` (planning-invariants.test 432),
`task-74508e0de86b40829eda1cd343742336` (directory-wide size guard; depends on the five).

Dependency seam: graph-revision validation/reducer import planning-snapshot (so graph-revision
follows the planning-run/shared layer); planning-invariants imports both reducers/contracts and
is last.

See `mem:gotcha-routing-only-task-pass`, `mem:gotcha-core-aggregate-loc-bar`,
`mem:gotcha-shared-tree-repo-gate`.
