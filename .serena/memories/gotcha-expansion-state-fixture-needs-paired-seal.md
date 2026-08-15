# An EXPANSION test state at a sealed lifecycle needs its seal, or every command answers UNKNOWN_ERROR

Found on task-93b0314e09f248118e21f92699989468 (@moe/core PlanningRun), 2026-08-09.

`validExpansionContractState` calls `sealedPlacement`
(`packages/core/src/planning/planning-expansion-validation.ts:161-166`), which binds two fields in
BOTH directions:

```ts
if (submission === null) return sealed === null;
return validExpansionProposalIdentity(sealed) && sealed.proposalHash === submission;
```

So `submissionHash === null` REQUIRES `sealedProposal === null`, and a non-null `submissionHash`
REQUIRES a valid identity whose `proposalHash` equals it.

The trap: the shared fixture `state(lifecycle)` sets `submissionHash` automatically for
`PLAN_REVIEW`, `APPROVED`, `ACTIVATED` and `SUBMISSION_DRAINING`, while `expansionState()` defaults
`sealedProposal` to `null`. So `expansionState("PLAN_REVIEW")` is an INVALID contract state, even
though it looks like the obvious way to build one.

## Why it is expensive to diagnose

Nothing throws. `reducePlanningRun` reads state through `snapshotPlanningRunContractState`, which
returns `undefined` for an invalid shape, and the reducer degrades to `unknownFailure()`. The test
reports `expected 'UNKNOWN_ERROR' to be 'PLANNING_SUBMISSION_FINALIZING'` — which reads exactly
like a missing production branch in the reducer, not a malformed fixture. I nearly went looking for
the fence before checking the state.

## The fix shape

Pair them at construction rather than per test:

```ts
function runAt(lifecycle: PlanningRunLifecycle) {
  return expansionState(lifecycle).submissionHash === null
    ? expansionState(lifecycle) : sealedRun(lifecycle);
}
```

Same family as `mem:gotcha-widened-state-shape-degrades-silently-at-the-snapshot-guard`: in this
aggregate an unreadable state is never an exception, always a silent `UNKNOWN_ERROR`. When a
PlanningRun test gets `UNKNOWN_ERROR` it did not expect, suspect the INPUT STATE first.

Note `@moe/core` has `noUncheckedIndexedAccess` on: `record[key]` is `T | undefined` and
`parts[0]` off a `split(".")` needs `?? ""` before it can index.
