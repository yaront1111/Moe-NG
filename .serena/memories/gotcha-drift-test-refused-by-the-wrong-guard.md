# A drift test proves nothing when two guards can refuse the same input

Found on `task-1df0622e87cf42beae2cd82280e9ff99` (graph revision supersession), 2026-08-09, by a
mutation drill that SURVIVED against a fully green 338-test suite.

## The shape
A validator refuses an input for reason A. Your test drifts one field and asserts the refusal code.
It passes. But a SECOND guard in the same validator also rejects that same drifted input, and it
answers first. The assertion has silently detached from the guard it was written for — you can now
delete or corrupt the intended guard and the test stays green.

## The concrete instance
`decideSupersession` refuses via two independent checks:
- `samePredecessor(current, input.expectedPredecessor)` — is the command talking about THIS revision?
- `monotonic(current, input.successor)` — incl. `next.predecessorRevisionId === current.revisionId`.

Test drifted `expectedPredecessor.revisionId` to a foreign id and asserted `REVISION_REBOUND`. Green.
Mutation: make the reducer pass `command.supersession.expectedPredecessor.revisionId` into the kernel
instead of `state.revisionId` — i.e. echo the attacker's own claim back as the live binding, defeating
`samePredecessor` entirely. **Suite stayed 100% green.** `monotonic` was catching every case, because
the drifted `expectedPredecessor` no longer agreed with the untouched `successor.predecessorRevisionId`.

## The fix that works
Make the input SELF-CONSISTENT with everything except the guard under test. Drift
`expectedPredecessor.revisionId` AND `successor.predecessorRevisionId` to the SAME foreign value.
Now the payload is internally coherent and only comparison against LIVE STATE can refuse it. The
mutation reddens immediately.

## Generalisation, worth applying everywhere
When a refusal path has more than one guard over overlapping fields, ask: *which guard actually
fired?* A one-field drift usually breaks an internal agreement too, and the cheaper guard answers.
The reliable construction is: **hold the payload internally consistent, and vary only its
relationship to the authority you are testing against.**

The only reason this was found is that the drill was run and observed to SURVIVE rather than being
declared passed. Related: `mem:mutation-drills-in-shared-worktree`,
`mem:qa-generated-table-cannot-police-its-own-generator`.
