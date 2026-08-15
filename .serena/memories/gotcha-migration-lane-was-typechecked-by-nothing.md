# `tests/migration/` had no tsconfig — the lane was typechecked by nothing

Fixed in commit `47739ed` (2026-08-15), but the SHAPE of the bug recurs.

There is **no root `tsconfig.json`** in moe-next. `pnpm typecheck` is
`pnpm --recursive typecheck`, i.e. workspace packages only. Every `tests/*`
subtree is therefore typechecked **only** if it carries its own tsconfig and a
script that runs `tsc -p` on it. Before this commit `tests/migration/` had
neither, so the already-committed `import/import-determinism.test.ts` — and
anything anyone added next to it — compiled under nothing at all.

Generalises `mem:integration-tests-are-typechecked-by-nothing`. Check any
`tests/<lane>/` you are about to write into:

    ls tests/<lane>/tsconfig.json && grep '"test:<lane>"' package.json

## The lane recipe that works
`tests/<lane>/tsconfig.json` byte-identical to `tests/security/tsconfig.json`:
extends `../../tsconfig.base.json`, `composite/declaration/declarationMap` false,
`types: ["node"]`, `include: ["./**/*.ts"]`. Script, `&&` never `;`:

    "test:<lane>": "tsc -p tests/<lane>/tsconfig.json && vitest run --config tests/<lane>/vitest.config.ts"

## Prove the include is not vacuous, or you have changed nothing
A tsconfig whose `include` misses the new subdirectory leaves the lane exactly as
unchecked as before, silently. Drop a deliberate error INSIDE the new subdir and
require tsc to name that path:

    tests/migration/cutover/typecheck-probe.ts(1,7): error TS2322: ... EXIT 1

then delete the probe in the same command and re-run for EXIT 0.

## Two lane facts that bite
- `tests/` carries **ZERO `.js` bridges** — `find tests -name '*.js'` is empty —
  yet `tests/fault/foundation/*.test.ts` imports `"./foundation-harness.js"`.
  The `.js` specifier with no file on disk IS the convention here. Do not add a
  bridge. (`packages/*/src` is the opposite: real bridges exist there.)
- Root `vitest.config.ts` includes `tests/**/*.test.ts` with
  `passWithNoTests: false`, so a `*.test.ts` in any lane ALSO runs under plain
  `pnpm test`. Pick the suffix deliberately: `tests/fault` and `tests/security`
  use private `*.fault.ts` / `*.security.ts` suffixes precisely to stay OUT of
  the root suite.
