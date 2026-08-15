# The daemon bridge guard classifies by TEST SIBLING, not by intent

`apps/daemon/src/runtime-entrypoint.test.ts` decides which modules need a `.js` bridge. Its rule:

> runtime tier = the entry module, **plus every module with a direct `<name>.test.ts` sibling**
> ("a module under direct test is a published unit"), plus everything those reach transitively
> through relative imports. Everything else is scaffolding and must have **no** bridge.

It reports three sets by name: `missing`, `unexpected`, `wrongContent`.

## The trap

Split a module out of another for the 250-line cap and **leave its tests behind in the original
suite**, and the new module has no test sibling and is imported only by a `.test.ts` file. It is
therefore scaffolding by the guard's definition, and its `.js` bridge is reported `unexpected` —
even though it is genuine production authority that a future consumer will import.

The failure looks like an unrelated infrastructure test breaking, not like a problem with your
module. It is neither: the guard is right that nothing in the runtime graph reaches your file yet.

## Two wrong fixes and the right one

- **Wrong: delete the bridge.** A new `.ts` module needs one; vitest and tsc are both blind to its
  absence and only a child-process import sees it (`mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`).
  It also demotes production authority to scaffolding.
- **Wrong: import it from a runtime module just to satisfy the guard.** That is a dormant edge with
  no caller — the "exports the symbols is not composition" smell.
- **Right: give it its own `<name>.test.ts`.** That is exactly the guard's stated criterion for a
  published unit, and tests belong beside the unit anyway.

## Shared fixtures go in a test-tier module

When splitting a suite, put shared fixtures in a plain `.ts` module with **no test sibling and no
`.js` bridge** — precedent `work/work-race-fixtures.ts`, which the guard pins **by name** as
`runtime.has(...) === false`. It is reached only from tests, so it stays scaffolding and needs no
bridge. Duplicating the fixture per suite instead lets the copies drift about what a legal record
looks like while every suite keeps passing against its own private idea of one.
