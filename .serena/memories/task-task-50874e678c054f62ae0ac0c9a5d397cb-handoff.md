# Handoff: schema v3 + projection seam — BLOCKED with proposed split

task-50874e678c054f62ae0ac0c9a5d397cb blocked after 2-agent adversarial verification. Two structural blockers.

## Blocker 1: honest file map = 14 > 10-file hard cap
Verified real tree (post-9e16dde):
- commit() body: event-ledger-transaction.ts (event-ledger.ts = 7-line facade, listed in owned paths but needs NO edit)
- STORED_EVENT_SELECT_COLUMNS: read-page-queries.ts (+ EVENT_DECODED_BYTES_SQL byte accounting)
- SqliteEventStore wraps commit fixed one-arg over private #core (sqlite-event-store.ts:250) — seam options can't reach ledger without editing it
- EffectEventDraft extends Omit<SnapshotEventDraft,"outbox"> (store-internals.ts:32-45) — new required field ripples into event-read-materialization.ts unless EffectEventDraft explicitly Omits domainSchemaVersion (SAFE: effect digest hashes named fields only, store-digests.ts:190-221)
- PROJECTION_APPLY_FAILED needs DurableStoreErrorCode closed-union extension (store-contracts.ts:183-199)
- Exactly ONE production INSERT INTO domain_events: event-ledger-append.ts:92 (shared with decision ledger via writeCommitEffects)

## Blocker 2: DoD 4 "existing tests pass unchanged" unsatisfiable
- command-decision-integrity.test.ts:175,183 pins userVersion===2
- store-project-and-schema-contract.test.ts:65 tampers user_version=3 for too-new rejection (no-op at SCHEMA_VERSION=3; must become 4)
- event-read-model-contract.test.ts:53-68 toStrictEqual exact StoredEvent key set (5 uses) — new field breaks all

## Proposed split (posted to governor)
**Task A** Schema v3 tables+migration (7 files): manifest (SCHEMA_V2_OBJECT_SQL snapshot + v3: projections, inbox_receipts, event_subscriptions, cursor_generations — NO AUTOINCREMENT so integrity.ts:137 list untouched), migration (two-leg v1→v2→v3; v1 leg currently writes TERMINAL constants — needs intermediate "moe-sqlite-schema/2" const which doesn't exist; v2→v3 RECREATES domain_events on EMPTY store only — ALTER ADD COLUMN splices sqlite_schema stored text, can never match whitespace-sensitive validateExactSchemaObjects; STORE_MIGRATION_REQUIRED guard on populated, precedent v1→v2), store-internals SCHEMA_VERSION=3, store-contracts manifest const, 2 version-pin test edits, 1 new migration test.
**Task B** (dep A) StoredEvent domainSchemaVersion + seam (9 files): store-contracts (field + error code), store-input, event-ledger-append, event-ledger-transaction (seam AFTER writeCommitEffects gated on COMMITTED disposition — replay is plain return, NO early-commit path; wrap apply failures AT INVOCATION SITE else normalizeOperationalError renames to STORE_UNAVAILABLE; rollback does NOT poison handle — commitAttempted=false path verified; context={database, frozen commit summary}, no writeCommitEffects signature change), event-read-decode, read-page-queries, sqlite-event-store (thread options), event-read-model-contract key-set edit, 1 new seam test.
Optional-with-default domainSchemaVersion (pinned constant, e.g. "moe-domain-schema/0" legacy marker) keeps write-side tests unchanged; read-side key-set edit unavoidable.
DoD wording both: "existing tests pass with only schema-version-literal and StoredEvent-key-set updates forced by the new schema; no assertion weakened or deleted".
