# A downstream crash reads like the guard held

## What happened

`recordReviewRound` had a NaN bypass: `NaN <= lastRound(lineage)` is false like
every comparison against NaN, so the append-only guard never fired. The task
described the consequence as "the NaN flows into the stored record".

Measured under a mutation drill, it does not. The bypassed round reaches
`canonicalDigest`, and `canonical.ts:19` throws
`TypeError: canonical JSON supports safe integers only`. Nothing is stored. The
function does stop. So a casual reading says "it fails closed already, this is
not a real defect".

That reading is wrong on two counts, and both generalise.

## Why a crash is not a refusal

1. **It names no reason code.** The whole point of a stable reason vocabulary is
   that the caller can tell WHICH fact was violated. An unstructured `TypeError`
   from a serialiser two layers down is indistinguishable from a genuinely
   broken digest, a bug in the canonicaliser, or an OOM. Epic rail 4 ("fail
   closed with stable reason codes") is not satisfied by "it threw".
2. **A validator one layer down only covers the types IT cares about.** The
   canonical guard rejects non-safe-integer NUMBERS. It says nothing about a
   numeric STRING — `"2"` serialises cleanly as a string — so `round: "2"` sailed
   all the way through and WAS stored with `ok: true`. The shape everyone
   assumed was the hole (NaN) crashed; the shape nobody named (a string) was the
   one that actually got in.

## How to apply

- When a defect report says "value X reaches storage", **drill it and read the
  actual failure message** before you write the note claiming it. The difference
  between "accepted and stored" and "crashed in a serialiser" changes the harm
  statement, and a QA agent will check it.
- Sweep the FULL shape space, not just the one the report names. The types the
  downstream validator ignores are exactly where the survivor lives — here,
  everything non-numeric.
- Encode the distinction in the test, not in prose. Add `not.toThrow` alongside
  the exact-code assertion:

  ```ts
  expect(() => subject(input)).not.toThrow();   // a crash is not a refusal
  const result = subject(input);
  expect(result.code).toBe("EXPECTED_CODE");    // and this is the code
  ```

  Without the first line the test still passes once the guard exists, so it
  reads complete — but it no longer distinguishes "refused with a code" from
  "crashed", which is the whole fact the guard was added to establish. Under the
  drill that line is what reddens.
- Corollary for drills: a drill that reddens by THROWING rather than by failing
  an assertion is a weaker signal. Adding the `not.toThrow` assertion converts
  it into a clean assertion failure that names what changed.

Related: `mem:refusal-test-answered-by-earlier-guard`,
`mem:qa-refusal-code-absent-from-test-file`,
`mem:mutation-drill-red-on-wrong-assertion`,
`mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`.
