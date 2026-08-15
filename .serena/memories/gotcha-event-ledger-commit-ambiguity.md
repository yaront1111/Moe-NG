# Event-ledger commit ambiguity refactor gotchas

- Keep post-COMMIT result materialization inside the recovery wrapper's `try`. If `toCommitResult` throws after SQLite ended the transaction, the legacy behavior is poisoned `OUTCOME_UNKNOWN`, not a raw allocation/materialization error.
- Set `commitAttempted` immediately before `COMMIT`; a rejected COMMIT that leaves an active transaction must attempt rollback and keep the handle reusable when rollback succeeds.
- Prepare the outbox collision lookup once before the per-event preflight loop. Preparing it lazily per event changes error timing (especially for an empty batch) and drifts from the original event-then-outbox preflight order.
- Runtime imports target one-line `.js` bridges that re-export the `.ts` implementation under Node strip-types.