# Transactional relay boundary decision

For the foundation relay slice, compose through `SqliteEventStore.commitWithApply` rather than opening another writer or adding a post-commit projection.

- Event and EventDraft.outbox rows already exist inside the uncommitted command transaction before apply runs; the relay does not insert outbox rows.
- Public store read methods are unsafe inside apply because they open a read snapshot transaction. Query only the callback's `context.database` and materialize the exact event batch from a pre-snapshotted CommitInput plus selected positions and CommitResult.
- Durable inbox identity is `(consumer_id,message_id)`; bind it to a canonical immutable-envelope digest. Matching digest is a distinguishable no-op, differing digest is a stable conflict.
- Check inbox before reducers, then compare-and-set durable projection checkpoint/prior digest, fold, write the new projection digest/checkpoint, and insert the inbox receipt, all before the shared COMMIT.
- The apply seam skips command replays, so label command-receipt and inbox-receipt dedupe separately. A restart proof for inbox must use fresh downstream command identities.
- Never unwrap arbitrary `PROJECTION_APPLY_FAILED` causes. Only a private relay rollback sentinel is a typed refusal/no-op; uncertainty and OUTCOME_UNKNOWN propagate.
