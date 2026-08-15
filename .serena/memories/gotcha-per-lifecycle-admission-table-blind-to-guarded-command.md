# A per-lifecycle admission table cannot fence a command whose handler guards on state

Found while QA-ing task-3d5a72fea6db45cfb8df748b58b6aae4 (`goal.advance_graph_epoch`).

## The shape
`goal-reducer.test.ts` carries an `ALLOWED` table: for every (lifecycle, commandKind) pair it drives `reduceGoal` and expects a refusal for every pair not in the allowed set. That reads like an airtight fence over `GOAL_TRANSITIONS`.

It is not. I mutated the production map to admit the new command from DRAFT:

```
"goal.advance_graph_epoch": Object.freeze(["DRAFT", "EXECUTION_ENABLED"]),
```

The ALLOWED table stayed GREEN. In DRAFT the goal's `activeGraphRevisionRef` is `null`, so the command sailed past the lifecycle check and was refused one layer deeper by the handler's predecessor guard — with the **same** `ILLEGAL_TRANSITION` code. The table asked "was it refused?", got yes, and passed.

## Why the task survived anyway
A second assertion pinned the production constant directly:

```
expect(GOAL_TRANSITIONS["goal.advance_graph_epoch"]).toEqual(["EXECUTION_ENABLED"]);
```

That is what reddened. Without it the lifecycle fence would have been unasserted while looking thoroughly covered.

## The general rule
A table-driven admission sweep only fences commands whose handler is *reachable and accepting* from the wrongly-admitted state. Any command with a state-dependent precondition that happens to fail in the extra state is invisible to it — and the more carefully the handler fails closed, the more completely it hides the fence bug.

## What to demand as QA
For a new command kind, require a **direct pin on the production transitions map** (`toEqual([...])`), not just membership in the per-lifecycle refusal sweep. When the worker's mutation note says "the table assertion caught it", run the mutant yourself and read *which* test failed — on this task the note named the table but the const pin did the work.

Related: `mem:gotcha-lifecycle-admission-mutant-shadowed-by-handler`, `mem:refusal-test-answered-by-earlier-guard`, `mem:qa-generated-table-cannot-police-its-own-generator`.
