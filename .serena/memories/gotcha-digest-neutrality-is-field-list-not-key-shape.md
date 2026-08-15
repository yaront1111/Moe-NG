# Gotcha: "adding a field breaks the digest" is usually FALSE here — check how the hash is built

Recurring planning error in `@moe/store`. A plan will assert that adding a field to an event
draft causes a write/replay digest divergence and `STORE_CORRUPT`. Verify before believing it.

## The actual mechanism

`identifyCommandEffects` (store-digests.ts:190-221) and every sibling `identify*` function
hash an **explicit, hand-written field list**:

```ts
for (const event of input.events) {
  updateUnsignedInteger(hash, event.aggregateSequence);
  updateString(hash, event.eventId);
  updateLengthFramed(hash, event.payload);
  // ...named fields only, never Object.keys(event)
}
```

Consequences:
- An extra property riding along at runtime (very common — the append site does
  `effectEvents.push({ ...event, aggregateSequence, ... })`) **cannot** change digest bytes.
- `identifyCommandRequest` hashes only aggregateId / expectedVersion / commandBytes.
- So hardcoded `requestSha256` / `effectSha256` fixtures in tests stay VALID when you add a
  StoredEvent field. Do NOT "refresh" them — if they break, you changed something real.

## What IS load-bearing: the type-level Omit

`EffectEventDraft extends Omit<SnapshotEventDraft, "domainSchemaVersion" | "outbox">` is
required, but for TYPECHECK reasons, not digest reasons. Two consumers rebuild effect events
from receipt rows that never select the column:
- `DecodedReceiptEventBody = Omit<EffectEventDraft, ...>` (event-read-decode.ts:55-58)
- the replay literal at event-read-materialization.ts:156-162

Drop the Omit and both fail to compile. That is the real proof, and the compiler gives it to
you for free — you do NOT need the risky "temporarily break it and observe" experiment.

## How to prove it cheaply and safely

Adding the field WITHOUT the Omit and reading the tsc output is a mutation of a SHARED tree.
On this fleet a sibling's broad `git add` can commit your deliberately-broken window under
their task ID (see `mem:gotcha-shared-tree-broad-add-sweep`), and rails forbid stash and
sibling worktrees, so there is no safe variant. Instead reason from the errors the correct
build already produced: if only the intended file errors and the receipt/replay files do not,
the Omit is doing exactly its job.

## Rule
To change what an effect digest covers, bump `COMMAND_EFFECT_IDENTITY_VERSION`. Adding a
field to the draft type is not sufficient and not automatic.
