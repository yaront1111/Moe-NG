# Gotcha: passing the <=400 line module rail can still fail QA on task size

Two separate limits exist in this repo and they are easy to conflate.

- **Epic rail (per file):** each production source targets <=250 lines, hard split before 400.
- **QA bar (per task):** >400 **net changed LOC across the whole commit** is rejected as oversized.

A task can satisfy the first perfectly and still fail the second by an order of magnitude.

## Concrete case

`task-1ade51c0` "Planning graph lifecycle core" (epic-bd387eeb, M1 Foundation Preview),
commit `bcdc2f6`. Every production module was compliant (115-368 lines, 9 modules), the
gate was green (`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test`,
exit 0, 189/189), all 4 DoD items had located evidence, and the tests were verified
mutation-resistant. It was still **rejected**: +3116 / -0 LOC across 13 files, 7.8x the bar.

The runtime had already warned at plan submission — *"Plan touches 10 distinct files
(target <=5); plans over 10 are rejected"* — and the plan shipped at 13 files anyway.
That warning is the cheap early signal; heed it at planning time.

## Rules of thumb

- **Architect:** if a plan names two aggregates that never call each other, it is two tasks.
  Splitting costs minutes at planning and a full review cycle after 3k lines land.
- **QA:** compute `git show --numstat` net LOC *before* deep review. Size is a batch rule,
  not a quality rule — "the code is good" is exactly the argument that erodes it.
- **Reject wording matters:** an oversize reject is not a defect reject. Say so explicitly,
  record every verified-good finding as "PASS (no action)" so the worker does not redo
  correct work, and state plainly that the landed commit must NOT be reverted — the remedy
  is architect-side re-scoping along the seam that already exists in the code.

## Reusable split heuristic

Split on the seam the code already has. Here it was:
A) planning-run aggregate (~1062 prod LOC) · B) graph-revision aggregate (~530 prod LOC)
C) cross-aggregate invariants + root index exports.

## QA technique worth repeating

Mutation-test the DoD-critical guards instead of trusting green output: weaken the guard
(`bearing.length > 1` -> `> 2`), run the suite, confirm tests actually die, then
`git checkout -- <path>` to revert. Cheap, and it distinguishes real coverage from
decorative assertions. Requires the file to be committed first so the revert is safe.

See also `mem:gotcha-contracts-guards-not-exported`.
