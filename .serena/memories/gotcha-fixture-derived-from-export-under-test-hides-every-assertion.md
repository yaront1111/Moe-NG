# Gotcha: a module-scope fixture built from the export under test hides every per-name assertion

Found 2026-08-08 writing `packages/scheduler/src/index-surface.test.ts`
(`task-8ee125d0f05f4966abfcc49db37bbbf5`). This is a **new failure mode of the
self-derived-universe family** (`mem:gotcha-self-derived-universe-cannot-check-itself`): there
the derived list makes the assertion vacuous; here it makes the assertion *never run*.

## The shape

A surface test whose whole point is "a dropped export fails BY NAME" also had a fixture at
module scope:

```ts
const LINES: readonly AdmissionAmount[] = scheduler.ADMISSION_PURPOSES
  .map((purpose) => ({ purpose, meter: "usd", quantity: 2 }));
```

The RED run reported:

```
 ❯ packages/scheduler/src/index-surface.test.ts (0 test)
TypeError: Cannot read properties of undefined (reading 'map')
```

**0 tests ran.** The 36 named `it.each` cases, the set-equality case, the cardinality guard —
none of them executed. The suite still went red, so a careless reading calls it "working", but
the diagnostic collapsed from "these 19 exports are missing, by name" to one anonymous
`TypeError` at import time.

## Rule

In a test that asserts a module's surface, **module-scope fixtures must not read from that
module**. Hand-transcribe them:

```ts
const PURPOSES: readonly AdmissionPurpose[] =
  ["EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"];
```

After the fix the same RED run named every missing symbol: `publishes fenceAuthority on the
package root as a function`, `expected [35] to deeply equal [36]`, and so on
(30 failed | 18 passed).

Calling the export **inside an `it()` body** is fine and is the point — only the module-scope
evaluation is fatal, because it aborts collection.

## Generalisation

Any top-level `const` in a test that dereferences the subject (`.map`, `.length`, `[0]`,
spread, destructure) converts an informative multi-assertion failure into a single import-time
crash. Applies to namespace-surface tests, vocabulary drift tests, and generated `it.each`
tables — exactly the places `it.each` was chosen for its per-case naming.

## How to catch it

Mutation-drill by **removing** one export, then read the RED output: if the run reports
`(0 test)` instead of naming the symbol, a fixture is reaching into the subject.

Related: `mem:gotcha-self-derived-universe-cannot-check-itself`,
`mem:gotcha-vitest-hides-missing-js-bridge`.
