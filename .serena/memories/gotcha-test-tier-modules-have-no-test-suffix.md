# Gotcha: "test-only" is a CLOSURE, not a filename suffix — five modules prove it

Found on `task-eb9ff081` (2026-08-08) while sweeping `.js` runtime bridges across
`@moe/runner`. The repo convention says test-only modules are `*.test.ts`,
`*-test-fixtures.ts`, `*-test-helpers.ts` and get **no** `.js` bridge. That list is
incomplete, and the gap is invisible until you run plain Node.

## The five

`packages/runner/src/supervisor/` contains `race-harness.ts`, `race-scenarios.ts`,
`race-restart-scenarios.ts`, `race-steps.ts`, `race-world.ts`. They match **none** of the
three suffixes, so a literal reading of the convention says bridge them. Bridging them
produces five committed files that cannot load:

```
ERR_MODULE_NOT_FOUND
Cannot find module '...\supervisor\effect-test-fixtures.js'
  imported from '...\supervisor\race-scenarios.ts'
```

Four import `./effect-test-fixtures.js` directly; `race-harness` reaches it through
`race-scenarios`. `effect-test-fixtures.ts` correctly has no bridge, so anything that
imports it is unloadable under Node **by construction**.

## Why you cannot "just make them pass"

Only two ways, both forbidden: bridge `effect-test-fixtures.ts` (drags test code onto the
runtime surface), or edit the `.ts` to drop the fixture import (behaviour change, and the
bridge task owns no `.ts`). Deleting a bridge that should never have been written is the
only move that violates nothing.

## The rule that actually works

Compute the transitive closure instead of matching names:

> A module is test-tier if its NAME matches the three patterns, **or** it imports a
> test-tier module directly or transitively.

Over `@moe/runner` at the time: 78 `.ts` total, 28 excluded by name, **5 by dependency**,
45 bridged. Two independent methods agreed on the same five — a per-entry-point runtime
probe found them by failing, and the static closure found them without executing anything.
That agreement is the evidence; either alone is weaker.

## Confirm the tier before deleting a bridge

Consumer analysis is stronger than a suffix. For all five: every consumer outside the
cluster is a `*.test.ts`; no non-test, non-race module imports any of them; and
`index.ts` never references them, so they are not on the published surface.

## Two traps

1. **Your audit script will get this wrong.** Compare like with like: `walk()` yields
   relative paths, `resolve(dirname(f), spec)` yields absolute ones, so `tier.has(target)`
   silently never matches and the closure never propagates. Symptom is a confident
   `MISSING=5` naming exactly the modules you just correctly excluded. Normalise both
   sides to absolute.
2. **An audit disagreeing with the artifact is not automatically right.** The committed
   test (`packages/runner/src/runtime-entrypoint.test.ts`) was green the whole time
   because it derives its root from `import.meta.url` and never mixed path kinds.

Related: `mem:gotcha-runner-package-does-not-load-under-plain-node`,
`mem:gotcha-vitest-hides-missing-js-bridge`,
`mem:gotcha-node-does-not-resolve-js-specifier-to-ts`, `mem:gotcha-scheduler-js-shims`.
