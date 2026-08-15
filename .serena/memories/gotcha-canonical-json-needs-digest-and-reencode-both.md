# A canonical-JSON decoder needs BOTH a digest check and a byte re-encode check

Landed in `apps/daemon/src/recovery/recovery-inventory-codec.ts`. Neither guard
alone is sufficient, and each one alone looks sufficient.

## The two attacks are disjoint

**1. Alternate spelling, same content.** Whitespace, reordered keys, a duplicate
key, a trailing `,"extra":1`. `JSON.parse` silently keeps the LAST duplicate, so
the parsed object is indistinguishable from the legitimate one and the digest
recomputes correctly. Only re-encoding canonically and comparing bytes to the
input reveals a second authoritative spelling.

**2. Same spelling, different content.** Swap one string value in place. The
bytes are still perfectly canonical, so the re-encode compare passes. Only the
digest catches it.

## Correct layer order

```
fatal-UTF-8 decode / bounds / JSON.parse  -> RECORD_UNREADABLE
structural validation (key ORDER, vocab,
  cardinality, re-derived invariants)     -> RECORD_NONCANONICAL
digest recomputation                      -> RECORD_DIGEST_MISMATCH
byte-for-byte canonical re-encode compare -> RECORD_NONCANONICAL
```

Digest BEFORE re-encode, or a semantic mutation reports as "non-canonical",
which is a wrong and misleading reason code.

## Details that are load-bearing

- Check key **ORDER**, not just the key set. `exactDataRecord` gives the set;
  `Object.keys(value)` compared index-by-index gives the order.
- **Re-derive** invariants rather than trusting stored rows: the class/population
  mapping, per-class `itemCount`, and "truth UNKNOWN iff coordinator present".
- Give the coordinator pair its **own** one-value vocabulary. Reusing the
  24-code upstream reader for it silently admitted any upstream code as a
  coordinator answer — `tsc` caught it as a no-overlap comparison.

## Testing it

A drill that deletes the re-encode compare must redden the non-canonical variant
sweep; a drill that drops one leaf from the digest body must redden the
digest-sensitivity sweep. If either stays green, the other guard is masking it
and you have not tested what you think.

Related: `mem:gotcha-json-digest-is-not-total-validate-before-hashing`,
`mem:layered-validator-sweep-goes-vacuous`.
