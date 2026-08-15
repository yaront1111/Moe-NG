---
title: Root vitest globs tests/**/*.test.ts into a node lane — name browser specs .spec.ts
---

# Anything named `*.test.ts` under `tests/` runs in the Node lane

Root `vitest.config.ts`:

```ts
test: {
  environment: "node",
  include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
  passWithNoTests: false,
}
```

and root `package.json:18`:

```
"test:e2e": "tsc -p tests/e2e/foundation/tsconfig.json && vitest run tests/e2e"
```

So **any** new `*.test.ts` under `tests/e2e/<anything>/` is swept into `test:e2e`
and executed **in Node, with no browser**. A browser spec named `.test.ts` there
fails in a way that looks like a broken test rather than a misrouted lane.

## The escape

Name browser specs **`*.spec.ts`** — Playwright's default, and invisible to the root
`include`. The two lanes then stay disjoint **by naming**, with no config surgery and
no change to `test:e2e`'s definition.

The corollary is useful, not just a workaround: a **pure-logic `*.test.ts`** in the
same directory is deliberately fine, and is the right home for lifecycle/reason-code
assertions — they run in the fast Node lane, and only the real journey pays for a
browser.

## Verify the separation in both directions

A one-directional check passes while the lane is broken:

- `pnpm test:e2e` still exits 0 **and runs the same file set as before** (no
  `.spec.ts` in its output)
- the browser script exits 0 **and actually ran a test** — many drivers report
  "0 tests" as success

## Two adjacent facts that surprise people

- `tests/e2e/foundation/tsconfig.json` has `include: ["./*.ts"]`, scoped to that one
  directory — the existing `tsc -p` leg will **not** typecheck a new sibling dir.
- `pnpm typecheck` is `pnpm --recursive typecheck` over **workspace packages**
  (`apps/*`, `adapters/*`, `packages/*`). `tests/` is not one, so nothing there is
  typechecked unless a script names it explicitly.

## Never reuse the foundation harness

`tests/e2e/foundation/e2e-harness.ts` states in its own header: *"This module is NOT
part of the system under certification and must never stand in for one."* Its
real-process kill capability in `e2e-process.ts` is deliberately fenced to that
directory. Mirror its `E2E_*` frozen-code and cleanup-in-`finally` conventions;
import nothing.

Related: [[task-task-667b1085b3e04915a88336c7424045a1-handoff]]
