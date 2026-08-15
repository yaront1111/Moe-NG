# Gotcha: `commit()` dedupe keys on expectedVersion, so the naive "same commandId = replay" is wrong

Found 2026-08-08 designing `@moe/coordination`'s mailbox on the public `SqliteEventStore` seam.

## The trap

`SqliteEventStore.commit()` looks idempotent: same `commandId` + same bytes -> `disposition:
"REPLAYED"`. So the obvious mailbox design is "derive commandId from the message id; a resend
just replays."

It does not work. `identifyCommandRequest` (`packages/store/src/store-digests.ts`) hashes
**aggregateId + expectedVersion + commandBytes**. `expectedVersion` is in the digest.

`resolveCommand` (`event-ledger-transaction.ts:100`) loads the receipt FIRST and compares
`requestSha256`; a mismatch throws `CommandIdConflictError` (`COMMAND_ID_CONFLICT`).

So on an ordered aggregate like a mailbox:

```
send M1  -> aggregate v0 -> v1        requestSha256 = H(agg, 0, bytes)
send M1  -> aggregate now v1          requestSha256 = H(agg, 1, bytes)   <-- different!
         -> receipt exists, digests differ -> COMMAND_ID_CONFLICT
```

An identical resend of an identical message reports a **conflict**, not a replay, purely
because the aggregate advanced in between. Any at-least-once producer on a shared ordered
aggregate hits this on its first retry.

## The fix that works with the public surface only

Derive TWO identities with different inputs:

- `commandId = f(aggregateId, messageId)` — no bytes, no version. A resend always addresses
  the same durable command slot.
- `eventId = f(aggregateId, messageId, canonicalBytes)` — identical bytes give an identical
  event id; different bytes cannot collide with it.

Then, before committing and again on `COMMAND_ID_CONFLICT`:

```ts
const receipt = store.getCommandReceipt(commandId);
if (receipt !== null) {
  return receipt.eventIds.includes(derivedEventId)
    ? DEDUPLICATED          // identical bytes already durable
    : IDEMPOTENCY_CONFLICT; // same id, different bytes — a real conflict
}
```

`receipt.currentVersion` is the aggregate sequence of that commit, so when each command
commits exactly ONE event it doubles as an O(1) id-to-sequence index — no page scan needed
to resolve a message by id.

## Corollaries

- **Never put a timestamp in the bytes you hash for dedupe.** Put server stamps in event
  `metadata`; a retry seconds later must hash identically.
- `EXPECTED_VERSION_CONFLICT` is the normal concurrency signal on a shared aggregate: retry
  with a freshly read version under a bounded attempt cap, then fail closed.
- Map `OUTCOME_UNKNOWN` to its own ambiguous outcome. It is neither success nor failure and
  must never be reported as delivered.

Related: `mem:task-task-f837ce45bd344b868ad84e72ffc549f2-handoff`.
