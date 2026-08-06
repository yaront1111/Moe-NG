# @moe/store

`@moe/store` is Moe's first durable foundation slice. It owns the low-level atomic write that makes an accepted command receipt, ordered domain events, aggregate version, and transactional outbox messages visible together or not at all.

## Guarantees in this slice

- Production databases are absolute, canonical file paths using WAL, `synchronous=FULL`, foreign keys, defensive mode, and a verified application/schema identity. Ephemeral SQLite is available only through the explicitly test-only opener.
- `BEGIN IMMEDIATE` serializes writers. Expected aggregate versions prevent lost updates.
- Exact command bytes, target aggregate, expected version, and the request-identity algorithm are bound into a stable SHA-256 identity. An identical lost-response retry returns the original receipt; reuse with different bytes fails.
- Receipt results carry a versioned effect digest over event/outbox bytes, command-local ordinals, and SQLite-assigned global positions. Startup rejects physical, schema, foreign-key, ordering, or receipt/ledger inconsistencies.
- Event, aggregate, receipt, and outbox writes commit once. A transaction-control ambiguity quarantines the connection and returns `OUTCOME_UNKNOWN`; callers must reopen and reconcile the receipt.
- Input bytes are copied before the transaction. Proxies, accessors, sparse arrays, detached/shared buffers, ill-formed Unicode, oversized batches, and duplicate durable IDs fail with stable errors.
- Event and outbox cursors remain exact 64-bit `bigint` values. Bounded cursor APIs support aggregate replay, global projection replay, and pending-outbox relay without silent truncation.

## Deliberate boundary

This is the accepted-success storage primitive, not yet the complete authoritative command processor. Authentication, capability checks, the project/principal/command decision key, durable terminal rejection decisions, lease fencing, normalized domain projections, and domain event upcasters belong to the next command-core slice. Until that layer exists, this package must not be exposed directly as Moe's external mutation API.
