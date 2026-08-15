# A sibling's TDD-red spec blocks YOUR owned-package gate — and clears itself

## The shape
The path-attribution rail rescues **repo-wide** legs only. An owned-package leg
(`pnpm --filter @moe/core test`) must exit 0 outright. In a shared worktree, any sibling
task doing TDD inside your package puts a red spec in your gate's scope, and
`complete_task` refuses. Your diff is perfect and you still cannot finish.

Worse, an **untracked** red spec is invisible to `git diff` and collapses in
`git status --porcelain` under its directory entry — so the failing file may not appear
in any diff you inspect.

## Why it is not your problem to fix
Never absorb the sibling's bytes, never amend their commit, never delete their spec.
The correct move (taken on task-fcad40b6d2 at 16:41Z) is: commit and clean your own paths,
then `report_blocked` naming the exact three conditions that must flip.

## The part that is easy to get wrong on resume
Such a block is **state-shaped, not defect-shaped**. On resume, re-measure each named
condition before writing anything:
1. sibling task status is DONE,
2. `git ls-tree HEAD <sibling spec>` lists it (committed, not untracked),
3. `git status --porcelain <shared file>` is EMPTY (shared file released).

When all three are false, the entire remaining work is running the gate. The 2026-08-09
resume of task-fcad40b6d2 wrote zero bytes and exited 0 first try. Reopening the editor
because a task "was blocked" is how a clean task acquires a regression.

Related: `mem:owned-package-gate-red-is-a-block-not-a-disclosure`,
`mem:gotcha-untracked-dir-declared-unowned-may-be-mid-write`.
