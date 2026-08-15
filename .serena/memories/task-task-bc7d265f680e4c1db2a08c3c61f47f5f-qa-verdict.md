# QA verdict: store input decomposition (task-bc7d265f) — APPROVED

Commit `8618983`, verified 2026-08-07 by qa-91cf5a2f.

## Evidence re-run by QA
- `pnpm --filter @moe/store typecheck` exit 0; `pnpm --filter @moe/store test` exit 0 (19 files / 118 tests, vitest 4.1.10). Exit codes captured separately, not via a piped `$?`.
- `git show --stat 8618983`: exactly the 10 owned paths, +810/-485 = +325 net.
- `git diff 8618983..HEAD -- packages/store/src/store-input*` empty; worktree clean for owned paths (no drift from the 5 later commits).

## Verification technique worth reusing for decomposition tasks
Wrote a throwaway Node script (in the OS temp dir, never in the repo) that extracts every top-level `function`/`export function` block from `git show <commit>^:<file>` and from each new leaf, then diffs bodies by name. Result: old 19 / new 19, no adds, no drops, every body byte-identical except the one plan-approved line. This turns "did the refactor drift?" from a judgement call into a mechanical check.

Gotcha while doing it: in Git Bash on this box `/tmp` maps to `C:/Users/Yaron/AppData/Local/Temp`, but Node resolves a literal `/tmp/...` argument to `D:\tmp`. Write the script with the absolute Windows-style path, or use the Write tool against `C:\Users\Yaron\AppData\Local\Temp\...`.

## Confirmed state after approval
- Facade `store-input.ts` is 26 lines and re-exports exactly the original 18 names; all 11 consumers still import `./store-input.js` unchanged.
- DAG primitives(109) -> containers(104) -> commit(205) -> decision(112) -> facade; no leaf imports the facade, no cycle.
- Only semantic delta: `snapshotDenseArray` now checks `types.isProxy(value)` before `Array.isArray(value)`, so a revoked proxy fails closed as `STORE_INPUT_INVALID` instead of escaping an uncoded TypeError. Accepts no new shape.
- New `store-input-decomposition.test.ts` (250 lines) is the characterization net for this split — pins exact `CODE: detail` strings, evaluation order, defaults, duplicate/reserved IDs, copy isolation, frozen decision key, and the deferred-proposal byte-budget order described in `mem:gotcha-store-input-deferred-proposal`. Do not relax it in later store work.
- Four new `.js` bridges are one-line `export * from "./<name>.ts";`, matching the existing store-contracts.js / store-internals.js convention; `store-input.js` stayed byte-identical.
