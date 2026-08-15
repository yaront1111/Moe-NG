# Gotcha: relaxation detectors must cover the EVIDENCE dimension, not just effect + obligations

Found by QA on task-556d87c3571e4d94a6d57e5ca77ab35f (Policy approval core), first
review of commit afbdfa7. Reproduced against landed code, not theorized.

## The defect

`packages/core/src/policy/policy-composition.ts` `ruleRelaxation()` compared a child
slice's rule redeclaration against its ancestor on exactly two dimensions:

- `effect` rank (ALLOW < REQUIRE_HUMAN_APPROVAL < DENY)
- `obligations` (dropped HARD = relaxation; dropped SOFT = waivable)

It never compared `requiredFactIds`. But `assessEvidence()` in
`policy-evaluation.ts` builds the required-fact set from `fold.rules`, which is the
**last declaration** of each `ruleId` in the chain. So a child slice redeclaring a
parent `ruleId` with a shrunken (or empty) `requiredFactIds` deleted the parent's
`HOLD_UNKNOWN` trigger, left `relaxed === false`, and emitted no
`SLICE_RELAXATION_DETECTED`.

Repro: facts `[{fact.tier, R0, DAEMON_VERIFIED}]`, top-level `requiredFactIds: []`,
`fact.audit` never supplied.

- chain `[root]`, root rule `{ruleId:"rule.audit", effect:"ALLOW", requiredFactIds:["fact.audit"]}`
  plus optIn `{deploy, R1}` -> `HOLD_UNKNOWN ["REQUIRED_FACT_MISSING"]` (correct)
- chain `[root, child]`, child redeclares the SAME ruleId with `requiredFactIds: []`
  -> `ALLOW ["ALLOWED_BY_POLICY"]`

Same missing fact, opposite decision. Only the SHRINK direction leaks — a child that
ADDS a `requiredFactId` is fail-closed, because the added ID enters the evidence
layer's required set too.

## The generalizable rule

When a fold enforces "children may tighten but never relax", the detector must cover
**every dimension the downstream layers read from the folded result** — not just the
dimensions that look like authority. `requiredFactIds` reads as a matching predicate,
so it was never modelled as an authority field; but the evidence layer derives
`HOLD_UNKNOWN` from it, which makes it one. Enumerate the effective structure's fields
and ask of each: does any layer read this? If yes, a child weakening it is a relaxation.

Corollary for guards on supplied structures: a monotonicity check that lists the fields
it compares will silently admit every field added later. Prefer comparing the whole
shape with an explicit allowlist of fields permitted to differ.

## Test-design lesson (this is why the suite stayed green)

Both test layers passed vacuously on this path:

- `policy-decision-table.test.ts` enumerated four relaxation shapes (effect weakened,
  HARD dropped, HARD->SOFT, uncovered child opt-in). Its `rule()` helper defaulted
  `requiredFactIds` to `[]` and only a single-slice fixture ever set it, so the field
  was never VARIED ACROSS SLICES anywhere in the suite.
- The 320-seed invariant sweep asserted "no seed reaches ALLOW with a missing required
  fact", but its generator never emitted a redeclaration that shrank the required set.
  A non-vacuity report that counts OUTCOMES and REASON CODES does not prove the
  generator reaches every structural SHAPE. Count shapes too, or the existence
  assertions guard nothing on that path.

Rule of thumb: for every field of a composed structure, at least one test must vary it
BETWEEN chain links, not merely set it once on one link.

## Resolution (2026-08-08, second pass)

`ruleRelaxation` now treats a non-superset redeclaration as an UNCONDITIONAL relaxation,
sitting beside the weakened-effect test rather than inside the obligation loop — that loop
holds the waiver branch, and this must never reach it. It is structurally unwaivable:
`validWaiver` requires a `namedObligationId` and the waiver branch fires only for an ancestor
obligation of kind SOFT, so no input shape makes a required fact waivable.

Second, independent layer: `assessEvidence` now unions the required set over EVERY slice in
`input.sliceChain` instead of over `fold.rules`. Identical on legal chains (a child may only
widen), and illegal ones are DENY already — the point is that BOTH layers must regress before
the escape reopens. Do not collapse them back into one.

The closure argument is checkable, not asserted: `PolicyRule` has four fields, `validRule`'s
`exact(value, RULE_KEYS)` forbids any other, `ruleId` is the fold's identity key, and the other
three are all compared. Adding a field forces a `RULE_KEYS` edit — that is the moment to ask
whether the new field is authority.

Test floors that matter: the sweep now emits the shrink shape 10 times in 320 seeds (was 0) and
asserts `>= 5`, not `> 0`. A `> 0` floor lets a generator retune drift back to a single seed and
still pass, which is the same class of failure as the original vacuity.

See `mem:convention-core-reducer-modules` for the surrounding core conventions and
`mem:task-task-556d87c3571e4d94a6d57e5ca77ab35f-handoff` for the commit-attribution caveat.
