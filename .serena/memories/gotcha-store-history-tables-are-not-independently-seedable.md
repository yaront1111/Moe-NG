# @moe/store: no authoritative history table can be seeded in isolation and still reopen

## The trap
Writing a fixture that proves "any history at all blocks X", the obvious move is a raw
`new DatabaseSync(path)` insert into ONE table. `aggregate_heads` looks like the safe pick because it declares
no foreign key.

It is not safe. The store refuses to reopen:

    DurableStoreError: STORE_CORRUPT: aggregate heads do not exactly match the event ledger
      at validateSchema packages/store/src/sqlite-schema-integrity.ts:125
      at bootstrapAndValidateSchema packages/store/src/sqlite-schema-bootstrap.ts:197
      at SqliteEventStore.openForProject

`validateSchema` runs at EVERY open and is far stricter than the DDL:
- line 24 `PRAGMA foreign_key_check` — kills every orphan in domain_events / outbox_messages / command_decisions;
- lines 34-88 cross-check command_receipts against events, heads and outbox counts;
- lines 89-129 cross-check aggregate_heads against domain_events in BOTH directions (head without events, and
  events without a head);
- lines 131-210 cross-check sqlite_sequence against the three AUTOINCREMENT ledgers.

Plus `validateStartup` (decision-ledger.ts:34) re-materializes every receipt and decision afterwards.

Net: a receipts-only, events-only, outbox-only or heads-only database is UNOPENABLE. Absence of a foreign key
does not mean absence of an invariant.

## What to do instead
Produce the subsets through the PRODUCTION write surface, and pick calls whose footprints differ:
- `commitExpectedVersionDecision(...)` -> all five tables non-empty.
- `commit({... events: [{...}] })` with NO `outbox` drafts -> command_receipts / domain_events /
  aggregate_heads = 1, and command_decisions = 0 AND outbox_messages = 0.

The second is the one that discriminates: it is the only reachable fixture that leaves the decisions leg empty,
so it is what distinguishes a five-leg guard from a decisions-only one. Prove that with a drill — narrow the
guard's SQL to the decisions leg alone and require exactly that fixture to redden while the other stays green.

Assert the pre-state row counts of all five tables BEFORE the call, or a fixture that silently generated
nothing passes.

Found on task-1615065497f0489097a4bbc11cea9d6b. Related: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`,
`mem:gotcha-test-fixture-can-encode-the-missing-invariant`.
