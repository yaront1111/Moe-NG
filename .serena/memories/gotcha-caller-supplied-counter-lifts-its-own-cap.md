# A cap read off a caller-supplied record can be lifted by the caller

Found 2026-08-09 in the adversarial self-review of `task-58029c26` (@moe/review
escalation boundary).

## The shape

An accumulating record is threaded through a reducer and also read by a separate gate:

```ts
if (input.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT) { /* escalate */ }
```

Every test passed, because every test built its lineage by calling the reducer. But
the gate's parameter is a plain value, so a caller can hand it:

```ts
qualifyReviewAcceptance({ ...input, lineage: { ...capped, unsuccessfulRounds: 0 } })
```

and the cap is gone. Same trick on `records: []` makes every repeat finding look
fresh, defeating repeat detection.

## Fix: make the record attest itself

The record already carried a digest for other reasons. Verify it on every entry point
that trusts a field of it, and refuse with a stable code:

```ts
function lineageAttested(lineage) {
  return lineage.digest === lineageDigest(lineage.records, lineage.unsuccessfulRounds);
}
// -> FINDING_LINEAGE_DIGEST_MISMATCH
```

Check it in the reducer AND in every other consumer. Checking only the reducer leaves
the gate reachable directly.

## Honest limits

This is an **integrity** check, not authenticity — the digest function is
deterministic, so anyone who can reimplement it can forge a matching digest. It buys
exactly one real thing: a record that did not come out of this reducer is refused,
which catches hand-edited state, partial reconstruction from storage, and a field
dropped on a round-trip. Do not describe it as tamper-proof. Keep the digest helper
un-exported from the package root so forging requires reimplementing canonical JSON
plus the hash rather than one import.

## Test it by forging

`{...real, counter: 0}` and `{...real, records: []}` must both refuse by CODE and by
LAYER. Then drill `lineageAttested -> true` and confirm those tests go red.

Related: `mem:gotcha-publishing-an-unfrozen-array-is-a-tamper-vector`.
