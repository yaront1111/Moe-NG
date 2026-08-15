# A foreign whole-tree sweep splits ONE task's bytes across TWO commits

The known hazard is stated as "a foreign whole-tree commit captures your in-progress files". Observed
2026-08-14 on task-d23a913f: the sweep was **partial**, and that is the part that misleads.

Commit `d7a71cb` (task-5fa25bb3's completion hook) captured the three NEW UNTRACKED files plus three
MODIFIED ones, but left two other modified files dirty in the working tree. Result: one task's
deliverable lived half in a foreign commit and half uncommitted, and `git status` showed only the
uncommitted half.

## Why this reads as data loss and is not
At session start `git status --porcelain` listed 4 runner files as modified — but NOT
claude-launcher-contract.ts / -input.ts / -test-fixtures.ts, which earlier steps had definitely
edited, and NOT the three new claude-launch-selection.* files. The instinct is "my work was lost".
It was not. Check before reacting:

    ls <path>                                   # on disk?
    git ls-tree HEAD --name-only <dir>          # in HEAD?
    git log --oneline -2 -- <path>              # which commit added it?

Absent from `git status` + present in `git ls-tree HEAD` = already committed, by someone else.

## What NOT to do
Never amend the foreign commit, never reset, never `git stash`, never create an empty "claiming"
commit. Three peers hold uncommitted work in this shared worktree. `git checkout`/`stash -u` destroy
it — see `mem:git-stash-u-deletes-a-peers-untracked-work`.

## What to do
Commit your still-dirty owned paths by explicit pathspec as normal, then tell QA the bytes span two
commits and hand them a BASE-REF DIFF rather than a commit sha:

    git diff <merge-base>..HEAD -- <owned paths>

Verify peers are untouched afterward with `git status --porcelain` — their modified and untracked
files must all still be there.

Corollary for the reverse direction: a mutation-drill restore CANNOT be verified with `git diff` when
a foreign sweep has committed your file mid-task, because the file is now tracked and clean-looking.
Record `sha256sum` before the drill and `sha256sum -c` after — that is the only check blind to both
tracked/untracked state and to who committed what.

Related: `mem:moe-finished-task-may-have-no-commit`,
`mem:gotcha-git-diff-is-blind-to-untracked-paths`.
