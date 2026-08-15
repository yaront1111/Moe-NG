# Gotcha: runner/testkit leak TEMP fixtures -> repo-wide `pnpm test` red on Windows

Observed 2026-08-08 during task-7617c00d. **This is foreign red. Do not block on it,
do not "fix" it from an unrelated task, and do not assume it is your regression.**

## READ THIS BEFORE QUOTING ANY NUMBER FROM THIS FILE (added 2026-08-08 18:20)

**Never copy the failure count below into a plan, a rail, or completion evidence.**
It is a snapshot of one non-deterministic run, not a baseline. I did exactly that —
put "root `pnpm test` is known red with 11 pre-existing failures in packages/runner
and packages/testkit" into step 9 of `task-791d7340`'s plan — and governor-eae4fc53
measured it hours later:

```
npx vitest run --root . packages/testkit  ->  18 files, 234 tests, ALL PASS
npx vitest run --root . packages/runner   ->  8 passed | 1 failed, 239 tests pass
```

`packages/testkit` was **completely green**, and the single `runner` failure was a
different file entirely (`supervisor/effect-activation.test.ts`,
`Cannot find module './effect-activation.js'`) — another task's TDD red phase, not
this leak at all. A frozen count is a blindfold: it licenses ignoring red that is
genuinely yours, and QA will diff "11 known failures, ignored" against a green
package and hand you the discrepancy.

**Attribute foreign red by PATH OWNERSHIP, never by count.** Name the failing file,
confirm the owning task is still in flight, and investigate anything else.

## Symptom
Root `pnpm test` can exit 1 with failures confined to two files:
- `packages/runner/src/scope/scope-observation.test.ts`
- `packages/testkit/src/phase0-node-capture-port.test.ts`

Errors are **`Test timed out in 5000ms`** and
**`EBUSY: resource busy or locked, rmdir <TEMP>\moe-phase0-port-*\source`** —
never an assertion failure. One test burned 23821ms against a 5000ms limit.
If you see an assertion failure or a different file, it is NOT this.

Root `pnpm typecheck` stays exit 0.

## Cause
Those fixtures build real git worktrees and NTFS junctions under `%TEMP%` and leak
them. They accumulate: 73 stale `moe-phase0-port-*` dirs and 496 `moe-*` dirs were
present when this was diagnosed. On Windows the junction/worktree handles keep
directories locked, so `rmdir` hits EBUSY and setup blows the 5s timeout.

Consequence: it is **load- and history-dependent, not deterministic**. The same
suite was green earlier the same day and red an hour later at the same HEAD — which
is precisely why the count above must never be treated as standing state.

## How to prove it is not yours (do this, don't hand-wave)
If your only delta is untracked/uncommitted, move your files out-of-tree so the
tree is byte-identical to HEAD, re-run just the two files, and compare:
```sh
npx vitest run --root . packages/runner/src/scope/scope-observation.test.ts \
                        packages/testkit/src/phase0-node-capture-port.test.ts
```
Identical failure count at pristine HEAD => pre-existing. Restore and verify with
`git hash-object` before/after (`mem:gotcha-mutation-testing-restore-safety`).

Also refute the tempting hypothesis first: these tests operate on **their own TEMP
fixtures, not the real repo**, so your untracked files cannot change their
porcelain output — even for the test literally named "captures exact Git identity
and raw porcelain-v2 status bytes".

## Don't mass-delete the TEMP dirs
The tree is shared and siblings run concurrently; some `moe-*` dirs may be live
in-flight fixtures. Cleanup belongs to whoever owns runner/testkit.

Related: `mem:gotcha-shared-package-gate-broken-by-sibling-red-file`,
`mem:gotcha-sibling-task-liveness-before-blocking`.
