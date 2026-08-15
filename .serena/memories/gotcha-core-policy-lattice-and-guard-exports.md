# Gotcha: fail-closed lattices and exported guards in packages/core

Two lessons from the policy area (task-556d87c3) that generalise to any core aggregate.

## Make the safety property structural, not a special case

`packages/core/src/policy` needs "an UNKNOWN fact can never become ALLOW". The tempting
implementation is an early return: `if (anyUnknown) return HOLD_UNKNOWN`. That works until
someone adds a fifth consideration below it and forgets the guard.

What actually holds: order the outcome vocabulary itself as the dominance lattice
(`POLICY_OUTCOMES = ["ALLOW", "REQUIRE_HUMAN_APPROVAL", "HOLD_UNKNOWN", "DENY"]`), fold every
independent layer through a single `dominant(left, right)` on `indexOf`, and let `HOLD_UNKNOWN`
sit ABOVE the two permissive outcomes. Then no layer added later can lift an unknown, because
no layer can produce something that dominates `HOLD_UNKNOWN` except `DENY`. The vocabulary and
the fold cannot drift apart because the tuple IS the ordering.

Corollary that fell out for free: a waiver that only ever suppresses ONE layer structurally
cannot launder a different layer's outcome. That is much easier to defend in review than
"we checked, there is no path".

## An exported guard is reachable from outside the snapshot boundary

The landed convention snapshots hostile input once (`snapshotData`) and validates only the
snapshot, so downstream guards can be cheap. It is therefore tempting to write
`exact()` as `Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))`.

That is only safe while every caller is inside the module. The moment per-shape guards
(`validFact`, `validRule`, `validSlice`, ...) are EXPORTED, a caller can hand them a raw value,
where an accessor or a non-enumerable own key satisfies `hasOwn`. The landed
`planning-snapshot.ts` version checks the property DESCRIPTOR (`enumerable` and `"value" in
descriptor`) inside a try/catch for exactly this reason. Clone it verbatim; do not simplify it.

Same shape of bug, different spot: a function whose FIRST argument is snapshotted but whose
SECOND is taken as a trusted typed array. If the function is re-exported from the package root,
that second argument is caller-controlled too — a hostile getter turns a fail-closed refusal
into a thrown exception. Snapshot every parameter that crosses the boundary, not just the one
that looks like "the input".

## Related

`mem:convention-core-reducer-modules` (registry codes, sizes, check order),
`mem:gotcha-shared-tree-repo-gate` (foreign RED attribution at the completion gate).
