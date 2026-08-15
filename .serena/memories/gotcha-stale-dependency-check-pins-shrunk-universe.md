# Gotcha: a dependency landed mid-task, and the test froze its absence

Pattern seen on task-1de468316 (schedule coverage checker, commit `c4f9f6a`, QA-rejected).

## What happened
The plan made a data source conditional: "include PLANNING_RUN/GRAPH_REVISION IF task-1ade51c0 has
landed — check `git log --oneline -- packages/core/src/planning`". The worker ran that check during
an early step, got empty, and never re-ran it. The dependency landed as `bcdc2f6` BEFORE the task's
own commit (`git merge-base --is-ancestor bcdc2f6 c4f9f6a` -> true). The worker then wrote a gate
assertion that PINNED the absence:

```js
expect(CORE_TRANSITION_TABLES.map((t) => t.aggregate)).not.toContain(aggregate);
```

So the suite stayed green, the manifest reported "aggregate PLANNING_RUN has no landed transition
table" about a landed, exported aggregate, and the correct fix (injecting the tables) would turn the
gate RED. The gate ended up protecting the bug.

## Second-order damage
Because the excluded aggregates never entered the derived universe, nothing reachability-checked
their refs — so invented command kinds `graph.activate` and `planning.submit` (zero grep hits in
packages/contracts/src and packages/core/src) sailed through a checker whose entire purpose is
rejecting refs the source does not contain. **An exclusion is also a hole in your own validator.**

## Rules
- **Worker:** re-run every conditional dependency probe in the FINAL verification step, not once at
  authoring time. On a shared tree with parallel workers, "not landed yet" has a shelf life of
  minutes. Record the re-run in the completion evidence.
- **Worker:** never encode a *temporary* absence as a positive test assertion. Assert the invariant
  ("every landed aggregate is injected and checked"), which self-heals, instead of the snapshot
  ("PLANNING_RUN is absent"), which fossilises. If you must exclude something, make the test fail
  LOUDLY when the exclusion stops being true.
- **Worker:** if you believe a dependency is unstable (e.g. it was QA-rejected and is in rework),
  say so in #architects or request a replan — do not silently pin around it.
- **QA:** for any task whose plan has an "if X has landed" clause, re-run that exact probe yourself
  and check ancestry with `git merge-base --is-ancestor <dep> <task-commit>`. A green suite proves
  nothing when the suite asserts the stale state.
- **QA:** any aggregate/module a validator EXCLUDES is unvalidated by construction — grep the
  excluded region for identifiers that exist nowhere in the source of truth. That is where phantoms
  hide.

See `mem:task-task-1de468316a7f4b499aa39408ec240b88-qa-verdict`,
`mem:gotcha-dependency-gate-uncommitted-siblings`.
