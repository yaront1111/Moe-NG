# A peer writing a file DURING your test run reddens a gate that is actually green

Observed 2026-08-14 in the shared worktree `D:/projexts/moe-next`.

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` came back
`Test Files 1 failed | 57 passed`, `Tests 2 failed | 1825 passed`, exit 1 — at 12:01:33.
The immediately preceding run (11:58) and the immediately following one (12:02) were both
`58 passed / 1827 passed`, exit 0, with `git rev-parse HEAD` unchanged and
`git status --porcelain -- packages/runner` EMPTY at every point.

Cause: `packages/runner/src/providers/claude/claude-launcher-authority.ts` had
`LastWriteTime 12:01:37` — a peer agent wrote it *while vitest was importing modules*.
vitest read a half-written or transiently different file. Nothing was wrong with the tree
before or after.

## Why this is dangerous in both directions
- Reported as-is, it fakes a red and can bounce a finished task back to WORKING.
- Waved away as "flaky", it can also hide a real regression.

## The check that distinguishes them
Do NOT re-run and shrug. Establish which:
1. `git rev-parse HEAD` before and after — if HEAD moved, it is [[head-moves-mid-verification]], a different problem.
2. `git status --porcelain -- <package>` — if clean at both ends, no committed or working-tree
   change can explain a differing result.
3. `Get-ChildItem -Recurse -File <pkg>/src -Include *.ts | Sort LastWriteTime -Desc | Select -First 5`
   and compare the top mtime against the run's `Start at` timestamp, which vitest prints.
   A write timestamped INSIDE the run window is the answer, and it names the peer's file.
4. Re-run at least twice more and report the counts of every run, not just the green one.

Only after 1-3 all point at a mid-run foreign write is "transient, not reproducible" an honest
verdict — and it still gets disclosed verbatim with the failing counts, never silently dropped.

## Prevention
Before the completion gate, wait for the package to go quiet: poll the max `LastWriteTime`
under `<pkg>/src` until it is >=120s old. That same wait is what turned this task's gate from
exit 1 to exit 0 in the first place. See `mem:mutation-drills-in-shared-worktree` for the
related hazard of a peer's commit hook capturing your in-flight bytes.
