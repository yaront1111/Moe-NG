# @moe/scheduler cannot import @moe/core or @moe/contracts — and that is by design

Measured 2026-08-10 while planning task-069853689ed643988cfec2d689f7edb7.

## The trap
A published export on the `@moe/core` package ROOT looks like a green light to compose it from anywhere.
It is not. `grep` proves the SYMBOL exists; it says nothing about the DEPENDENCY EDGE. An architect can
verify `packages/core/src/index.ts:239-242` exports `SUPERSESSION_DISPOSITION_KINDS` symbol by symbol,
write a plan that mandates importing it from the package root, and still hand the worker something that
cannot compile.

## The measurement
```
packages/scheduler/package.json  dependencies = { "@moe/context": "workspace:*" }   # entire list
ls packages/scheduler/node_modules/@moe/                                            # -> context  (only)
tsconfig.base.json                                                                  # no "paths" key
```
Every route is closed, probed not inferred:
- `from "@moe/core"`      -> `error TS2307: Cannot find module '@moe/core' or its corresponding type declarations.`
- `from "@moe/contracts"` -> `error TS2307: Cannot find module '@moe/contracts'...`
- `from "../../../core/src/index.js"` -> `error TS6059: File '.../core/src/goal/goal-contract.ts' is not
  under 'rootDir' '.../packages/scheduler/src'` — and it cascades over the whole core tree, one error per file.
- `@moe/context` (the one declared dep) re-exports only its own 5 modules. Core is not transitively reachable.

Real dependents of `@moe/core` today: `packages/review`, `apps/daemon`. Not scheduler.

## SUPERSEDED 2026-08-10: the edge now EXISTS
Governor-42b952c9, on human direction, ruled the absence an oversight and authorised adding both
deps. Landed at commit `72d7fb5`: `packages/scheduler/package.json` dependencies are now
`{ "@moe/context", "@moe/contracts", "@moe/core" }`, all `workspace:*`, and
`packages/scheduler/node_modules/@moe/` holds all three. TS2307 is gone; the probe above no longer
reproduces. `packages/scheduler/src/supersession/` imports `SUPERSESSION_DISPOSITION_KINDS` from the
`@moe/core` root and `RUNTIME_ERROR_CODES` / `RUNTIME_LIFECYCLES` from the `@moe/contracts` root.

The deciding evidence was `package-boundary.test.ts:265`, which lists
`import { decode } from "@moe/contracts";` in its ALLOWED fixtures — the landed boundary suite
positively permits the import, so no rail was violated by closing the gap.

WHAT SURVIVES: the measurement TECHNIQUE (grep proves the symbol, never the dependency edge — probe
with a two-line file and the package typecheck), and the per-module prose below, which is now a
per-module choice rather than a package-wide wall.

## It WAS documented as deliberate — read this as history, not as current policy
Scheduler documents the absence in prose, twice:
- `packages/scheduler/src/budget/budget-measurement.ts:15` — "No @moe/core or @moe/contracts import — the
  projected budget fact mirrors PolicyFactInput structurally (policy-contract.ts:68-72) for a future
  composition boundary and this module evaluates no policy."
- `packages/scheduler/src/budget/budget-reservation.ts:13` — "@moe/core is not imported by design and no
  policy is re-evaluated"; `:8` — "ADMISSION_PURPOSES is LOCAL, not the contract reserve vocabulary".

So the LANDED convention is: mirror core/contracts vocabulary locally with locally-owned issue codes, so
"which layer refused" stays separately assertable. Adding the edge is an ARCHITECTURE decision, not a
mechanical worker fix — and it collides head-on with any rail that forbids "forking the vocabulary".

## Do not mistake the boundary test for the obstacle
`packages/scheduler/src/package-boundary.test.ts` guards INBOUND imports of scheduler internals
(`@moe/scheduler/...` deep specifiers). It lists `import { decode } from "@moe/contracts";` in its ALLOWED
fixtures at `:265`. It would not stop the import. The missing manifest edge is what stops it.

## What to do
Probe before planning: write a two-line file importing the bare specifier and run the package typecheck.
Costs one minute, and TS2307 is unambiguous. The fix needs the package manifest (usually NOT in a task's
owned paths) plus a repo-wide `pnpm install` — outward and shared-worktree-hostile, so it belongs in its
own prerequisite task, never inline.

Related: `mem:gotcha-package-root-ts-entry-needs-no-js-bridge`.
