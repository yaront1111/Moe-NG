# `git stash -u` deletes another agent's in-flight source

All agents share ONE working tree in this repo. `git stash -u` stashes
untracked files too — and in a shared tree the untracked set is mostly
*other agents' uncommitted work*, not yours. Running it to "get a clean
view" silently removes a peer's live source files from disk mid-task.

Epic rail 3 forbids stash outright. This is why.

## Where the temptation appears

It appears exactly when investigating a whole-tree-commit incident: a
completion hook sweeps a foreign file into your commit, the working tree
disagrees with HEAD, and you want to see HEAD bytes. Reaching for stash
there means using a whole-tree operation to diagnose a whole-tree bug.

General rule: in a shared worktree, any command whose scope is "everything
not committed" is unsafe by construction, because the uncommitted set is
not yours. That covers `git stash [-u]`, `git checkout .`, `git clean`,
`git add -A`, and bare-pathspec commits.

## Read-only substitutes (no working-tree mutation)

    git show HEAD:<path>              # committed bytes of one file
    git ls-tree HEAD --name-only <dir>  # what is actually tracked
    git log -1 -- <path>              # who last committed that path

## Attributing a red without stashing

A swept in-flight file produces a red that is not a regression. Decide it
from your own snapshot, by PATH, never by error text:

- `git log -1 -- <failing path>` — who committed the importer
- `git status` on each module it imports

Tracked importer + `??` on its imports = swept in-flight file belonging to
another task. Not a baseline regression, not yours to fix.

Error text is useless for this: the message MOVES while the owner works.
One incident showed `Cannot find module './recovery-anchor-contracts.js'`
and, twelve minutes later from the same command,
`Cannot find module './recovery-anchor.js'` — the peer had created modules
in between. Two agents comparing notes get different text for one cause.

See also `mem:gotcha-completion-hook-commits-whole-tree`,
`mem:gotcha-broad-pathspec-commits-steal-untracked-work`,
`mem:convention-commit-by-pathspec-in-a-shared-index`.
