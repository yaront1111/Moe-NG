# Planning handoff — task-16d5bc3a10864351adf5be10dfa7df00

## Status
Blocked before plan submission because its required production surfaces are not yet committed.

## Fresh measurements
- Committed schema is v4 and `domain_events` has no `(event_type, global_position)` index; EXPLAIN uses a full scan for an event-type predicate.
- The public `@moe/store` surface exposes aggregate/global paging only; there is no typed event stream query.
- `apps/daemon` already declares `@moe/store` in its manifest and lock importer.
- task-d92b1b15a5b048e49671ed34990fa4a1 is still WORKING and its activation-reader bytes are foreign WIP, so its no-cap/ambiguity behavior must be remeasured only after DONE.
- Design SHA was verified; the design explicitly permits node/actor/type filters on the event API.

## Decision
Use option (c): a generic indexed store query. Do not use:
- option (a): the current `CoordinationEffectQuery` carries only effect/session/time; adding sufficient derived identity would expand exact wire/address codecs across >12 files and idempotency alone cannot preserve cross-aggregate ambiguity;
- option (b): a daemon-specific side table cannot be made historically complete by the generic store without daemon-aware payload decoding/backfill, so an empty new index could forge ABSENT.

## Prerequisite slices created
1. `task-d20ffd0775b4420bb2318c79019b4127` — additive schema v5 index `domain_events_event_type_position(event_type, global_position)`, populated-safe migration and query-plan proof.
2. `task-69c2c9e7ee084afea16c2b2ff935f459` — public bounded `SqliteEventStore.readEventsByTypeAfter(eventType, afterGlobalPosition, limit?, maxDecodedBytes?)`; hard-depends on d20.

The current task should depend on task-69c2 and also wait for d92 to be DONE.

## Future daemon plan shape
After prerequisites land, remeasure the bare `@moe/store` edge with a compiled consumer probe and the committed d92 reader. TDD the daemon adapter so it pages the complete activation event stream through `readEventsByTypeAfter`, never early-returns on the first hit, and therefore still detects a second matching activation on another aggregate with exact `FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS` and daemon layer. Add a real store proof with >6,500 unrelated events plus one activation: assert total global row count and exact filtered candidate/page counts, not elapsed time. Mutation drills must prove both that delegating to the unfiltered global reader makes the bounded-work test red and that early return makes the ambiguity test red. The final slice owns store+daemon+repo gates and adversarial review because it integrates a schema/public API change.

See also the split notification msg-e057c37aa94f4a8a904865b20e3a212a.