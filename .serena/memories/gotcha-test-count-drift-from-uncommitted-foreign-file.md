# Test-count drift can come from an UNCOMMITTED foreign file — attribute it before judging

A DoD of the form "the pre-existing suite passes with the same test count as before this task"
looks falsified the moment the total moves. In this repo the total moves for reasons that have
nothing to do with the task under review, because **epic rail 2 pins every agent to the one
working directory `D:/projexts/moe-next`**. Another task's IN-PROGRESS, still-uncommitted test
file is in your tree and its cases run in your gate.

Real case, `task-8ee125d0f05f4966abfcc49db37bbbf5` (scheduler root surface):
worker measured 567; QA measured **587**. Nothing regressed, nothing was added by the task.

## Attribute it in two commands, then decide

```sh
# 1. did any COMMIT touch the package after the task's commit?
git log --oneline <taskCommit>..HEAD -- packages/<pkg>/src        # EMPTY here

# 2. what is uncommitted in that package right now?
git diff --stat -- packages/<pkg>/src
#   packages/scheduler/src/package-boundary.test.ts | 204 ++++++++++-   <-- FOREIGN, the whole +20
```

Then close the arithmetic by measuring the task's own new file ALONE:

```sh
npx vitest run --root . packages/<pkg>/src/<new>.test.ts     # -> 48 tests
```

`587 − 48 = 539 pre-existing`; `539 − 519 baseline = 20` = exactly the foreign uncommitted file.
Fully attributed, so the count DoD holds and the drift is not a rejection reason.

## Why it matters both ways

- **Do not reject** on raw count drift — you would be rejecting a task for a neighbour's WIP.
- **Do not wave it through** either. An unexplained delta is exactly what a real regression looks
  like. The reject/approve line is whether every case is attributed to a named cause.
- Corollary: a suite can be GREEN in the working tree only because of an uncommitted foreign fix
  (here, the reworded doc comment in `packages/runner/src/supervisor/effect-test-fixtures.ts` that
  silenced `package-boundary.test.ts`). That is the neighbour's business, not the reviewed task's —
  but record it, because the committed tree alone would still be red.

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-scheduler-boundary-test-matches-prose`.
