# A surviving mutant behind a stronger downstream commitment is not a reject

## The pattern

QA drills a production guard, the whole suite stays green, and the reflex is "drill-dead guard,
reject". Before rejecting, ask **what the code does with the mutation live, on every reachable
input** — not just "is there a test named after it".

Worked example (task-47eecd22, daemon durable recovery inventory), two clauses that look identical
and grade opposite:

- **Seal path** — `readStoredSeal` ends with `sealDigest !== raw["sealDigest"]` then
  `!sameDurableBytes(encodeDurableSeal(seal, sealDigest), event.payload)`. Kill the pair and a
  respelled seal **READS SUCCESSFULLY**. Authority leak. Legitimate reject; the fix is a test.
- **Row path** — `decodeRow` ends with the same shape. Kill the re-encode clause alone and the
  suite stays green — correctly. The seal commits per-class `rowDigests` + `itemCount` and the
  reader cross-checks both, so a respelled *existing* row is still refused as `SUBJECT_DUPLICATE`
  and a respelled *new* row as `RECORD_CONFLICT`. The mutation swaps one UNKNOWN reason code at the
  same layer for another. No leak, no partial list. Not a reject.

## The discriminator

Run the mutant and classify the *observable delta*:

1. refusal becomes **success** (or a partial answer, or authority) -> real hole, reject;
2. refusal becomes a **different refusal code at a different layer** -> reject if a rail pins that
   code (this board's rail 1 does), the fix being a test;
3. refusal becomes a **different refusal code the tests already pin elsewhere, because a stronger
   downstream commitment independently refuses every reachable input** -> defense-in-depth
   redundancy. Disclose in the approval, do not reject.

Corollary: prove case 3 by drilling the **pair**, not the clause. If the pair reddens on a
reason-code assertion, the chain is covered and only the weaker operand is redundant. A pair that
stays green is case 1 or 2.

## Why this matters

Rejecting case 3 is ping-pong, and worse, it teaches the worker to bolt a test onto an unreachable
branch — a test that will detach the moment the downstream commitment changes, which is exactly the
defect rail 1 exists to prevent.

Related: `mem:gotcha-equivalent-mutant-in-a-two-clause-guard`,
`mem:gotcha-key-cross-check-operands-are-equivalent-mutants`,
`mem:gotcha-a-forgery-probe-must-reseal-through-production`.
