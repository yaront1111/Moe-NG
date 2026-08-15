# Clean-vs-HEAD plus a fresh mtime means an ACTIVE committer, not settled bytes

Found 2026-08-09 planning task-aedcd01a against a dependency that was WORKING, not DONE.

## The wrong inference

`git status --porcelain <path>` returns empty, so the natural read is "nobody is touching
this, the surface is stable, safe to plan against." That inference is wrong in a shared
worktree where agents commit as they go.

Pair it with the mtime and the picture inverts:

```
git status --porcelain packages/core/src/planning/graph-revision-reducer.ts   -> EMPTY
stat -c '%y %n'        packages/core/src/planning/graph-revision-reducer.ts
  2026-08-09 21:55:40 +0300   =  18:55:40Z   <- eleven minutes before I looked
```

Clean **and** freshly written means the writer is committing incrementally. The bytes are
not settled; they are between commits. Every line number you pin goes stale before a
worker reads your plan.

## The three states, and how to tell them apart

| status | mtime | meaning |
|---|---|---|
| dirty | any | uncommitted work in flight — obvious, everyone catches this |
| clean | old | genuinely settled — safe |
| **clean** | **fresh** | **active committer mid-task — looks safe, is not** |

Only the third is deceptive, and `git status` alone cannot see it.

## Offset trap that hides it

Host mtimes here print `+0300`; board timestamps are UTC. `ls --time-style=+%H:%M:%SZ`
renders **local** time with a literal `Z` you supplied yourself, so a file written three
minutes ago reads as three hours old. Use `stat -c '%y %n'`, which prints the true offset.
A prior governor's "unowned" ruling on `apps/control-room/src/styles/` was made 17 seconds
after a write because of exactly this.

## When this justifies blocking

Not on freshness alone — on freshness **plus overlap**. Block when the file you must modify
is the file another live task is modifying, and the specific construct you must change is
the one their DoD put there. Then two plans rewrite one path in one worktree and the loser
silently loses bytes.

Make the block cheap: record the full measurement in a task comment (`report_blocked`
truncates at 2000 chars — see `mem:moe-qa-approve-summary-2000-char-cap`), state the exact
unblock condition, and hand over anything you measured that survives the wait — sizing,
verified symbols, an available non-overlapping split. A block that carries its own recipe
costs the next agent minutes instead of a full measure cycle.

## Corollary

A dependency task at status WORKING can have its surface fully landed on disk. Presence of
the symbol is necessary, not sufficient — check whether its owner is still moving.
