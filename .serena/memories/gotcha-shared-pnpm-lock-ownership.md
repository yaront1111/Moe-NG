# Gotcha: pnpm-lock.yaml is shared state that no single task can own

Any task adding a workspace package lists `pnpm-lock.yaml` among its owned
paths. In the single shared checkout, two such tasks running concurrently both
add an entry, and whoever commits second — or first — sweeps the other's line.

Hit on `task-eca1a82ffa844c679d25a60ad8bd165e` (@moe/skills): by commit time the
lock held BOTH my `packages/skills` block and a foreign `packages/core` block
created by another task mid-work.

## Why you cannot just commit "your part"

`git commit -- <pathspec>` commits the **working tree** content of those paths
and ignores whatever is staged for them. So the usual trick — construct a
partial blob, `git add` it, then commit — does not work: the full working-tree
file is what lands. Committing the staged version instead needs a bare
`git commit`, which epic rail 3 forbids precisely because the index is shared.

`git add -p` is interactive and unavailable in this environment.

## What to do

Commit your source paths and LEAVE the lock dirty for its owners, then escalate.
Rationale:

- The hard rail ("preserve foreign work; commit only owned paths") outranks a
  plan's file list, which was written before the foreign entry existed.
- Nothing breaks. `pnpm install` regenerates the lock, and both the focused and
  repo-wide gates pass with it uncommitted.
- The foreign entry stays available to whoever owns that package.

Record the deviation explicitly in the step note and completion summary so it
reads as a decision, not an oversight.

## Related

`mem:gotcha-shared-tree-repo-gate` for the same shared-tree problem applied to
repo-wide test gates. `mem:gotcha-moe-wrapper-autocommit` for why untracked
strays anywhere under the repo root are dangerous.
