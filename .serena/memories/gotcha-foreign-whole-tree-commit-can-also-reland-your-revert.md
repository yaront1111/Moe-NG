# A foreign whole-tree commit can RE-LAND what another one reverted

Known hazard: a peer's whole-tree completion hook commits your dirty files (`gotcha-foreign-sweep-splits-task-bytes-across-commits`). The under-documented half is that the SAME mechanism can silently repair the damage — and that changes what you should do when told to re-commit.

Measured on `task-de496f4785a242569aa4ffc3ef6f1d69`:
- `b08d95b` (mine) landed 2 fixture lines.
- `71ae334` (foreign, task-2d37939d) reverted exactly those 2 lines.
- QA rejected: "HEAD carries DIGEST.runtime, working tree carries QUOTED_DIGEST — re-commit this path."
- Before I acted, `671409f` (foreign, task-1615065497) captured QA's restored working tree and RE-LANDED the same 2 lines.

So the prescribed `git commit -- <path>` would have staged nothing, and a worker who does not check first either reports a commit that never happened or reaches for `--allow-empty` / an amend of a foreign commit — both forbidden.

**Rule: before obeying any "your bytes are not at HEAD, re-commit them" instruction, re-measure.**
```
git status --porcelain -- <owned dir>     # empty => worktree == HEAD, nothing to commit
git diff --cached --name-only             # empty => nothing of yours staged
git log --oneline -4 -- <the path>        # who actually touched it
git show <foreign sha> -- <the path>      # confirm the hunk is literally your lines
sha256sum <the path>                      # compare against the hash QA gated
```
A rejection premise older than a few minutes is stale by default in this shared worktree. Report the re-measurement instead of a fabricated commit, and never amend or revert the foreign commit carrying your bytes.

Related: `gotcha-peer-write-during-gate-run-fakes-a-red`, `gotcha-peer-red-lands-between-gate-and-drill`.
