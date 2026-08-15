# A permutation test can permute the wrong thing and stay green on a broken build

Shape: a structure whose array carries a MEANINGFUL order along one axis and NO order along another.
`FairnessRing.entries` (`packages/scheduler/src/fairness/fairness-ring.ts:54-58`) is the flat union
of every per-resource queue: order WITHIN one resource's queue is its FIFO order and is real; order
BETWEEN queues is explicitly not implied. `validateRing` preserves caller order verbatim and will not
normalise it for you.

The test must therefore permute **only the axis that carries no meaning**.

## Two ways to get it wrong
1. **Blind shuffle** — also reorders within a queue, where a different result is CORRECT. The test
   fails for the wrong reason, and "fixing" it teaches you to weaken the assertion.
2. **A regrouping that does not actually invert anything.** This is the silent one. I first wrote:
   ```
   interleaved: [a1, b1, a2, b2]
   grouped:     [a1, a2, b1, b2]
   ```
   Both preserve the two queues AND both still lead with `res.a`. An implementation deriving order
   from entry array position selects identically on both, so the test passes a broken build. It only
   surfaced when the mutation drill ("derive order from entry first-appearance") failed to redden.
   The fix inverts which resource appears first:
   ```
   grouped: [b1, b2, a1, a2]
   ```

## Rule
For a permutation/re-serialization test, name the property the permutation is supposed to break and
check the fixture actually breaks it. Assert the two serializations differ
(`expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b))`) so the case cannot go vacuous — but note
that assertion alone would NOT have caught this: both orders differed, just not along the axis that
mattered. **The mutation drill is what proves it, not the inequality assertion.**

Related: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`,
`mem:guard-premise-detaches-while-green`.
