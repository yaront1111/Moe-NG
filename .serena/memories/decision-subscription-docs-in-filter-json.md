# Decision: subscription cursors/snapshots are versioned docs in event_subscriptions.filter_json

Human-approved 2026-08-08 (task-7617c00d). The v3 schema is EXACT-validated on every open
(`validateExactSchemaObjects` + single-row `store_metadata`), so no module can add tables,
columns, indexes, or metadata keys. Anything durable outside the ledger must live in the
three v3 extension tables as-is: `event_subscriptions(subscriber_id PK, filter_json, created_at)`,
`cursor_generations(generation PK, created_at, reason)`, `projections`.

Pattern: `filter_json` carries a versioned, digest-bound JSON doc, not just a filter.
- Subscriber doc `moe-subscription/1`: {version, projection, filter, cursor:{generation,
  position-as-decimal-string}, receiptDigest}.
- Snapshot doc `moe-subscription-snapshot/1` in a sentinel row keyed
  `moe-snapshot/<projection>` (reserved prefix refused for real registrations on EVERY
  entry point).
- receiptDigest = length-framed sha256 over the exact stored canonical text.
- Invariant: every generation advance upserts a baseline snapshot per covered projection in
  the same BEGIN IMMEDIATE txn → CURSOR_GAP is recoverable by construction.

Consequence for later tasks (control room stream, hardening step 5): read these docs via the
subscriptions module, never raw filter_json parsing; a v4 schema migration that promotes
cursor columns must migrate these docs. See
`mem:task-task-7617c00dfc4a46eb81ebb8673f724855-handoff`.
