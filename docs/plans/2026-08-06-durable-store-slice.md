# Durable Store Slice Implementation Plan

**Goal:** Build the first production foundation: a SQLite event store that atomically commits command receipts, ordered domain events, aggregate versions, and outbox messages.

**Architecture:** One sole-process `DatabaseSync` connection uses `BEGIN IMMEDIATE`, expected-version checks, exact request-byte identity, and a transactional outbox. The API is domain-neutral so planner/graph semantics remain outside this slice.

**Tech Stack:** Node.js 24 `node:sqlite`, TypeScript 7, Vitest.

---

### Task 1: Specify atomic command/event/outbox behavior

**Files:**

- Create: `packages/store/package.json`
- Create: `packages/store/tsconfig.json`
- Create: `packages/store/src/sqlite-event-store.test.ts`
- Create after RED: `packages/store/src/sqlite-event-store.ts`
- Create after RED: `packages/store/src/index.ts`
- Modify: `package.json`

- [x] Test first commit: expected aggregate version `0` produces versions `1..n`, one durable command receipt, exact event bytes, and ordered outbox rows.
- [x] Run the focused test and confirm failure because `SqliteEventStore` does not exist.
- [x] Implement SQLite version check (`>=3.51.3`), schema migration, WAL/full-sync file mode, foreign keys, and `BEGIN IMMEDIATE` commit/rollback.
- [x] Test same command/request replay, same ID/different request conflict, expected-version conflict, and cross-command ID collisions with zero partial rows.
- [x] Test close/reopen persistence and real worker-thread serialization on a temporary file.
- [x] Expose exact health, event, command, aggregate-version, global-event, and cursor-bounded pending-outbox reads for verification.
- [x] Run `pnpm verify:store`, full foundation verification, and strict typecheck; stage the exact slice paths for commit.

### Adversarial hardening added during review

- [x] Refuse unrelated, forged, or structurally altered SQLite databases before use.
- [x] Normalize receipts and verify their events, outbox rows, versions, hashes, timestamps, and aggregate heads at startup and replay.
- [x] Reject hostile JavaScript containers, detached/shared bytes, ill-formed Unicode, and resource-limit violations before the transaction.
- [x] Provide stable lifecycle, durable-ID conflict, busy/unavailable, and ambiguous-outcome errors.
- [x] Preserve 64-bit cursors and prove ordered pagination beyond 100 rows.
- [x] Prove simultaneous fresh startup, conflicting writers, same-command replay, and lost-response recovery after process exit.

This slice is deliberately below the authoritative command processor. Project/principal-scoped accepted and rejected decision rows, authentication/capability checks, lease fencing, domain projections, and semantic upcasters remain owned by the next command-core slice; `@moe/store` is not an external mutation API by itself.

The wished-for API exercised by the RED test is:

```ts
const store = SqliteEventStore.open(databasePath);
const result = store.commit({
  aggregateId: "goal-1",
  commandId: "cmd-1",
  commandBytes: bytes("goal.create"),
  committedAt: "2026-08-06T10:00:00.000Z",
  expectedVersion: 0,
  events: [{
    eventId: "evt-1",
    eventType: "goal.created",
    payload: bytes("payload"),
    outbox: [{ messageId: "msg-1", topic: "goal.events", payload: bytes("wire") }],
  }],
});
```
