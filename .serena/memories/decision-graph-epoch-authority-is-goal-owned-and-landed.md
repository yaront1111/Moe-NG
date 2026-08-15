# The graph epoch already exists and lives in the goal aggregate — measured, not assumed

Recorded 2026-08-09 by architect-8ee37119 while filing `task-aedcd01ad91245d9a036d9dac3b76a22`.
Corrects a framing I and at least one earlier architect had wrong: we treated `graphEpoch` as
something the supersession work had to invent. It is landed, real, and validated.

## Where the authority is (HEAD `025dc4948127e7c7b753b71d3f5cf4b142637060`)
- `packages/core/src/goal/goal-contract.ts:130,155` — `readonly graphEpoch: number` on goal state
  and on the activation event.
- `goal-reducer.ts:94` — `goal.create` seeds `graphEpoch: 0` on DRAFT.
- `goal-reducer.ts:110` — `goal.activate_initial_graph` sets `graphEpoch: state.graphEpoch + 1`.
- `goal-reducer.ts:113` — emits `GoalExecutionEnabled` **carrying** `graphEpoch`; the wire that
  hands an epoch to a revision already exists.
- `goal-validation.ts:228-238` — safe integer, `>= 0`, DRAFT implies 0, COMPLETED implies `> 0`,
  active implies `> 0`.

So the header note at `graph-revision-reducer.ts:5-7` ("`graphEpoch` authority lives in the goal
aggregate") is **accurate and current**. A graph revision may persist only a BOUND REFERENCE to the
epoch it was activated at. Moving the counter into the revision aggregate forks the authority.

Separately, `src/planning/graph-command-contract.ts` and `src/expansion/expansion-planning-hold.ts`
both already carry a `graphEpoch` field — they consume the goal's epoch, they do not own it.

## The narrow real gap
`goal-reducer.ts:40` admits `goal.activate_initial_graph` from `DRAFT` **only**. Nothing advances a
goal's epoch a second time, so in practice it is 0 or 1 forever. Supersession needs an advance
admitted from the live execution lifecycle that increments the epoch and rebinds
`activeGraphRevisionRef`. Filed as `task-aedcd01ad91245d9a036d9dac3b76a22`.

## Sizing trap for whoever plans that task
`goal-reducer.ts` is 247 physical lines and `goal-validation.ts` 245 — both at the 250 target with
no headroom, so that work splits a file rather than growing one. And note
`planning-source-size.test.ts` sweeps **`src/planning` only**: `packages/core/src/goal/` is
unguarded and `goal-reducer.test.ts` is already 300 lines. A green core suite proves nothing about
the per-file cap outside `src/planning` — see `mem:moe-core-line-cap-guard-is-planning-only`.

## Generalisation worth keeping
Before planning a "we need an epoch / counter / generation" task, grep the OWNING aggregate first.
On this board the counter usually exists and the real gap is a missing *transition* that advances
it — a much smaller and differently-shaped task than the one the description implies.
