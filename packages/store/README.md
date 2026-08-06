# @moe/store

`@moe/store` is Moe's durable event-ledger foundation. It atomically persists command receipts, ordered domain events, aggregate heads, transactional outbox messages, and a narrowly scoped expected-version decision record.

## Guarantees in this slice

- A database that carries project-scoped history is durably bound to exactly one project. A fresh database opened through generic `open(path)` may remain unbound until `openForProject(path, projectId)` establishes the first binding. Mutations require that explicitly project-asserted handle.
- Generic `open(path)` is a business-mutation-disabled inspection handle, not an operating-system read-only connection: startup may create or migrate an empty pre-release schema and establish required SQLite safety pragmas, but command/event writes remain refused.
- Production databases use absolute canonical paths, WAL, `synchronous=FULL`, foreign keys, defensive mode, and verified application/schema identities. Canonical-path and deep ledger validation occur before an existing file's persistent journal mode can change. Ephemeral openers are test-only.
- `BEGIN IMMEDIATE` serializes writers. Every write transaction revalidates the live singleton project binding before replay or mutation. The scoped key is `(projectId, principalId, commandId)`, and request identity also covers command kind, target aggregate, expected version, and exact request bytes.
- A matching expected version commits the proposed receipt/events/head/outbox and the decision atomically. A mismatch commits `NO_BUSINESS_EFFECT / EXPECTED_VERSION_CONFLICT` plus one normalized rejection-audit event on the global event cursor, with no target business effect.
- An identical retry replays the original decision and sets `requiresAffordanceRefresh=true`. Reusing the scoped key for a different request fails with `IDEMPOTENCY_CONFLICT` and creates no effect.
- Stored events retain the physical receipt identity in `commandId` and `requestSha256`. Events written for a decision separately expose the outer command provenance in `decisionTrace`.
- Receipt digests bind their durable effect bytes and positions; decision digests additionally bind command scope and receipt linkage. A separate relational invariant binds every receipt to the database project. Startup rejects schema, binding, scope, foreign-key, ordering, tombstone, reserved-namespace, or ledger inconsistencies, including missing, duplicate, malformed, non-contiguous, or unknown SQLite sequence evidence.
- Event, outbox, and decision cursors remain exact 64-bit `bigint` values and have bounded pagination APIs.
- The exported store is a frozen composition facade with an ECMAScript-private core slot. Internal database handles, scope flags, state, and protected ledger helpers are not runtime properties of the public object.

## Exact boundary

`commitExpectedVersionDecision` proves only scoped idempotency and the target's expected version. Its coverage is always `EXPECTED_VERSION_ONLY`. It does **not** perform authentication, session revocation, capability checks, lease/epoch fencing, graph or policy checks, or domain-transition validation. Those mutable checks must eventually run inside the same applying transaction in the command core before any external adapter can expose mutation commands.

Accepted `committedResultBytes` are opaque bytes supplied by a trusted future command core. This package does not yet enforce a structured result schema, secret exclusion, or removal of current affordances from those accepted bytes. The normalized stale result and rejection audit exclude request bytes, rejected proposal bytes/events, raw correlation IDs, stack traces, and SQL details; project, principal, command, kind, and aggregate identifiers are persisted and therefore must be non-secret daemon-issued identifiers.

The schema-v1-to-v2 path is pre-release development migration evidence only: it accepts an exact empty v1 database and refuses populated v1 history. It is not a production backup or reconciliation strategy. Different-request idempotency conflicts are refused but are not yet written as durable attempt-audit records.

Cursor APIs are row-count bounded but do not yet enforce a total decoded-byte ceiling across a page. No external adapter may expose caller-controlled page sizes until a byte-budgeted or streaming read layer is added.

Keep this package internal until the authoritative command core owns the complete decision and a structured durable-result codec.
