# Handoff: Transactional outbox relay + durable inbox dedupe (SPIDR step 3/5)

Commit `2443a6a` on `moe/work-2026-08-08`, explicit pathspec, **7 new files** (+959)
under `packages/store/src/outbox-relay/`. Sizes: `transactional-outbox-relay.ts` 266,
`outbox-relay-digests.ts` 232, `outbox-relay-contracts.ts` 59,
`transactional-outbox-relay.test.ts` 399, plus three one-line `.js` bridges.

Gate: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` -> exit 0,
25 files / 201 tests. Root sweep `pnpm test` -> 123 files, 1801 passed / 1 skipped.

## The API steps 4-5 wire against

```ts
relayMessage(store: RelayCommitSeam, request: OutboxRelayRequest): OutboxRelayResult
// request: { commit: CommitInput, consumerId, message: OutboxRelayMessage,
//            projection: { checkpoint, name, reducers, state, upcaster } }
```

`RelayCommitSeam` is STRUCTURAL (`{commitWithApply(input, apply): CommitResult}`), so
`SqliteEventStore` satisfies it without the relay importing the class at runtime.

Result is a frozen 3-arm union discriminated on `outcome`:
- `APPLIED` — `commit`, `checkpoint`, `state`, `stateDigest`
- `ALREADY_APPLIED` — `deduplicatedBy: "INBOX" | "COMMAND_RECEIPT"`, `commit` (null for INBOX)
- `REFUSED` — `code`, `layer`, `detail`, `fold` (the fold's own verdict verbatim)

Layers: `COMMIT | INBOX | INPUT | PROJECTION`. Codes: `OUTBOX_RELAY_` +
`COMMIT_MISMATCH | INBOX_CONFLICT | INBOX_WRITE_FAILED | INPUT_INVALID |
PROJECTION_CONFLICT | PROJECTION_REFUSED | PROJECTION_WRITE_FAILED`.

**Payload fields live only on the arm that owns them** — `state`/`checkpoint`/
`stateDigest` exist ONLY on `APPLIED`. That is a deliberate answer to
`mem:gotcha-union-refusal-echo-unnarrowed`: an unnarrowed `result.state` is a compile
error here, unlike in the fold's union.

## Order inside the apply callback — do not reorder

1. `SELECT inbox_receipts` by `(consumer_id, message_id)`. Matching digest rolls back as
   ALREADY_APPLIED/INBOX **before any reducer runs**; differing digest is INBOX_CONFLICT.
2. `SELECT CAST(global_position AS TEXT), event_id, command_event_index FROM domain_events
   WHERE command_id = ?` and rebuild frozen `StoredEvent`s from the pre-transaction
   snapshot. `aggregateSequence = summary.previousVersion + index + 1`.
3. Compare-and-set the durable `projections` row against the supplied checkpoint AND the
   canonical prior-state digest. Row absence is legal ONLY at position 0.
4. `foldProjection` over exactly that array.
5. One guarded upsert (`ON CONFLICT DO UPDATE ... WHERE last_applied_position = ? AND
   state_digest IS ?`) then the inbox INSERT, each asserting `changes === 1`.

**Never insert `outbox_messages`.** `writeCommitEffects` already wrote
`EventDraft.outbox` under the same open transaction; a second insert would double it.

## Things a consumer will get wrong if it guesses

1. **A redelivery rolls back its own fresh command too.** Dedupe throws the rollback
   sentinel, so the duplicate delivery's events/outbox rows never commit. That is why
   `ALREADY_APPLIED.commit` is `null` for INBOX but carries the replayed receipt for
   COMMAND_RECEIPT.
2. **Redelivering needs a bumped `expectedVersion`.** After the first delivery the
   aggregate is at 1, so a redelivery at `expectedVersion: 0` dies with
   EXPECTED_VERSION_CONFLICT before apply ever runs and never reaches the inbox check.
   The restart-durability proof MUST use fresh command/event/outbox IDs at the new version.
3. **One commandId reused for two DIFFERENT inbound messages** returns
   ALREADY_APPLIED/COMMAND_RECEIPT and never writes the second inbox receipt, because
   `commitWithApply` skips apply entirely on command replay. Honest and distinguishable;
   this is exactly why the two dedupe labels exist.
4. **Only the private non-exported `RelayRollback` is translated back into a result**,
   unwrapped from `DurableStoreError.cause` on `PROJECTION_APPLY_FAILED`. If ROLLBACK
   itself fails, the store raises `OUTCOME_UNKNOWN` instead, the unwrap does not match,
   and it is rethrown — uncertainty keeps its authority. Verified against
   `event-ledger-recovery.ts:22-46`.
5. `canonicalProjectionState` hashes and deep-clones in ONE walk and `APPLIED.state` is
   the clone the digest covers, so the reported state and digest cannot describe two
   different objects.

## Test techniques worth reusing

- **Scoped SQLite fault injection**: open a SECOND `DatabaseSync` on the same file after
  the store bootstrapped the schema, `CREATE TRIGGER relay_fault BEFORE INSERT ON <table>
  BEGIN SELECT RAISE(ABORT, ...); END`, run, then DROP in a `finally`. ABORT rolls back
  only the statement and leaves `isTransaction` true, which is what the store's rollback
  path expects. A `TEMP` trigger also works but is per-connection, so it would not be
  visible to the store's connection.
- A fault at `domain_events`/`outbox_messages` happens BEFORE apply and surfaces as
  `STORE_UNAVAILABLE` ("commit command effects failed"), not as a relay refusal.
- The fault matrix asserts its own label list, so a sweep that generates zero cases
  cannot pass silently.

See `mem:gotcha-digest-mutation-that-proves-nothing` for the two mutation traps this
task hit.
