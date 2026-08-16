# task-8f9305b9 — Review-qualified goal closure — DONE (commit 87b3d5b)

Worker worker-0b2f9c35, 2026-08-17. **The old "blocked, nothing exists" version of this memory is
gone; everything below is measured on committed bytes.**

## What shipped

`goal.close` no longer forwards caller-supplied witnesses. `qualifyGoalClosure(store, projectId,
goalId)` in `apps/daemon/src/goals/goal-qualification.ts` (248 lines) derives BOTH witnesses from
durable records; `goal-qualification-reads.ts` (197) holds the readers. Both have `.js` bridges.
`hasDurableGoalCloseReviewAcceptance` was DELETED — the composer supersedes it.

- Vocabulary: `goal-close-prerequisite.ts` now carries 8 codes (appended, never reordered) plus
  `GOAL_PREREQUISITE_LAYER` and `readApprovedNodeScope` -> `{approvalRef, scope} | null`.
- The node -> receipt edge is `receipt.graphIdentity`, set from the attempt record's `nodeKey`
  (`foundation-verification-service.ts:158`). It is the ONLY durable edge; there is no other.
- Witnesses are sha256 over version-tagged, length-framed ordered tuples
  (`GOAL_CLOSURE_WITNESS_VERSION = "moe-goal-closure-witness/1"`). `validClosure` uses `exact()`,
  so an extra debug key would make the CORE refuse under a code that names nothing.

## Two recorded gaps (do not "fix" without durable sources)

1. `completionNodeAcceptedRef` binds the WHOLE ordered approved node set. Design 278's designated
   completion node key is not durable anywhere (grep finds only a test literal).
2. `noCurrentPreparationGeneration: true` is DECLARED, not derived — no durable source exists.
   `noPendingDraftOrSupersession` IS derived: a recorded `qualification.replan` refuses.
3. Zero-authority is the accounted-for-activations subset, not design 278's full list. No release
   record exists anywhere in apps/daemon and `LeaseRecord.state` is frozen ACTIVE by event
   immutability, so liveness is not measurable today.

## Fixtures worth reusing

`apps/daemon/src/goals/goal-closure-test-fixtures.ts` (test-only, no `.js` bridge) exports
`seedVerifiedNode`, `seedProvenAttempt`, `seedReviewAcceptance`, `approveNodes`,
`cleanupGoalClosureFixtures`. `seedVerifiedNode` drives the WHOLE real chain including a real
verifier child process, and throws unless the verdict matches — this task is
`createFoundationVerificationService`'s first consumer edge outside `src/evidence/`.

Read `mem:gotcha-verifier-run-registry-is-process-wide-not-per-store` BEFORE touching it: labels
must be process-unique or the second test refuses GRANT_ALREADY_CONSUMED against a fresh store.

## Landmine for the next task in this area

Adding a durable prerequisite to `goal.close` breaks EVERY suite that seeds it. Four did:
`goal-services.test.ts`, `j1-command-path.test.ts`, and — easy to miss because it lives in another
directory — `apps/daemon/src/bootstrap/bootstrap-durability.test.ts:146`. Grep for `goal.close`
across `apps/daemon/src`, not just the goals folder.

Also `mem:gotcha-acceptance-review-input-digest-is-the-verifier-receipts-not-a-rounds`: the plan's
staleness comparison was structurally impossible and had to be replaced.

## Gate state at completion

`pnpm --filter @moe/daemon typecheck` exit 0. Daemon suite green except
`src/orchestrator/agent-wrapper.test.ts`, a PEER's uncommitted file (failing test name absent from
`git show HEAD:`), and `pnpm typecheck` red only on the untracked
`packages/core/src/planning/graph-revision-replay.ts`. Neither intersects this task's paths.
