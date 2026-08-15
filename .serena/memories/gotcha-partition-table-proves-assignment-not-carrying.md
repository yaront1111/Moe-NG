# A field-partition table proves assignment, not correct carrying

The expansion bridge splits 24 bound leaves into 15 carried into named core fields and 9 folded
into one canonical projection digest. `tests/integration/expansion-protocol.test.ts` proves the two
hand-written columns are non-empty, disjoint, and that their union equals `leafPaths()` of the
SHIPPED admission. That is a strong guard — and it says nothing about whether a carried field was
carried CORRECTLY.

Swap one mapping for a sibling of the same type (`qualityDigest: bound.qualityDigest` ->
`bound.evidenceDigest`) and the partition still balances, the union still matches, every column
count is unchanged. The whole suite stayed green because only 5 of the 15 explicit fields had a
one-byte perturbation case.

Two things are needed, not one:
1. the column/union partition (proves nothing was dropped from the classification), and
2. a value-identity assertion per carried field, both sides read from PRODUCTION surfaces — the
   shipped admission output and the shipped binding output — never from a helper that recomputes
   the mapping.

Pair it with a positive count and a distinctness check, or a mapping returning one constant
everywhere would pass. See `mem:task-task-2d9696160e674f26a8d422c45829d80e-handoff`.
