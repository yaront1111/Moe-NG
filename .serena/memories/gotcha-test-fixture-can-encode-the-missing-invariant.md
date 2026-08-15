# Gotcha: the fixture itself can be the thing that hides the missing invariant

Found while repairing `task-f6cf8d16c2654641a92b0ee36924de0c`. The ledger fixture built subjects and
proofs from two DIFFERENT index spaces:

```ts
proofs:   RECOVERY_PROOF_CLASSES.map((c, index)   => ({ ..., sourceProofDigest: hex(`c${index}`) })),
subjects: RECOVERY_INVENTORY_POPULATIONS.map((p, index) => ({ ..., sourceProofDigest: hex(`c${index}`) })),
```

Seven populations map onto six classes, so five of seven subjects cited a proof digest that was not
their class's. Every ledger test was green, and the durable sink had been committing
self-contradictory provenance in all of its own passing cases. The moment the real cross-link guard
landed, eight ledger tests went red — and the tempting read is "my guard is wrong", not "the fixture
was always wrong".

Two rules:

- **When a new guard reddens only FIXTURES, verify the fixture against the invariant by hand before
  weakening the guard.** Here the correct fix was `RECOVERY_PROOF_CLASSES.indexOf(classOf(population))`
  in the fixture — the guard was right. A worker under time pressure relaxes the guard instead, and
  the rejection reappears at the next review with the fixture cited as proof the behaviour is intended.

- **Two collections keyed off `map((x, index) => ...)` in the same fixture are a smell whenever their
  lengths differ.** The index is doing double duty as an identity, and the shorter collection's index
  space silently aliases the longer one. Derive the cross-reference from the production mapping
  function, never from a positional index.

Related: a per-field digest-binding test can also become unsatisfiable once a cross-link lands — a
proof digest can no longer be moved ALONE, because an item must cite its class proof. That is not a
weakened test; full isolation is genuinely impossible under the new invariant. Move both and say why
in a comment.

Siblings: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`,
`mem:gotcha-drift-fixture-must-not-perturb-the-covered-record`,
`mem:gotcha-lookup-by-key-never-validates-the-supplied-rows`.
