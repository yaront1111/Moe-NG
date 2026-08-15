# Event read-model decomposition (packages/store)

`EventReadModelStore` (was 664 lines) is now a 93-line compatibility facade at the
top of a four-level internal inheritance chain:

`StoreRuntime` -> `EventReadDecodeStore` -> `EventReadMaterializationStore` ->
`EventReadQueryStore` -> `EventReadModelStore` -> `EventLedgerStore` -> ...

- `event-read-decode.ts` - stored-row decoding + detached snapshot construction only.
  Owns `page()`, `mapStoredEvent`, `mapOutboxMessage` (both widened `private` ->
  `protected`), and focused decoders `decodeReceiptRow`, `decodeReceiptEventIdentity`,
  `decodeReceiptEventBody`, `decodeReceiptOutboxIdentity`, `decodeReceiptOutboxBody`.
  No SQL, no public read methods.
- `event-read-materialization.ts` - `RECEIPT_OUTBOX_QUERY` (byte-identical, asserted by
  the EXPLAIN QUERY PLAN case in `sqlite-event-store-core.test.ts`), `loadReceipt`,
  `validateAllReceipts`. Consumed by `EventLedgerStore` through inheritance.
- `event-read-query.ts` - protected `aggregateEventPage` / `globalEventPage` /
  `pendingOutboxPage`. Each owns its `readSnapshotOperation` label so the `limit + 1`
  preflight and the blob materialization stay on one `BEGIN DEFERRED` snapshot.
- `event-read-model.ts` - the seven public methods only; re-exports
  `RECEIPT_OUTBOX_QUERY` so `event-ledger.ts` / `sqlite-event-store.ts` / `index.ts`
  need no change. None of the three internal classes reaches the package root.

## Invariants that must survive future edits
- Comparison decodes inside `loadReceipt` that sit behind `||` short-circuits
  (`aggregate_id`, `request_sha256`, `committed_at`, `created_at`) stay INLINE. Moving
  them into a decoder would change which STORE_CORRUPT message wins.
- Decoder bodies use sequential `const` statements before the return literal so field
  evaluation order is fixed independently of key order.
- Page envelopes/items and receipt envelopes/id arrays are frozen; `StoredEvent` and
  `PendingOutboxMessage` objects and their byte arrays are mutable detached copies.
- Aggregate cursors are `number`, global/outbox cursors are `bigint`.

`event-read-model-contract.test.ts` characterizes all of the above through the public
`SqliteEventStore` surface; it is the regression net for any further move.
