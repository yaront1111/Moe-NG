# Recovery inventory proofs must be cross-linked before COMPLETE

A canonical configured-class list does not validate the actual proof rows. If normalization uses `supplied.find` and ignores the remainder, unknown or duplicate proof classes can disappear while the record still reports COMPLETE. Likewise, an item-level `sourceProofDigest` must equal the digest of its mapped class proof; otherwise a record can bind two contradictory provenance digests while claiming COMPLETE.

QA probe pattern:
- keep `configuredClasses` canonical;
- append an unknown proof class and then a duplicate proof class;
- mutate one subject's `sourceProofDigest` only;
- invoke the production builder and assert exact refusal/UNKNOWN code and layer.

For `unknown` object boundaries, reflective helpers such as `Object.getOwnPropertyDescriptors` must also reject/contain Proxy traps; a throwing `ownKeys` trap must not escape the typed failure envelope.
