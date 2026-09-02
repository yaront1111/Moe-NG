# task-c4171c1c - Daemon expansion admission composition: QA APPROVED

REVIEW -> DONE by qa-7f9df027, 2026-08-26. Verified at HEAD `9c41ad94`,
merge-base `9f0d2506`. Durable QA evidence: `comment-410b90a7f1a14b9bb7805647629082f6`.
Worker evidence: `comment-31da3b7112214d028506504a2c87d7cc`,
`comment-93ab52a66b7244bc9eb0b137a61ae3cd`, `comment-80abb8a96a63418ea519c050ab931f0b`.

## Gates I re-ran

`pnpm --filter @moe/daemon test` -> EXIT 0, `Test Files 278 passed (278)`,
`Tests 5848 passed | 12 todo (5860)`. Ran TWICE (before my drills, and fresh at
the restored tree). Focused `src/planning/expansion-admission` -> 2 files / 44
tests. Count lines present, so the legs provably EXECUTED.

Worker recorded 263/5406; I measured 278/5848. NOT a discrepancy - peers add
tests in the shared worktree between runs. Never treat a moved suite total as a
false completion claim on this board.

## The typecheck red is FOREIGN and stays foreign

`pnpm --filter @moe/daemon typecheck` -> EXIT 1, sole failing file
`src/budget/budget-current-projection.test.ts` (TS7006 x4 at 144-147). It is
` M` UNCOMMITTED peer WIP adding `plantRootReplayHistory`/`BudgetLedgerEntry`.
Absent from this task's diff; owned-path intersection EMPTY. Also: typecheck is
in the PLAN's step 6 but NOT in `task.verification` and NOT in DoD 5, which names
`pnpm --filter @moe/daemon test` alone. See
`mem:gotcha-typecheck-red-from-a-peers-uncommitted-test-file`.

## My three re-drills (one degree of freedom changed from the worker's seven)

Grading their transcript is not grading their assertions. All three RED:
1. NEAR-MISS unwind - they drilled "skip the unwind"; I kept
   `budgetReservationCancelled: true` and emptied `restoredMeters`. RED on two
   arms, including the discriminating early-refusal control. DoD 2's NON-EMPTY
   word is load-bearing.
2. `fromApproval` drops the upstream `component` - they drilled layer-restamping.
   RED: `expected null to be 'EXPANSION_APPROVAL'`.
3. `exactly()` arity `===` -> `>=` in the payload decoder. RED on the
   server-owned-key sweep. DoD 0 is ENFORCED, not merely asserted.
All targets TRACKED, so empty `git diff`/`git status` in a SEPARATE call is a
valid restore proof. Backups %TEMP%/qa7f9df027-*.bak.ts.

## The thing a future reviewer will want to re-litigate

TRANSPORT REGISTRATION OF `graph.admit_expansion` IS ABSENT, AND THAT IS CORRECT.
Do not reject a future expansion row for it. Measured on disk, not taken on
trust: `expansion-request-service.ts:26` says the same of `graph.request_expansion`
(`buildCommandRegistry` throws on a duplicate kind = daemon BOOT crash), and
`daemon-command-graph-edges.ts` was landed by task-931f99e8, which owns
exactly-once registration. So the precedent row 738a12a8 shipped UNREGISTERED and
931f99e8 later added its edge. Rail 0's "durable apps/daemon call site" is graded
on the KERNEL CALLS living in a non-test production module, which is exactly how
plan step 5 wrote the assertion. Consumer requiring the edge: task-005c9896.

## Accepted with note, not rejected

- ARMS/PRECEDENCE/SERVER_OWNED_KEYS assert `toBeGreaterThan(0)` where plan step 6
  said "exact nonzero cardinality"; ABSENCES/BYTE_SETS do assert exact
  (`toBe(6)`, `toHaveLength(4)`). Rail 3's real target - the zero-case sweep - is
  closed either way.
- `fenceFactsOf`'s `subordinateAuthorityFenced: proven as true` is a cast that
  lies to tsc. Documented, and fails CLOSED downstream at core's
  `EXPANSION_PREPARATION_FENCE_UNPROVEN`. The runtime boolean is what travels.
- DoD 2 says seven categories; the suite ships 6 regex arms + 1 child-aggregate
  arm (a child has no marker of its own - it would be a NEW aggregate id). That
  is the honest shape, not a missing arm.

## Per-file cap

248/247/176/175/173/87 production lines. Fixtures 527, exempt
(`mem:fixture-modules-are-not-held-to-the-400-line-cap`).
