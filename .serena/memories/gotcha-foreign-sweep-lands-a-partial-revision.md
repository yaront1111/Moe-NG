# A foreign whole-tree commit lands a PARTIAL revision of your file

Known hazard: the task-completion hook commits the whole tree, so a peer's commit captures
your in-progress files (project rail 5 — never amend it, never reset, never fake a claim).

The part that is easy to miss: it captures them **at whatever revision they were at that
instant**, and `git status` afterwards tells you almost nothing.

Observed 2026-08-15 on `task-1fb6e87110744bbea21aafc3ea891e8d`. After peer commit `6482e5f`:

```
 M packages/store/src/backup-generation-publish.ts     <- still dirty
 M packages/store/src/backup-generation.test.ts        <- still dirty
                                                       <- backup-generation.ts ABSENT
                                                       <- backup-generation-publish.js ABSENT
```

Two of my four owned paths had vanished from `git status` because their bytes were already
committed by someone else's task; a third was committed at a STALE revision (before a
null-deref fix) and only looked "modified" like any ordinary edit. Nothing distinguishes
"dirty because I have not committed yet" from "dirty because a foreign commit froze an
older revision of this file."

## What to actually do

1. `git ls-tree HEAD --name-only <dir> | grep <your prefix>` — find out which of your files
   are already IN a tree, regardless of who put them there.
2. `git show HEAD:<path>` and grep for a symbol you added LAST — that tells you whether the
   committed revision is current or stale. A path missing from `git status` means committed
   bytes == working tree; a path present means you still owe a commit.
3. Commit the remaining owned paths by explicit pathspec as normal. Do not try to
   "consolidate" the foreign commit.
4. Hand QA a **base-ref diff over owned paths**, not a commit sha:
   `git diff <merge-base>..HEAD -- <owned paths>`. See
   `mem:moe-finished-task-may-have-no-commit` — the inverse failure of the same hook.

Related: `mem:foreign-commit-can-revert-your-landed-deliverable`,
`mem:head-moves-mid-verification`, `mem:mutation-drills-in-shared-worktree`.
