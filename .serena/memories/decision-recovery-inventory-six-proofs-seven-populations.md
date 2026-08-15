# Decision: recovery inventory is six proofs covering seven populations

Fresh audit at HEAD 0371ead and pinned design hash 1D9D...83191 resolves the 4/5/6/7 contradiction as follows:

- Runner contributes four node proof classes.
- Durable scheduler RESOURCE contributes a fifth.
- Durable INTEGRATION_TARGET/attempt contributes a sixth.
- Flattening the hand-written semantic mapping yields seven design populations.
- The only shared proof is PROVIDER_PROCESS_LAUNCH_LOCK, covering lock/wrapper registrations and provider runs; store that proof once and reference it for both populations.

Canonical proof order:
`PROVIDER_PROCESS_LAUNCH_LOCK, RESOURCE, WORKSPACE, INTEGRATION_TARGET, GIT_INTEGRATION_ON_DISK, ARTIFACT_OBJECT_STAGING`.

Canonical populations:
`WORKSPACE, EFFECT_LOCK_WRAPPER_REGISTRATION, PROVIDER_RUN, RESOURCE, BRANCH_REF, INTEGRATION_TARGET, ARTIFACT_STAGING`.

Never duplicate a combined proof to claim seven proofs. Never fold durable integration attempts into Git ref/submodule evidence or scheduler resources into artifact-object evidence. Daemon owns the canonical cross-package mapping; runner remains a closed four-class node collector. Missing configured evidence yields an UNKNOWN proof slot, but malformed/extra/unknown/duplicate/omitted configured classes refuse with exact stable code/layer.

Persistence is an immutable content-addressed reconciliation record, not a mutable latest pointer. R3/embargo consumers must bind an explicit record digest and source current recovery refs from the selected store/anchor.