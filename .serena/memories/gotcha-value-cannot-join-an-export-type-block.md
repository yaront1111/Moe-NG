# A value cannot be added to an existing `export type {}` block

## Symptom
A plan says "extend the existing `./foo.js` export block with these values". You find the block,
add the names, and `tsc` refuses — or worse, the names silently become type-only and vanish from
`Object.keys(namespace)` while the typecheck stays green.

## Cause
`export type { A, B } from "./foo.js"` is erased at compile time. Adding a runtime value to it
publishes NOTHING at runtime. The barrel needs a SECOND block against the same module specifier:

```ts
export { VALUE_A, valueB } from "./foo.js";        // runtime
export type { TypeA, TypeB } from "./foo.js";      // erased
```

Two blocks, same specifier, is correct and not a duplication smell.

## Where this bit
`packages/scheduler/src/index.ts` re-exported `./budget/budget-contract.js` as type-only only.
Publishing BUDGET_ISSUE_CODES / BUDGET_MEASUREMENT_COVERAGES / BUDGET_MEASUREMENT_SOURCES needed a
new value block beside it (task-5fa25bb33e974f04865b46f9fa0f3910, commit 350ec36).

## How to catch it
Before assuming a barrel already re-exports a module at runtime, `grep -n "from \"./that-module"`
and check whether every hit is prefixed `export type`. A root namespace test that asserts
`Object.keys(ns).sort()` against a hand-written table catches it too — see
`mem:type-only-export-invisible-to-count-test` for the inverse failure, where a TYPE is published
and the runtime table cannot see it.
