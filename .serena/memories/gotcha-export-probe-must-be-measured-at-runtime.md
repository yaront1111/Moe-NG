# A probe over "export names" means RUNTIME names — grepping index.ts overcounts and under-follows

Confirmed 2026-08-11 on task-40983c7c, where three independent agents (architect,
worker, QA) had all recorded the same wrong numbers.

## The mechanism
`produceAbsenceOutcome` (`tests/fault/foundation/foundation-harness.ts:105`) evaluates
against `LIVE_EXPORT_SURFACES`, built by `exportNames(namespace)` =
`Object.keys(moduleNamespace).sort()`. So the probe sees **runtime value exports only**.

A text grep of `packages/<pkg>/src/index.ts` gets this wrong in both directions:

- **Overcounts.** `export type { ... } from` names are counted, but a type can never
  appear in a namespace object and can never fire a probe. This is most of the error:
  `Distribution|DISTRIBUTION` grepped as 17 and is really **6**; `Claim|CLAIM` grepped
  as 2, really **1**; `Handoff|HANDOFF` grepped as 1, really **0** — its only match,
  `ExpansionHandoffBinding`, is a type, so the row was never going to flip.
- **Under-follows.** `packages/core/src/index.ts:249` is `export * from
  "./identity/index.js"`. No text scan resolves it, so a grep-based count silently
  misses whatever that subtree publishes.

## Measure it for real, in one line, no scratch file
Node 24 strips TS types natively, so the barrels import directly from the CLI:

```sh
node --input-type=module -e '
  const ns = await import("./packages/core/src/index.ts");
  console.log(Object.keys(ns).length, Object.keys(ns).filter(n => /Handoff/u.test(n)));
'
```
Baseline at 2026-08-11: @moe/contracts 58, @moe/core 61, @moe/scheduler 65 runtime names.

## Why it matters beyond this file
A number that is 3x too high still points at a real defect, so it survives review —
nobody re-measures a figure that agrees with the red they can see. The error only
surfaces on the probe that is NOT red, where the grep says "compromised, about to
flip" and the runtime says "clean". Record the method with the number.

Related: `mem:gotcha-verification-proxy-diverges-from-the-property`,
`mem:type-only-export-invisible-to-the-count-test`.
