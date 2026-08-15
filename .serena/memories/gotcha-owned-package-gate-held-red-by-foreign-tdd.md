# A foreign TDD loop in YOUR package hard-blocks complete_task

## The situation

All agents share one working directory (`D:/projexts/moe-next`, epic rail 2 forbids
sibling worktrees). When another agent is doing test-first work in the SAME package
your task gates on, their red-phase test files sit uncommitted in the tree and your
`pnpm --filter <pkg> test` returns exit 1 through no fault of your diff.

`moe.complete_task` validates `verification.exitCode === 0` mechanically. So you
cannot complete, and you must not fabricate a pass (epic rail 4).

## Why project rail 3 does NOT rescue you

Rail 3's path-attributed baseline discounts foreign red in packages the task does not
own, but it still requires "the owned-package legs are exit 0". It has no clause for a
foreign agent editing OTHER paths INSIDE your owned package. In a single shared
worktree that is the normal state, not an edge case.

Observed 2026-08-09 on `task-ddb3bf77` (@moe/control-room): a foreign agent landed
untracked `src/styles/`, `src/preview/`, `src/shell/shell-chrome.tsx`,
`src/app-composition.tsx` and modified `kernel/main/scaffold/frame/nav-rail` while the
task's own diff was one leaf test file. Gate oscillated 550→553→562(green)→567(red)
across ~30 runs in 20 minutes.

## What to do

1. **Measure before you claim innocence.** Revert YOUR files alone to their HEAD bytes
   (`git show HEAD:<path> > <path>`, after backing up your version), re-run the gate,
   and confirm the same failures in the same foreign paths. That is rail 3's
   (2)-minus-(1) delta and it is the only evidence that distinguishes "foreign red"
   from "I broke it". Restore your version and verify by `sha256sum`.
2. **Poll the gate in a bounded loop**, not with sleeps:
   `for i in $(seq 1 10); do out=$(pnpm --filter X test 2>&1); [ $? -eq 0 ] && break; done`
   Each run is ~30s, which is its own spacing. Windows DO open — capture the green
   output the instant it appears, because it can close again.
3. **Run your owned-path specs directly** as positive evidence:
   `pnpm --filter X exec vitest run <your paths> <tests you must keep green>`.
4. If the red persists, `report_blocked` with the delta measurement, not a complaint.

## Hard limits that bit during this

- `report_blocked` `reason` caps at **2000 characters** and rejects AFTER you have
  written the whole thing. Draft to ~1900 and put the long form in `chat_send`
  (10KB limit).
- `git checkout -- <path>` cannot restore an UNTRACKED file and will destroy your
  uncommitted work on a tracked one. Back up to `/tmp` (outside the repo, so no
  scratch file lands in a commit) and restore by `cp`.
- Restoring a file with `cp` makes the harness report "file modified on disk since you
  last read it" on the next `Edit`. Harmless, but do not read it as a foreign edit.
