# A uniform random walk cannot carry an outcome-kind SET EQUALITY assertion

Observed 2026-08-09 on `apps/daemon/src/work/work-race-orderings.test.ts`
(task-49acb856), and it is the same lesson the runner harness recorded as
"drain and restart inputs are STRATIFIED pools, not uniform random".

## The failure

5 seeds x 400 steps = 2000 steps over a 7-command alphabet and 13 tamper arms
at 70/30 honest/tamper reached 16 of the 19 declared outcome kinds. The three
missing ones — `WORK_SLOT_EXHAUSTED`, `WORK_SLOT_RESOURCE_INACTIVE`,
`WORK_BUDGET_REFUSED` — sit behind a CONJUNCTION: the walk must draw `claim`,
AND the tampered arm, AND that specific arm, AND be standing on an ACTIVE
lease. That is roughly one step in four hundred per cell. Set equality would
have been decided by the seed.

Raising steps or adding seeds does not fix this honestly — it just buys a
different seed's luck, and the fix is invisible in review.

## The fix, in two parts

1. **Stratify by relevance.** Mark arms that only one command reads
   (`claimOnly`) and draw them only for that command. Uniform draws waste 6/7
   of them as no-ops.
2. **Enumerate the cross product as its own pass.** Run
   `commands x tampers x poolMembers` (7 x 13 x 6 = 546 cases) alongside the
   walk and union the observed kinds. Assert the generated count equals that
   product — epic rail 6: a sweep that silently produces zero cases passes
   while testing nothing.

Keep the walk. The sweep covers CELLS; only the walk covers ORDERINGS, world
advance, and duplicate delivery, which are one-step-per-cell blind.

## Also

- `Object.freeze({...})["constructor"]` resolves on `Object.prototype`. Putting
  `"constructor"` in the command alphabet is worth it — it caught a bare index
  lookup in my own legal-states table (`legalStates.includes is not a
  function`), which is the exact trap `work-lifecycle.ts` documents in
  production. Use `Object.hasOwn`.
- Vitest v4 hides `console.log` from PASSING tests. `--silent=false` did not
  help; `--reporter=verbose` does. Needed when a per-kind count table is the
  evidence a reviewer must read.

Related: `mem:task-task-49acb856ec064b2ea528450d15744ee9-handoff`,
`mem:gotcha-lfsr-low-bits-hide-tamper-arms`.
