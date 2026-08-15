# A binding check that only compares equality is forged by naming NOTHING on both sides

Found by adversarial self-review on task-5d8f11c8, BEFORE commit. The test went red with
`Received: "SATISFIED"`, so it was a live defect, not a theoretical one.

## The shape

A record is bound to the thing it authorises, and the guard compares the two:

```ts
if (grant.gateId !== gate.gateId || grant.workRef !== gate.workRef) return refuse(...);
```

This looks airtight and passes every transplant test — moving a real grant onto a different
`workRef` is correctly refused. But the cheapest forgery available to anyone who can WRITE the
record is not to change a reference. It is to omit both:

```ts
{ gateId: undefined, workRef: undefined, grant: { gateId: undefined, workRef: undefined, ... } }
```

`undefined === undefined`, so the binding "matches" and a grant bound to no work at all reads as
bound to THIS work. TypeScript does not help: the field is typed `string`, so the hole is only
reachable from a value off the wire — which is exactly where these records come from.

## The fix

A reference must NAME something before comparing it means anything. Check the authorising side's
own identity first, then compare:

```ts
const namedRef = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const bound = namedRef(gate.gateId) && namedRef(gate.workRef)
  && grant.gateId === gate.gateId && grant.workRef === gate.workRef;
```

Also refuse to MINT a record for an unnamed subject, or you produce a grant bound to nothing that
the reader then has to catch.

## Generalises to

Any `a.x === b.x` authorisation guard where both sides come from untrusted storage: tenant ids,
epoch refs, incarnation refs, digests. Pair with `mem:qa-forgery-probe-must-reseal-through-production`.
The test that catches it is not a transplant test — it is a test that names nothing at all.
