# Shared-tree repository gates versus parallel TDD

In the single shared checkout, an unrelated worker's correct RED phase can make `pnpm typecheck && pnpm test` fail for every other task. A repo-wide completion gate therefore serializes with all in-flight TDD tracks even when owned paths do not overlap.

Apply this safely:
- Keep the owned focused gate green and continue owned-path review; never patch or revert the foreign RED files.
- At completion, run the exact repo gate fresh.
- If it remains red solely in a named active task, report the task blocked with that task/path as `needsFrom`; do not claim success, silently wait, or weaken verification.
- Resume and rerun after the foreign owner reports its package green.

## Attribute by path BEFORE deciding it is foreign (2026-08-07, task-967769ea)

`moe.complete_task` hard-rejects a non-zero exit code, so "report it in the note" is not an
option — you must either reach green or `report_blocked`. Two cheap attribution commands
settle it in seconds:

```sh
pnpm exec tsc --project tsconfig.json 2>&1 | sed 's/(.*//' | sort -u   # unique failing files
pnpm exec tsc --project tsconfig.json 2>&1 | grep -c "src/<my-subtree>" # must be 0
git status --porcelain -- packages/<pkg>/src                            # who owns the path
```

Observed live: `pnpm --filter @moe/scheduler typecheck` went red with both errors in the
untracked sibling `src/admission/admission-pass.test.ts` (a correct RED importing a
not-yet-written module) while `src/authority` had zero errors.

## Foreground polling beats blocking, and some reds are transient

A one-shot session dies when the turn ends, so never end the turn "waiting". Poll in the
foreground with a bounded background job you await in-session:

```sh
until pnpm --filter @moe/<pkg> typecheck >/dev/null 2>&1; do sleep 20; done
```

Commit your own owned paths FIRST — the commit is independent of the foreign gate, so
nothing is lost if the wait times out and you must `report_blocked` after all.

Also expect genuinely transient failures: a full root `pnpm test` caught a sibling's file
mid-write and reported `1 failed | 1312 passed`, then went `92 files / 1313 passed` on an
immediate rerun with no change from anyone. Re-run once before concluding anything about a
root-level red; only a red that reproduces is real.