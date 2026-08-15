# Gotcha: `pnpm --filter <pkg>` gates prove nothing about `tests/**`, and nothing typechecks `tests/` by default

Two independent holes, both found by QA on task-18c7921f (Foundation executable
specification) and both reproducible today.

## Hole 1 — the package filter silently ignores everything outside the package

`packages/testkit/package.json` has:

```json
"test": "vitest run --root ../.. packages/testkit/src"
```

so `pnpm --filter @moe/testkit test` is a POSITIONAL path filter. A task owning
both `packages/testkit/src/foundation/**` and `tests/fault/foundation/**` filed
`exitCode: 0` evidence in which 3 files / 43 tests under `tests/` never ran at
all. They passed when run directly — the gate simply never looked.

**Rule (governor, msg-1ee68f0c):** a task owning paths under `tests/**` cannot
verify with a `pnpm --filter <pkg>` command. Check the glob covers every entry in
Owned paths. If it owns both package sources and `tests/**`, it needs two
commands and both tails as evidence.

Working precedent: the instruction-contract task owned `tests/instruction-contract/**`
and gated on unfiltered `pnpm exec vitest run tests/instruction-contract`.

Filing a `A && B && C` superset that STARTS with the declared command is accepted:
exit 0 then also proves the declared command passed.

## Hole 2 — no tsconfig in this repo includes `tests/`

There is no root `tsconfig.json` (only `tsconfig.base.json`), and each package
config is `include: ["src/**/*.ts"]`. `pnpm typecheck` is `pnpm --recursive
typecheck`, which only visits pnpm-workspace members; `tests/` has no
`package.json`, so it is invisible to the repo gate. 667 lines of owned test code
had zero static checking, which is exactly why it was written untyped.

**Fix that stays inside owned paths:** add `tests/<your-dir>/tsconfig.json`.

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false, "declaration": false, "declarationMap": false,
    "types": ["node"]
  },
  "include": ["./*.ts"]
}
```

`composite: false` is required. Test files under `tests/` import packages by
RELATIVE path (`../../../packages/core/src/index.js`), so those sources enter the
program as ordinary files, not as node_modules deps — and a composite project
demands every such file be listed in `include`. (Package-to-package imports
resolve through the node_modules workspace symlink, which is why `composite: true`
is fine inside `packages/*`.) Invoke with
`pnpm exec tsc --project tests/<dir>/tsconfig.json`; `pnpm -r typecheck` will not
find it.

## Why bother — this is not a formality

Turning it on produced 68 errors, and one was a live defect:

```ts
expect(late.ok).toBe(false);
expect(late.error.code).toBe("ILLEGAL_TRANSITION");  // TS2339 on GoalReducerResult
```

`expect(...).toBe(false)` is a runtime assertion; vitest does not narrow the
union with it. The day the reducer started ACCEPTING that command — the exact
regression the schedule exists to catch — line 2 would throw `TypeError` on
undefined instead of reporting a schedule failure. Narrow through a helper
returning `Extract<T, {ok:false}>` instead.

## Related

`mem:task-task-18c7921fb1f34a8cb1ed39509bf67a31-handoff` (the gate-coverage
ratchet that now enforces both holes stay closed),
`mem:gotcha-session-end-commit-sweeps-foreign-work`.
