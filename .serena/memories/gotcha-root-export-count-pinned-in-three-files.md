# A root export-count pin can live in three files, one outside your owned paths

2026-08-15, task-bcea7056 (publishing 6 new values from `@moe/core`). The architect measured ONE pin and
warned about it prominently. There were three. The plan's own step-7 gate would have caught the other two as
an apparently unrelated break.

For `@moe/core` the count 69 -> 75 had to be bumped at:
1. `packages/core/src/index-surface.test.ts` — `expect(EXPECTED_EXPORTS.length).toBe(N)`, the hand-transcribed
   name list. Obvious, and the one the plan named.
2. `packages/core/src/index-surface.test.ts` — `namedExportCount: N` buried inside the `--experimental-strip-
   types` CHILD-PROCESS probe's expected object, ~270 lines below (1). Same file, easy to miss on a grep for
   `toBe(69)` because it is an object property, not an assertion.
3. `packages/core/src/supersession/supersession-engine.test.ts:86` —
   `expect(Object.keys(core).filter(k => k !== "default").length).toBe(N)`, in a suite about SUPERSESSION.

**Find them all with a value grep, not a pattern grep**, and search the whole package, not the barrel's
neighbours: `grep -rn "\b69\b" packages/<pkg>/src/` then read each hit. A grep for `EXPECTED_EXPORTS` or for
the barrel filename finds (1) only.

**Consequence for owned paths.** (3) is in a directory no sane owned-path list for a publication task would
include, yet the edit is unavoidable: that assertion counts the ENTIRE package namespace, so any publication
reddens it, and a publication is the whole deliverable. Do not treat this as scope creep to hide or as a
reason to report blocked — make the one-line bump, add a comment line recording which task moved it (the file
already tracked a previous task's +8 that way), and DISCLOSE it as a forced deviation with the proof: the file
was untouched and green at the step-1 baseline, and is red the instant `index.ts` publishes.

**Two more traps in the same shape.** `export type` is erased at runtime, so a type-only publication bumps
nothing and the count test stays green while nothing is importable — the child probe must reach a real runtime
value. And the name list is compared against `Object.keys(ns).sort()`, so new rows go in true sort position:
`PROJECT_CONFIGURATION_*` lands between `PROJECT_COMMAND_KINDS` and `PROJECT_TRANSITIONS` (`M` < `N` < `T`),
and lowercase names sort after every SCREAMING_CASE one.

`@moe/runner` carries the same class of pin at 116 values. Budget for it when sizing any publication task.

Related: `mem:type-only-export-invisible-to-count-test`,
`mem:gotcha-closed-enum-all-array-couples-sibling-tests`, `mem:qa-prove-an-out-of-plan-edit-was-forced`.
