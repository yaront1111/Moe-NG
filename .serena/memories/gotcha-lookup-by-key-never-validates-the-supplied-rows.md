# Gotcha: consulting caller rows by lookup is not validating them

Pattern, shipped green twice on this board and rejected by QA on
`apps/daemon/src/recovery/recovery-inventory-record.ts`:

```ts
return CANONICAL_ROWS.map((row) => {
  const match = supplied.find((entry) => entry.class === row.class);   // <-- the bug
  ...
});
```

The canonical list is validated, the OUTPUT cardinality is exactly right, and every test asserting
"six proofs, all classes, truth COMPLETE" passes. But nothing ever looks at the supplied array as a
set: an unknown seventh row, a duplicated row, or fifty junk rows all disappear silently and the
record still reports COMPLETE. The validated thing (`configuredClasses`) and the consulted thing
(`proofs`) were two different inputs, and only one had a guard.

Three consequences worth carrying:

1. **A closed vocabulary needs a guard per INPUT, not per concept.** If two caller-supplied
   collections name the same vocabulary, each needs its own validation and its own reason codes.
   Sharing one code makes "which guard answered" unassertable — the rail that says pin the reason
   code then cannot be satisfied. Here: `CLASS_*` for the configured names, `PROOF_CLASS_*` for the
   rows, with a test that applies the SAME structural fault to each and asserts the two codes differ.

2. **Cross-link the derived facts, not just the tables.** A per-item `sourceProofDigest` that is
   never compared against the digest of its mapped class proof lets one record bind two
   contradictory origins and still claim COMPLETE. Assert it as a sweep over every mapped class with
   `expect(swept).toBe(N)`, plus a positive control that walks the untouched record and checks
   `item.sourceProofDigest === proof.sourceProofDigest` — the control is what proves the sweep's
   mutation was the only difference.

3. **A sentinel value must be RESERVED, or the invariant keyed on it is decorative.** `normaliseProofs`
   used 64 zeros to mean "no configured proof backed this class". Until a supplied row spelling those
   zeros was refused, a caller could make an unbacked slot indistinguishable from a real one, and the
   readback rule "sentinel slot implies UNKNOWN items" certified nothing. Build/decode also disagree
   without it: the builder would accept a record the decoder refuses, breaking round-trip.

Detection that works: probe the production surface with an extra row, a duplicate row, and one
mutated leaf digest. If any returns `ok:true`, the guard is a lookup, not a validation.

Siblings: `mem:gotcha-recovery-inventory-proof-crosslink`,
`mem:gotcha-closed-enum-makes-a-refusal-code-unreachable` (the ordering trap that hits the moment you
add these codes), `mem:gotcha-canonical-json-needs-digest-and-reencode-both`.
