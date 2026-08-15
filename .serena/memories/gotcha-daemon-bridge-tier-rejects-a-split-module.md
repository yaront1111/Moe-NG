# Splitting a daemon module for the line cap can make its `.js` bridge ILLEGAL

Found landing task-8e3076177f87458f934a776eca68ba16 (2026-08-15).

`apps/daemon/src/runtime-entrypoint.test.ts:150-172` classifies every non-test `.ts` under
`src/` into two tiers and then **requires a bridge for one and forbids it for the other**:

```
runtime tier = ENTRY_MODULE
             | has a <name>.test.ts SIBLING
             | is reached by a RELATIVE import FROM something already in the tier
test tier    = everything else
```

Then: every runtime-tier module MUST have `<name>.js` with bytes exactly
`export * from "./<name>.ts";\n`, and every `.js` whose module is NOT runtime tier is reported as
`unexpected`. `wrongContent` catches byte drift separately.

## The trap

The 250-line-per-file cap routinely forces a contract module to be split in two. The obvious move —
keep ONE test file covering both halves — is what breaks it:

- `provider-run-contracts.ts` had `provider-run-contracts.test.ts` -> runtime tier -> bridge fine.
- `provider-run-refusals.ts` had NO sibling test, and the split was clean enough that the contracts
  module never imported it, so **nothing relative reached it**. Test-tier. Its bridge came back as
  `unexpected: ["telemetry\\provider-run-refusals.js"]` and reddened the whole daemon test leg.

Note the direction: the module is real production code that later slices will import. It was
"scaffolding" only because no production importer existed *yet*.

## Fix

Give the split-out module its **own** `<name>.test.ts`. That is the guard's own definition of a
published unit, and it is the better outcome anyway. Deleting the bridge instead would satisfy the
guard today and break the first consumer that imports the module.

## Also worth knowing

- The failure report names files, so read `missing` / `unexpected` / `wrongContent` and attribute
  each entry. In a shared worktree the SAME assertion can carry one entry of yours and one of a
  peer's — mine was `unexpected`, a peer's untracked `configuration/project-configuration-selection.ts`
  was `missing`, in the same red. Fixing yours does not turn the test green.
- The guard also asserts `runtime.size > 0` and `testTier.length > 0`, so it cannot go vacuous.
- Test files themselves never get a bridge (`activation-ledger-fixtures.ts` has none either).

Related: `mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest` (the opposite omission),
`mem:core-js-bridge-requires-index-reachability` (the @moe/core variant of the reachability rule).
