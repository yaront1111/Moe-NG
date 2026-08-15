# Port result shape validation is not transition validation

At a durable authority seam, decoding a success arm only proves the record is individually well formed. It does not prove it is the success for the request just issued.

Cross-check relational invariants:
- one-use grant CAS: same grantId, intentId and wrapperIdentity as presented; state UNUSED to CONSUMED; exact version +1;
- process registration: every returned registration field exactly equals the validated registration handed to the commit port.

Without this, a well-formed hostile result can redirect a lock identity, substitute a process identity, or return an unrelated consumed grant while passing decoders. Tests must mutate each bound field while preserving a valid shape and assert the production surface's exact code/layer plus zero open where the phase is pre-open.
