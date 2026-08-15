# A green mutation drill has three different causes — separate them before reporting

Found on task-a1e7f75e (2026-08-11) drilling the eleven DoD-4 guards. Ten went
red. The one survivor, `fairness capacity` in
`packages/scheduler/src/expansion/expansion-admission.ts`, turned out to be
THREE distinct things wearing the same green.

## 1. Unreachable branch — an equivalent mutant, correctly green

`capacitySnapshot()`: `if (!capacity.ok) return fromLayered(capacity, "FAIRNESS")`
-> `continue` survives the whole suite. The production comment claims `rotateOnce`
has already accepted these records. MEASURED rather than believed: six shapes
that make a capacity row invalid — duplicate row, extra key, float units,
negative inFlight, inFlight over cap, string units — are ALL refused by
`rotateOnce` first (FAIRNESS_CONTRACT_DUPLICATE_IDENTITY / MALFORMED_INPUT /
INVALID_COUNTER / CARDINALITY_EXCEEDED), and `rotateOnce` runs before
`capacitySnapshot`. Unreachable through `admitExpansion`. Not a hole.

## 2. Two REAL gaps the weak mutation was hiding

Escalating the same site found two mutations that survived 1797 tests and should
not have:

```
inFlightUnits: capacity.value.inFlightUnits   ->   inFlightUnits: 0
return facts.sort((l, r) => ...)              ->   return facts
```

Both were no-ops for every fixture on the board: capacities are always supplied
already sorted and with `inFlightUnits: 0`. The sibling's own "capacity snapshot"
perturbation (`expansion-admission.test.ts:603-609`) moves `capacityUnits` ONLY.
So the snapshot's PRESENCE was asserted (`capacitySnapshot: pure.capacities ->
[]` was already red) while its CONTENTS and ORDER were not — two proposals
differing only in in-flight units would have shared an identity, and a caller
could have moved an identity by reordering a set.

Closed by two cases in `tests/integration/expansion-protocol.test.ts`: bind a
nonzero `inFlightUnits` and require the identity to MOVE; supply the capacities
REVERSED and require the identity to be UNCHANGED while the bound snapshot still
reads sorted. Re-running the same two drills afterwards: both red.

## 3. A redundant operand — disclose, do not edit

`if (rotated.value.disposition !== "SELECTED" || selection === null)` survives
dropping its first operand. `FAIRNESS_ROTATION_DISPOSITIONS` is
`["SELECTED","IDLE_CAPACITY_BOUND","IDLE_NO_SERVABLE_HEAD"]` and both IDLE cases
were driven: each returns `selection: null`. The first operand is subsumed by the
second and is unfalsifiable while the rotation contract holds. It fails closed
either way, and making it falsifiable means deleting a defensive operand in
production you likely do not own. See
`mem:key-cross-check-operands-are-equivalent-mutants`.

## The rule

A surviving mutation is never a finding on its own. Escalate the SAME site with a
stronger edit before concluding anything: if the stronger edit also survives, the
guard is genuinely unasserted; if it reddens, your first mutation was too weak to
observe and the fixtures — not the guard — are what to fix. Distinguishing those
is what turned one vague "survived" into two closed gaps and two clean
disclosures. Related: `mem:mutation-drill-green-may-indict-the-mutation`.
