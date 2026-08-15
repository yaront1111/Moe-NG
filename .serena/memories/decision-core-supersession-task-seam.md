# Core supersession task seam

A graph supersession contract migration cannot be planned only against the reducer's headline files when durable graph epochs and exact refusal layers are required.

Before sizing, search for all direct `GraphRevisionState` constructors, command generators, lifecycle invariant sweeps, and result shapers. In this repository the hidden consumers were:
- `graph-revision-test-fixtures.ts` (state and command construction),
- `planning-invariant-drivers.ts` (cast-based generated commands),
- `planning-invariants.test.ts` (ACTIVE-refuses-everything property),
- `graph-revision-results.ts` (the public reducer rejection shape).

Because `@moe/contracts` validates error source but omits it from returned `RuntimeError`, exact refusal-layer assertions need a production result-layer discriminant; a test helper must not invent it.

When the combined engine/reducer migration exceeds 10 files, split by the existing interface:
1. Pure deterministic supersession decision kernel + root export.
2. Graph revision aggregate integration + every affected fixture/property test.

The pure producer satisfies Clause 1 by naming the reducer integration task as its concrete consumer. Scheduler attempt/effect/resource/budget disposition application remains a later consumer and must not be pulled into either slice.
