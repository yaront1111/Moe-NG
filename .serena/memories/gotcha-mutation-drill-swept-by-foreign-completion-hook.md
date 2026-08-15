# Gotcha: an in-place mutation drill can be COMMITTED by another agent's completion hook

Happened 2026-08-09 during QA of `task-f837ce45` (@moe/coordination).

## What happened

QA ran 8 mutation drills to prove failure-path tests go red: for each, `perl -0pi -e`
mutated one production line, `pnpm --filter @moe/coordination test` ran, then
`git checkout -- <file>` restored it. All 8 went red correctly.

Minutes later the gate was RED with `git status --porcelain packages/coordination` showing
CLEAN. Cause: `md5sum` of the working file matched `HEAD` — because **HEAD had changed**.
A parallel agent finishing `task-1e512b95` triggered the whole-tree completion hook
(`mem:gotcha-completion-hook-commits-whole-tree`), and commit `c42b578` swept the tree
*while a mutation was applied*, capturing `coordination-parts.ts` with
`if (field(value, "advisoryOnly") === 12345)` in place of `!== true`.

`git checkout -- <file>` then restored the *mutated* blob, so the damage was invisible to
`git status`. The only signal was the failing test.

## Rules for mutation drills in this repo

Epic rail 2 pins every agent to the single working directory `D:/projexts/moe-next`, so the
worktree AND the index are shared and any agent may commit the whole tree at any moment.

1. **Prefer a non-mutating proof.** Assert the code/layer pair and the generated case count;
   only reach for an in-place mutation when nothing else proves the assertion is live.
2. If you must mutate: **record the blob sha first** (`git rev-parse HEAD:<path>`), and after
   restoring, verify against THAT sha, not against `git status`.
   `git status` compares to HEAD; if HEAD moved, it lies.
3. **Keep the mutated window as short as possible** — one file, one test run, restore before
   the next drill. Never leave a mutation applied across a slow command.
4. **Re-run the full gate after the last drill.** A green pre-drill gate is not evidence the
   restore worked. This is what caught it here.

## Recovery that worked (no reset, no revert of foreign work)

```
git checkout <last-good-sha> -- <damaged path>     # stages only that path
git status --porcelain                             # confirm nothing foreign staged
git commit -- <damaged path>                       # explicit pathspec, rail 3
git diff --stat <last-good-sha> HEAD -- <owned dir>  # blank == parity restored
```
Restoration commit `a3c16f0`; parity with the worker's delivered state (`34a3d11`) confirmed
blank. The foreign work inside `c42b578` was left untouched.

Related: `mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-shared-git-index-amend-captures-foreign-work`.
