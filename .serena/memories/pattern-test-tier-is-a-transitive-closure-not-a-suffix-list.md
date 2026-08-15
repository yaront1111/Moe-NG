# Test-tier is a transitive closure over imports, not a filename suffix list

ESTABLISHED 2026-08-08, task-eb9ff081 (`.js` runtime bridges for `@moe/runner`),
QA-approved with this as a documented deviation from the task's own DoD.

## The rule

When deciding which modules get a `.js` runtime bridge, "test-only" cannot be
matched by filename. A module is **test-tier** if it matches
`/\.test\.ts$|-test-fixtures\.ts$|-test-helpers\.ts$/` **OR it imports, directly
or transitively, a module that is test-tier.**

Measured over `packages/runner/src`: totalTs=78, excludedByName=28,
**excludedByDependency=5**, runtimeModules=45.

The five dependency-excluded modules match no suffix pattern:
`supervisor/race-harness.ts`, `race-scenarios.ts`, `race-restart-scenarios.ts`,
`race-steps.ts`, `race-world.ts`. Four import `./effect-test-fixtures.js`
directly; `race-harness` reaches it through `race-scenarios`.

## Why a bridge for these is not merely useless but wrong

Bridging them commits files that provably cannot load — importing the bridge
raises `ERR_MODULE_NOT_FOUND` because it re-exports a module whose own import of
`effect-test-fixtures.js` has no bridge (and must not have one). The only ways
to make such a bridge load are to bridge the fixtures (publishes test code on
the runtime surface) or edit the `.ts` to drop the fixture import (a behaviour
change). Both are worse than having no bridge.

`packages/runner/package.json` exports is `{".": "./src/index.ts"}` — a single
entry with **no subpath wildcard** — so these modules are unreachable through
the package surface by construction. That is the check that settles the
argument; consumer analysis alone only shows current usage.

## Implementation

`packages/runner/src/runtime-entrypoint.test.ts` derives the set at test time
(`testTierModules`, fixpoint loop) rather than hardcoding names, so the next
race-tier module someone adds is excluded automatically instead of silently
regressing. It guards vacuity with `runtimeModules.length > 0` and
`tier.size > 0`, and reports missing/unexpected/wrongContent BY NAME.

**Resolve both sides of the comparison to absolute paths.** The worker's
throwaway audit script walked relative paths but resolved import targets with
`resolve()` to absolute, so `tier.has(target)` never matched, the closure never
propagated, and it printed a false `MISSING=5`. The committed test avoids this
by deriving `SRC_ROOT` from `import.meta.url`.

Verified independently at QA by a from-scratch re-implementation that produced
the identical five. Two implementations agreeing is what made this deviation
approvable rather than a judgement call.
