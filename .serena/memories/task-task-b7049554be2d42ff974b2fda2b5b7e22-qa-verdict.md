# QA verdict task-b7049554 — @moe/context + @moe/review runtime bridges: APPROVED

Verified by qa-017ee6b6 2026-08-09 against tracked bytes (`git show HEAD:<path>`), not worktree files.

## What I independently re-derived (not taken from worker evidence)

- Module sets from `git ls-files`: context 8 production `.ts`, review 6. Matches the 8/6 in the task description. No `*-test-fixtures.ts` / `*-test-helpers.ts` in either package.
- Tree delta `a6e46f6^ -> HEAD`: context test files 4 -> 5, bridges 0 -> 8; review 2 -> 3, bridges 0 -> 6.
- Path-limited diff `git diff --name-status a6e46f6^ a6e46f6 -- packages/context/src packages/review/src`: 16 entries, all `A`, zero `M`, zero `.ts` touched.
- Byte audit of all 14 blobs via `xxd -p`: every one exactly `export * from "./<own-basename>.ts";` + `0a`, `has0d=no`, 1 line, blob and worktree both EXACT. Zero MISSING, zero UNEXPECTED, zero test-file bridges.
- Plain-Node v24.16.0 probe from repo root: context 19 exports / 0 undefined, review 23 / 0, scheduler regression control 36 / 0, negative control `code=ERR_MODULE_NOT_FOUND literal_match=true`.
- Focused gates fresh: context typecheck 0 + 5 files/24 tests; review typecheck 0 + 3 files/91 tests.

## The two techniques worth reusing

**1. Audit tracked bytes, never worktree bytes.** In this shared worktree an untracked-but-present bridge makes a worktree audit pass while a clean checkout is still broken. `git show HEAD:<path> | xxd -p` is the only honest source. See `mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.

**2. Non-vacuity drill without mutating the repo.** Deleting a tracked bridge to prove the regression test goes red is unsafe here — a foreign whole-tree hook can commit the deletion (`mem:mutation-drills-in-shared-worktree`). Instead kill the *resolution*, not the file, with `node:module` `registerHooks`:

```js
registerHooks({ resolve(spec, ctx, next) {
  if (spec.endsWith("context-contract.js")) { const e = new Error("drill"); e.code = "ERR_MODULE_NOT_FOUND"; throw e; }
  return next(spec, ctx);
} });
```

Run the child with `--import <hookUrl>`; control run without it. Result: control `{"outcome":"IMPORTED","probe":"function"}`, drill `{"outcome":"FAILED","code":"ERR_MODULE_NOT_FOUND"}`. Proves the bridges are load-bearing and the test's assertion shape actually flips. Zero files touched.

Corroborating static proof: every production `.ts` imports siblings as `./x.js` (11x `review-contract.js`, 7x `context-contract.js`, ...), and Node has no `.js` -> `.ts` fallback under `--experimental-strip-types`.

## Attribution

Owned files landed inside foreign whole-tree hook commit `a6e46f6`, titled for task-386fcb4c, 65 files total. `git log --all --grep=b7049554` returns nothing — this worker never got to commit by pathspec because the hook preempted them. Not a rail-3 violation by the worker; they flagged it. Same disposition as the task-386fcb4c approval. Do not revert, do not manufacture a no-op commit.
