# A mutation-drill restore can silently fail, and the follow-up status can agree

Found by QA on task-ba3a45f96cda4db691233c4e45df2432, 2026-08-09.

## What happened

Mutation drill: edited `apps/daemon/src/work/work-claim.ts`, ran the suite (RED,
mutant killed), then restored with

    git checkout -- apps/daemon/src/work/work-claim.ts
    git diff --exit-code -- apps/daemon/src/work/work-claim.ts   # exit 0

The shell's cwd was `apps/daemon/src/work` from an earlier `Set-Location`, so the
repo-relative pathspec resolved to
`apps/daemon/src/work/apps/daemon/src/work/work-claim.ts`. Restore failed with
`error: pathspec ... did not match any file(s) known to git`, and the mutation was
still on disk. The verification then AGREED with the failure: `git diff
--exit-code -- <same wrong path>` matched nothing and exited 0, and
`git status --porcelain -- apps/daemon packages pnpm-lock.yaml` printed nothing
for the same reason. Two green checks, mutated production still in the tree.

## The rule

`git checkout|diff|status -- <path>` resolves the pathspec against the SHELL's
cwd, not the repo root, while `git status --porcelain` with NO pathspec always
reports repo-wide paths from the root. So:

- Verify a drill restore with UNSCOPED `git status --porcelain` and read the
  path, or run `git rev-parse --show-prefix` first and confirm it is empty.
- A scoped git command that prints nothing is ambiguous: it means "clean" OR
  "your pathspec matched nothing". Never read it as proof on its own.
- The Bash and PowerShell tools keep SEPARATE working directories, and each
  persists across calls. A `cd` in one does not move the other, and either can be
  deep in the tree by the time you run the restore.

Consequence in a shared worktree is worse than a lost minute: another agent's
whole-tree commit hook can capture the un-restored mutation
(`mem:mutation-drills-in-shared-worktree`).

Related: `mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
