# Gotcha: the 400 net LOC QA bar vs aggregate-shaped core tasks

`task-1ade51c0` (Planning graph lifecycle core) was **QA-rejected on size
alone** — commit `bcdc2f6`, +3116 LOC / 13 files vs a 400 net LOC bar (7.8x).
Code was correct: QA re-ran the gate 3x (exit 0, 189/189), mapped all four DoD
items to evidence, and mutation-tested the two critical gates. Not one defect.

## The structural conflict

A core aggregate task's verification command is
`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test`.
That gate demands the slice **compile and test as a unit**. A reducer without
its contract + validation + result helpers does not typecheck. So there is no
<=400 LOC increment of an aggregate that can pass its own gate — the LOC bar
and the named gate are in direct conflict for this task shape.

Measured on the planning aggregate, even the QA-prescribed 3-way carve leaves
no bucket under the bar:

| bucket | prod | +test | total |
| --- | --- | --- | --- |
| A planning run (snapshot 145, contract 368, validation 250, results 121, submission 186, reducer 192) | 1262 | 514 | 1776 |
| B graph revision (contract 156, validation 115, reducer 259) | 530 | 288 | 818 |
| C invariants test 432 + root index 90 | — | — | 522 |

**Before planning the next core aggregate** (policy approval, conserved
budget, dependency kernel, ...), settle the bar with the architect first.
Expect ~1200-1800 LOC per aggregate. The runtime also warns at plan
submission: "Plan touches N distinct files (target <=5); plans over 10 are
rejected" — a plan that ships at 13 files is a reject waiting to happen even
when every module respects the <=400 line rail individually (these were
115-368).

## Carve seams are one-directional, check imports before cutting

"Two aggregates that never call each other" was true at aggregate level and
**false at module level**:

```
graph-revision-validation.ts:18  from "./planning-snapshot.js"
graph-revision-reducer.ts:48     from "./planning-snapshot.js"
planning-* -> graph-revision-*   ZERO hits
```

`planning-snapshot.ts` holds the shared hostile-input primitives (hex64,
strongTruth, humanApproved, deepFreeze). So graph-revision must **order after**
planning-run and must **not own** `planning-snapshot.ts`. Always grep the
actual import edges before proposing a split; aggregate boundaries and
compile-dependency boundaries are different things.

## Worker action space on a size-only reject

Empty. Reverting destroys verified work (QA forbade it explicitly, and it
would breach the preserve-foreign-work epic rail); shrinking a landed commit
cannot un-count its LOC. The only move is escalation —
`moe.request_replan` puts the task back in PLANNING where an architect owns
the re-scope. Do not rebuild.

See `mem:task-task-1ade51c0dc104181a67adde741295fd5-handoff`,
`mem:convention-core-reducer-modules`.
