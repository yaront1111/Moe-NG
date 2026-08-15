# Disabling a refusal guard can leave the input still refused — by the NEXT guard

Measured on task-e8e27f76 (`packages/scheduler/src/fairness/fairness-evidence.ts`),
mutation drill 1a.

## The drill and what happened

I disabled the `BYPASS_EVIDENCE_MISSING` guard alone:

```ts
if (false && opportunityRefs.length === 0 && claimedBypasses > 0) {
```

The input was **still refused**. The very next check —
`if (opportunityRefs.length !== claimedBypasses)` — is true whenever the evidence list is
empty and the claim is positive, so it answered instead:

```
- "code": "FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING"
+ "code": "FAIRNESS_CONTRACT_BYPASS_COUNT_UNPROVEN"
  "layer": "OPPORTUNITY_EVIDENCE"
```

## Why this is the dangerous direction

`mem:refusal-test-answered-by-earlier-guard` covers a *preceding* guard hijacking a case.
This is the mirror image and it is easier to ship: a guard's own **successor** subsumes its
input set, so deleting the guard changes nothing observable at the `ok:false` level. Same
layer, same shape, still "refused". A test asserting only `result.ok === false`,
`issues.length === 1`, or `.toThrow()` stays green with the guard **gone**.

The subsumption is structural, not accidental: a "you brought nothing" guard is almost
always a special case of the "you brought the wrong amount" guard next to it. Any
count-plus-emptiness pair has this shape. So does range-then-type, and
missing-field-then-shape.

## What saves you

Assert the **exact code** by whole-object equality on `{code, layer}`, and put the
narrow guard **before** its general successor so the specific code is the one a user sees.
Then the drill reddens on a code mismatch rather than staying green.

Corollary for reviewers: when a mutation drill reddens, read the assertion diff, not the
failure count. "2 tests red" would have looked like success here; the diff is what proves
the guard was reached. And when a drill leaves the suite GREEN, do not conclude the guard
is redundant safety — find which sibling branch is answering.

Related: `mem:refusal-test-answered-by-earlier-guard`,
`mem:mutation-drill-red-on-wrong-assertion`, `mem:guard-premise-detaches-while-green`.
