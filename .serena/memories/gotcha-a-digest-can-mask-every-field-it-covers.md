# A digest field can make every field it duplicates unfalsifiable

Found on task-2561a780 (scheduler expansion admission), 2026-08-10, by a mutation drill that
came back GREEN.

## The shape

An identity binding that contains BOTH explicit scalars and a digest over a value carrying the
same scalars:

```ts
bound = {
  proposalId, revision, goalVersion, graphEpoch, observedAtSequence, childKeys, sourceDigests,
  evidenceDigest: digestOf(evidence),   // <- evidence carries ALL SEVEN of the above
  ...
}
identity = sha256(canonicalJson(bound))
```

Every one of those seven fields is bound TWICE. Drop any one from the identity and the
perturbation test that is supposed to police it STAYS GREEN, because perturbing the field still
moves the digest. Seven bindings read as covered while none of them is falsifiable.

## Why the usual test does not catch it

The natural test is "perturb field X in the request, assert the identity changed". That asserts
the IDENTITY moved, not that the FIELD participated. It cannot distinguish "X is bound" from
"something correlated with X is bound".

## How to detect it

Sweep, do not spot-check. For each top-level key K of the bound record, mutate the production
identity derivation to `digestOf({ ...bound, [K]: null })` and run the identity tests. A key
whose drop leaves the suite green is not bound in any way the tests can see.

```bash
for K in fieldA fieldB ...; do
  node mut.js "$FILE" "digestOf(bound)" "digestOf({ ...bound, $K: null })"
  pnpm exec vitest run <dir> -t "changes the identity" | grep "Tests  "
  node mut.js "$FILE" "digestOf({ ...bound, $K: null })" "digestOf(bound)"
done
```

On this task the first sweep found THREE green keys, not the one the single drill found. Fixing
the one the drill named would have left two.

## The fix is in production, not in the test

1. Make the digest cover ONLY facts nothing else carries. Here `evidenceDigest` became a digest
   of the per-child scope keys, oracle kind and input key/digest pairs, with the scalars removed.
2. Delete duplicated members from the digested value — the child's own `childKey` was dropped
   from the per-child facts because `childKeys` binds the key set once, and the two lists are
   built in the same loop so entry i describes key i.
3. Add perturbations that move ONLY the field under test. An UNREFERENCED extra source digest
   moves the declared digest set and nothing else; changing a child's scope key while leaving the
   child keys alone moves only the child facts.

Related: `mem:gotcha-verification-proxy-diverges-from-the-property`,
`mem:pattern-positive-control-a-ban-grep-before-trusting-empty`.
