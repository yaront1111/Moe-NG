# A foreign whole-tree commit can commit YOUR files before you do — measured, not theoretical

Epic rail 2 pins every agent to the single working directory `D:/projexts/moe-next`, so the
git index and worktree are SHARED STATE. `mem:mutation-drills-in-shared-worktree` notes a
neighbour's hook can commit your drill edit. Here is the full-strength version, hit live on
2026-08-09 by `task-f6440f26` (daemon .js bridges):

- I finished 19 new bridges + 2 test files, ran the gate green, then ran
  `git add -- <21 explicit paths>` → **exit 0** followed by
  `git diff --cached --name-only` → **EMPTY**, `staged_count=0`.
- Not an add failure. `git check-ignore` said not ignored, and `git ls-files` showed all 21
  paths already TRACKED. Between my last test run and my `git add`, the worker on
  `task-386fcb4c` had made commit `a6e46f6`, a **65-file whole-tree sweep** whose message reads
  `feat(task-386fcb4c...): Add package-wide .js runtime bridges to @moe/core`. It contains all
  21 of my `apps/daemon/**` paths.

## How to recognise it

`git add` exits 0 and stages NOTHING. That is the signature. Do not retry the add or start
debugging `.gitignore` — check `git log --oneline --diff-filter=A -1 -- <your path>` and
`git ls-files <your path>` first. Your content is already at HEAD under someone else's subject
line.

## What to do

You cannot fix it: epic rail 3 forbids reset, and rewriting a landed commit would destroy the
neighbour's work too. So:

1. `git log --oneline --diff-filter=A -1 -- <path>` — name the commit that captured you.
2. `git show --name-only --format='' <sha> -- <your dir>` — prove the sweep took ONLY your
   owned paths from your area and no foreign `.ts` service module rode along.
3. Verify the committed BLOBS, not the worktree: `git show HEAD:<path>` per file. A sweep
   commits whatever was on disk at that instant — if it fired mid-drill it would have captured
   a MUTATED file, and `git status` would then read clean while your restore never landed.
4. Report the SHA and the collision in the completion note. Do not claim you committed.

## The real lesson

Per-file pathspec protects the neighbour from YOU. It does not protect you from the neighbour.
The window between "gate green" and "git add" is the exposure, so close it: stage as soon as
the files are final, and re-verify blobs at HEAD afterwards rather than assuming your commit is
the one that landed them.

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-test-count-drift-from-uncommitted-foreign-file`.
