# An identity-match guard is untested when every fixture variant is schema-invalid

Found on task-93b0314e09f248118e21f92699989468 (@moe/core PlanningRun EXPANSION), 2026-08-09.

## Shape
Two refusal layers in one predicate chain:
```ts
if (!validExpansionProposeCommand(command)   // layer 1: SCHEMA (is this shape legal at all?)
    || !validExpansionHoldBinding(bound)
    || !sameHold(bound, command.expansion))  // layer 2: IDENTITY (does it match THIS run?)
  return illegal(state, command.kind);
```
The malformed-input fixture set contained only layer-1 violations —
`lifecycle: "RELEASED"` (pinned constant), `proposalBaseHash: "not-a-proposal-base-hash"`
(bad hash format), `graphEpoch: -1` (out of range). Every one is rejected by the schema before
layer 2 ever runs.

Result: `HOLD_IDENTITY_KEYS` could be cut from 10 keys to `["holdId"]`, and both
`workerHandoff.digest`/`.ref` comparisons deleted, with the **entire suite still green
(22 files / 359 tests)**. The task's DoD required exactly those fields to match.

## Why it hides
The fixtures *look* like they cover the identity property — they are literally named
`STALE_PROPOSAL_BASE` and `WRONG_GRAPH_EPOCH`. A "stale" base and a *malformed* base are different
inputs, and only the malformed one was built. A malformed value can never reach an equality check.

## The rule
**A deviation fixture aimed at layer N must be VALID at every layer before N.** To test an
identity/equality guard, the deviating value must be well-formed: `graphEpoch: 5` not `-1`,
`proposalBaseHash: hash("other")` not `"not-a-hash"`, a real-but-different ref not an empty string.

## Detection (QA)
Reading the fixture names is not enough — they lied here. The only reliable check is the drill:
delete the guard's comparison keys and re-run. Green means the layer is shadowed. Cheap: one
single-anchor textual mutation plus one suite run per key group.

Corollary for the fix: also assert the swept case count (`expect(keys.length).toBe(N)`) — a sweep
that silently generates zero cases passes. The task already did this correctly for its 3-variant
loop; the defect was the *content* of the variants, not the count assertion.

## The fix shape (applied 2026-08-09, both drills now redden)

Add a SECOND fixture set beside the malformed one — do not convert the malformed one, it is the
only thing covering the schema layer. Each entry deviates a single field by a well-formed value
(`graphEpoch: 5` not `-1`, `proposalBaseHash: hash("ab")` not `"not-a-hash"`).

Three assertions per swept case, all needed:

1. `expect(validExpansionHoldBinding(deviation)).toBe(true)` — against the PRODUCTION predicate.
   This is what stops the set from silently regressing to schema-invalid and re-shadowing the
   guard. Without it the whole fix rots back into the original defect.
2. `expect(at(deviation, field)).not.toEqual(at(HOLD, field))` — proves the entry deviates at the
   field its KEY NAMES. A miswritten entry otherwise reads as coverage while that field stays
   unasserted: the same defect class, one level up.
3. the refusal itself, pinning code plus layer.

**The expected field set must be HAND-WRITTEN, never derived from the production key list.** A
sweep built from `HOLD_IDENTITY_KEYS` shrinks silently the moment a key is dropped from it, so the
very drill that proves the guard (`HOLD_IDENTITY_KEYS = ["holdId"]`) could never redden. See
`mem:qa-generated-table-cannot-police-its-own-generator`.

Right-reason check when the drill reddens: `expected true to be false` is assertion 3 (the run
ACCEPTED a deviating proposal — correct). `expected false to be true` would be assertion 1, meaning
the fixture broke, not the guard.

Related: `mem:gotcha-drift-test-refused-by-the-wrong-guard`,
`mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`.
