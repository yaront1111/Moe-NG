# "Empty / absent / unreadable" — assert Set(answers).size, not three separate tests

Measured on task-d7da9be4 (recovery-inventory adapters), where the rail was
"an empty listing, an absent directory and an unreadable entry are three
different facts and must carry three different answers."

## Why three separate passing tests are not enough

Each arm asserts its own reason code, so all three stay green while two of them
answer identically — a test asserting `RESULT_TRUNCATED` and a test asserting
`ENUMERATOR_UNAVAILABLE` cannot see that a third case joined one of them. The
collapse is invisible per-arm.

Add one arm that collects all three in a single test and asserts distinctness:

```ts
const answers = [empty, absent, unreadable].map((p) => `${p.truth}/${String(p.reason)}`);
expect(answers).toEqual(["COMPLETE/null", "UNKNOWN/ENUMERATOR_UNAVAILABLE", "UNKNOWN/RESULT_TRUNCATED"]);
expect(new Set(answers).size).toBe(3);
```

Mutation drill that proves it works: force the classifier that separates
"unreadable" from "no answer" to always return false (`truncates()` → false).
On this board that reddened **3** tests including the Set-size one. If only ONE
had reddened, the other two were never distinguishing anything.

## The mapping that gave three distinct answers

- observed-and-empty → `ENUMERATED{items:[], complete:true, negativeProofDigest:<digest>}`
  → COMPLETE. The digest is what makes emptiness a fact rather than a claim;
  `GitRefListing.observationDigest` and `ArtifactEnumerationOk.observationDigest`
  both exist at zero entries precisely for this.
- absent → `UNAVAILABLE` → `ENUMERATOR_UNAVAILABLE`
- unreadable record → `ENUMERATED{items:[], complete:false, negativeProofDigest:null}`
  → `RESULT_TRUNCATED`

A fourth fact (the port does not implement the optional listing method at all)
maps to `UNSUPPORTED` → `CAPABILITY_UNSUPPORTED`. Do NOT fold it into "empty":
undefined means "we never asked", not "there is nothing".

## Related

`mem:gotcha-exact-keyed-seam-forces-dual-return`,
`mem:gotcha-locale-drill-needs-a-fixture-that-can-kill-it`.
