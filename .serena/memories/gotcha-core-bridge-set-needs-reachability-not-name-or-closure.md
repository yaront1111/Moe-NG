# Gotcha: the `.js` bridge set is decided by REACHABILITY, and the @moe/runner rule is wrong for @moe/core

Found on `task-386fcb4c` (2026-08-09) while bridging `@moe/core`. Three plausible
rules disagree on this package, and two of them silently put test code on the
runtime surface.

| Rule | Bridges | Verdict |
|---|---|---|
| Filename only (`*.test.ts`, `*-test-fixtures.ts`, `*-test-helpers.ts` excluded) | 32 | WRONG |
| Filename + import-direction closure (`mem:gotcha-test-tier-modules-have-no-test-suffix`, the `@moe/runner` rule) | 32 | WRONG here |
| Reachability from `index.ts` | **26** | correct |

## Why the runner rule fails here

`planning-invariant-drivers.ts` and `planning-invariant-fixtures.ts` are test-only
by **CONSUMER** direction — only `planning-invariants.test.ts` reaches them (the
fixtures file only via the driver). They match no naming convention, and they
import no name-matched fixture, so the import-direction closure never marks them.
Both wrong rules bridge them. Nothing downstream complains: the probe passes, the
gate passes, and test-only code is now published on the runtime surface.

The runner's closure is not obsolete — it catches a DIFFERENT case (a module that
*imports* a fixture is unloadable by construction). The two directions are
independent. Reachability subsumes both when the exports map is exclusive.

## The rule that works, and its precondition

> A module needs a bridge iff it is transitively reachable from the package entry.

Valid because `packages/core/package.json` pins `"exports": { ".": "./src/index.ts" }`
— an **exclusive** map, so no consumer can deep-import and runtime reachability is
exactly reachability from `index.ts`. **Check the exports map before reusing this**;
a package with a wildcard subpath export has a larger runtime surface.

## Prove it, do not describe it

The rule is only real if a mutation drill enforces it. Bridge
`planning-invariant-drivers.js` and confirm the audit's UNEXPECTED set AND the
test-only guard both redden. A test that merely computes reachability and finds
zero problems is indistinguishable from one that asserts nothing.

Audit both directions from the same derived set: MISSING (runtime set -> disk) and
UNEXPECTED (disk -> runtime set). One direction alone always passes on the other's
defect. Measured end state: `runtimeModules=30, bridgesOnDisk=30, nonTest=34,
excluded=4, MISSING=0, UNEXPECTED=0`.

## Zero exports is not a failure

Six core modules export zero runtime bindings. All six are types-only
(`exportLines == typeOrInterface`, so `valueExports=0`). Verify that against a
control instead of treating zero as a defect — committed precedent exists in
already-reviewed packages: `scheduler/graph-preview-model.js`,
`scheduler/hard-edge-counterfactual-model.js`,
`store/outbox-relay/outbox-relay-contracts.js`,
`store/projections/projection-rebuild-contracts.js`.

Related: `mem:gotcha-vitest-hides-missing-js-bridge`, `mem:gotcha-scheduler-js-shims`,
`mem:gotcha-node-does-not-resolve-js-specifier-to-ts`,
`mem:gotcha-test-tier-modules-have-no-test-suffix`,
`mem:task-task-386fcb4c6d0241289f177cec9a3010e8-handoff`.
