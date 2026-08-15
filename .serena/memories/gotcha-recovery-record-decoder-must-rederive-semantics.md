# Gotcha: a self-consistent digest does not certify recovery-record semantics

A strict decoder can still be fail-open when it checks JSON shape, recomputes a digest, and re-encodes bytes but does not re-derive facts the builder enforced.

Found on task-f6cf8d16c2654641a92b0ee36924de0c:
- record truth COMPLETE survived a child proof truth UNKNOWN;
- the reserved no-proof sentinel survived as a COMPLETE proof after its item count was set to zero;
- ADOPTED survived without restoredIntentDigest and ABSENT without terminalProofDigest;
- reversed item order and a duplicate class-scoped identity both survived.

All probes recomputed recordDigest with the production recoveryReconciliationDigest and encoded through the production encoder; decode returned ok:true. A byte-tamper test that leaves the old digest behind is insufficient because DIGEST_MISMATCH can answer while semantic guards remain absent.

Pattern for robust tests:
1. Build a legitimate record through the production builder.
2. Parse the production encoding, mutate one semantic invariant.
3. Recompute the digest with the production digest surface and production-encode the result.
4. Assert decoder refusal at RECOVERY_INVENTORY with the exact stable code.
5. Include positive controls and exact nonzero sweep counts.

The decoder must independently derive:
- record truth/coordinator/upstream from all proof and item states;
- sentinel proof slots imply proof truth UNKNOWN and missing-proof upstream;
- exact per-disposition required/forbidden fields;
- canonical item order and class-scoped identity uniqueness;
- item-to-proof digest and count links.

Related memories: `mem:gotcha-canonical-json-needs-digest-and-reencode-both`, `mem:gotcha-lookup-by-key-never-validates-the-supplied-rows`.