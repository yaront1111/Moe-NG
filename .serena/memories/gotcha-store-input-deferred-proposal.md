# Store input deferred-proposal gotcha

`snapshotExpectedVersionRequest` deliberately retains the validated plain `inputRecord` only as a synchronous, non-persisted alias. It copies request bytes and freezes/copies the decision key immediately, but it must not read or snapshot `events` or `committedResultBytes` on replay/stale paths.

`snapshotCommittedProposal` later reads `committedResultBytes` first, charges it against one MAX_COMMIT_BYTES budget, then reads current `events` and routes request bytes/effects through `snapshotCommitInput` with the same budget. Reordering or eagerly copying these deferred fields changes lazy error and byte-limit precedence.

Caller-owned bytes, arrays, and nested records in the resulting proposal are still copied; only the temporary `inputRecord` alias is intentional and must never be persisted.