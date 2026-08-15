# Adding fields to an aggregate state degrades EVERY command, silently, at the snapshot guard

Hit on task-93b0314e (PlanningRun EXPANSION), 2026-08-09.

## The trap

Aggregates in this repo re-validate their own state on every command:

```ts
const current = snapshotPlanningRunState(state);
if (current === undefined) return unknownFailure();
```

`snapshotPlanningRunState` is built on `exact(value, STATE_KEYS)`, which requires the key
count to match EXACTLY. So the moment a task widens the state shape — here 12 keys to 14 —
every command against the widened state fails that guard and returns `UNKNOWN_ERROR`.

There is no throw, no type error, no obviously-wrong line. `tsc` is happy because the widened
type still assigns to the declared one. The new branches you added look correct and are simply
never reached. A test asserting only `ok === false` on a refusal path passes while nothing
works at all.

## How to catch it

Grep for the snapshot/validate call on the state (not the command) BEFORE writing anything
else, and check whether the widened shape has a validator that admits it. Here the dependency
had already published `snapshotPlanningRunContractState`, which accepts the legacy shape AND
the widened one — the whole task was dead code until that one call was swapped.

Then prove the line is load-bearing with a drill: revert it to the narrow validator and
confirm the failure message is literally

    expected 'UNKNOWN_ERROR' to be 'ILLEGAL_TRANSITION'

If your tests only assert `ok === false`, this drill stays GREEN and proves nothing. Assert
the exact discriminated shape on every refusal — that is what makes the drill able to fire.

## The second-order defect: successor / derived-state builders

Any helper that rebuilds state from literals has the same problem one step later, and it is
much easier to miss because it only surfaces on a LATER command. Here `successorData()` built
a 12-key literal with `runKind: state.runKind`. Rejecting a widened run produced a successor
claiming the widened kind with none of the widened fields — invalid, so the NEXT command
against the successor returned `UNKNOWN_ERROR`.

Grep for every builder that constructs the state type from scratch (successor data, seed/init
helpers, test fixtures) when you widen a state shape. `clonedState`-style spreads are safe;
fresh literals are not.

Related: `mem:guard-premise-detaches-while-green`,
`mem:gotcha-closed-enum-all-array-couples-sibling-tests`.
