# Projection outbox core planning handoff

Task task-55d5a898264b4880a99bf2c5b3be120b was reported BLOCKED during planning; no plan was submitted and no files were edited.

## Why subtree-only ownership cannot meet the DoD
- Owned paths are only packages/store/src/projections/**, outbox-relay/**, subscriptions/**.
- SQLite v2 exact schema has no projection generation/state, poison quarantine, inbox receipt, relay state, or subscription cursor/ack tables. validateExactSchemaObjects rejects any undeclared object.
- EventLedgerStore.commit owns BEGIN IMMEDIATE, event/outbox writes, COMMIT, rollback, and ambiguity handling with no projection hook. Atomic event+projection+outbox cannot be composed externally.
- SqliteEventStore has a private constructor/#core and exposes no DatabaseSync/transaction seam.
- package.json exports only "." and packages/store/src/index.ts is outside ownership, so subtree APIs cannot become downstream @moe/store contracts.
- Domain events have a storage record_version and opaque payload codec but no domain schema/canonicalizer version required to select real upcasters.
- A fake/in-memory port test would not prove SQLite atomicity, reopen durability, or inbox/cursor behavior and would violate the task objective.
- The task spans at least four independent >60-minute responsibilities and should be SPIDR-split.

## Pinned semantics
- One command transaction: normalized authority + ordered versioned events + projections + outbox + replay result, one commit before acknowledgement.
- Projections are disposable/rebuildable derived state, never competing authority.
- Events carry schema/canonicalizer versions; unknown future versions fail closed/read-only.
- Relay is at-least-once; durable inbox receipts dedupe. External effects still require stronger effect protocols.
- Poison is visibly quarantined at aggregate/global cursor, causal dependents held, unrelated aggregates may progress; unknown consumer state => NEEDS_RECONCILIATION.
- Subscriber resumes strictly after ack. Missing/pruned/corrupt/wrong-generation cursor => CURSOR_GAP with last-good cursor and signed snapshot digest, never silent restart.
- Rebuild/live mismatch blocks mutating startup.

## Recommended ordered SPIDR
1. Schema/event-envelope contract + schema v3 migration/integrity for event schema/canonicalizer, projection generations/state, poison, inbox, relay, and cursor receipts.
2. Event-ledger transaction integration seam/public exports so projections share the existing atomic commit and ambiguity handling.
3. Pure upcaster registry + normalized live projection and scratch-generation rebuild/swap.
4. At-least-once relay + atomic durable inbox dedupe (no exactly-once external-effect claim).
5. Subscription cursor/generation/signed-snapshot gap contract plus generated-history/crash/reopen hardening.

Coordinate after decision/event ledger work settles; amend ownership for sqlite-schema*, event-ledger transaction seam, store contracts/facade/index/package exports.