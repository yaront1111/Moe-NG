# `git status --porcelain` answers "is anything untracked here", never "how much"

When a whole directory is untracked, porcelain collapses it to ONE line naming the
directory — not one line per file. Measured 2026-08-09 on `apps/control-room/src/styles/`
(10 files present, 0 tracked):

```
$ git status --porcelain apps/control-room/src/styles/
?? apps/control-room/src/styles/                     <-- 1 line

$ git status --porcelain -uall apps/control-room/src/styles/
?? apps/control-room/src/styles/base.css
?? apps/control-room/src/styles/chrome.css
... 10 lines total
```

## Why it bites

A partial sweep and a total sweep print the SAME collapsed `?? dir/`. If a foreign
whole-tree commit captures 4 of your 10 new files, the remaining 6 still render as one
`?? dir/` line — byte-identical to the state where nothing was committed. You cannot
count, diff, or attribute from that output, and the natural "did my deliverable land?"
check silently answers the wrong question.

Stacked blind spots on a new-directory deliverable, from worst to usable:

| Command | What it sees |
|---|---|
| `git diff -- <path>` | NOTHING — blind to untracked entirely. A drill-restore check reads clean over a fully mutated tree. |
| `git status --porcelain -- <path>` | Presence only; collapses the count. |
| `git ls-files -o --exclude-standard -- <path>` (or `--porcelain -uall`) | The only form that counts. |

## How to apply

- Completion check for a task landing a NEW directory: `git ls-files -o --exclude-standard -- <path>`
  must return `0`. `0` is what "fully committed" looks like; any non-zero count is
  uncommitted deliverable. Same command reads unambiguously in both directions.
- `git ls-files <path>` returning non-zero proves the path is TRACKED, not that the tracked
  bytes are the gated bytes — pair it with `git show "HEAD:$f" | sha256sum` vs `sha256sum "$f"`.
  See `mem:pattern-prove-your-bytes-landed-three-checks`.
- For mutation-drill restores on untracked files, checksum — never `git diff`. See
  `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
- Test-count evidence in a shared worktree should be a DELTA over a baseline you measured
  yourself, plus the named failing paths — an absolute total measures everyone's tree and
  moves when a foreign untracked directory appears or is swept.

Related: `mem:gotcha-broad-pathspec-commits-steal-untracked-work`,
`mem:gotcha-completion-hook-commits-whole-tree`.
