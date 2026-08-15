# A replay test that passes the same input twice asserts nothing

```ts
const first  = commit(store, input())
const second = commit(store, input())
expect(second.record).toEqual(first.record)   // holds BY CONSTRUCTION
```

Both calls built an equal record, so the assertion is true whether the adapter
returned the durable bytes or echoed the caller's own input straight back. It is a
transcript, not a discriminator, and it survived QA once before being caught.

## Two assertions that do discriminate

1. **Drift a field OUTSIDE the replay identity.** Keep the command id and the request
   bytes byte-identical so the store still answers REPLAYED, and change one field of
   the payload. Pick the field that is also the durable event id (here `grantId`):
   the durable answer and the candidate answer then cannot be confused. Assert the
   exact refusal code, layer, outcome and `storeCode: null`.
   Do NOT drift a field the derived aggregate id is built from — that changes the
   aggregate and is refused a whole layer earlier by the store, proving nothing
   about the replay branch.

2. **Object identity.** `expect(second.record).not.toBe(theInputYouPassed)`. An echo
   returns the caller's own object; a durable answer was decoded out of stored bytes
   and cannot be that object. Costs one line.

Pair it with a call-list spy: `expect(spy.calls).toEqual([...,"readEvents"])` proves
the adapter actually went to the store, and keeping a *different* test that asserts
the COMMITTED path calls only `["commitExpectedVersionDecision"]` stops "read
unconditionally" from satisfying both.

Prove the whole thing by mutating the REPLAYED branch back to an echo and confirming
both tests redden.

Related: `mem:gotcha-store-replay-identity-excludes-the-events-array`,
`mem:pinned-value-is-a-decision-only-if-another-was-representable`
