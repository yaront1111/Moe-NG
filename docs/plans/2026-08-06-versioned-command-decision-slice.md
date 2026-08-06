# Versioned Command Decision Slice Implementation Plan

**Goal:** Add a scoped, durable expected-version decision primitive that atomically commits proposed effects when the target version matches or records a stale-version outcome with no target business effect.

**Architecture:** `SqliteEventStore.commitExpectedVersionDecision` is an internal persistence primitive, not a command processor. A database with project-scoped history is durably bound to one project, while a fresh generic inspection open may remain unbound; mutations always require an explicitly project-asserted handle. For a new scoped key, one `BEGIN IMMEDIATE` rechecks the `(projectId, principalId, commandId)` tombstone and current aggregate version, then commits exactly one factual `EFFECTS_COMMITTED` or `NO_BUSINESS_EFFECT` decision with coverage fixed to `EXPECTED_VERSION_ONLY`. An already durable identical request may replay before opening a write transaction. Matching decisions reuse the event/head/outbox receipt writer. Stale decisions append one normalized `command.expected-version-rejected` audit event through the existing global event ledger and create no event, head, or outbox change on the target aggregate. Schema v2 migrates only an exact, empty v1 database; populated unscoped v1 receipts fail closed until an explicit reconciliation design exists.

**Tech Stack:** Node.js 24 `node:sqlite`, TypeScript 7, Vitest.

---

### Task 1: Specify scoped terminal decision behavior

**Files:**

- Test: `packages/store/src/command-decision-store.test.ts`
- Test: `packages/store/src/command-decision-scope.test.ts`
- Modify after RED: `packages/store/src/sqlite-event-store.ts`
- Modify after RED: `packages/store/src/index.ts`

- [x] Write a failing accepted-decision test against this shape:

  ```ts
  store.commitExpectedVersionDecision({
    key: {
      projectId: "project-1",
      principalId: "principal-1",
      commandId: "command-1",
    },
    commandKind: "goal.create",
    targetAggregateId: "goal-1",
    expectedVersion: 0,
    requestBytes: bytes("goal.create/v1"),
    committedResultBytes: bytes("created"),
    decidedAt: "2026-08-06T18:00:00.000Z",
    correlationId: "correlation-1",
    events: [{ eventId: "event-1", eventType: "goal.created", payload: bytes("payload") }],
  });
  ```

- [x] Assert one `EFFECTS_COMMITTED` decision, receipt/events/head/outbox, exact result bytes, cursor, scope key, and no rejection audit.
- [x] Assert a stale command returns durable `NO_BUSINESS_EFFECT / EXPECTED_VERSION_CONFLICT`, writes one normalized audit event on the global event cursor, and writes zero target receipt/event/outbox/head changes.
- [x] Run focused tests and confirm RED because the API does not exist.

### Task 2: Add schema v2 and exact migration

**Files:**

- Modify: `packages/store/src/sqlite-schema.ts`
- Add: `packages/store/src/sqlite-schema-manifest.ts`
- Modify: `packages/store/src/store-contracts.ts`
- Test: `packages/store/src/command-decision-integrity.test.ts`
- Test: `packages/store/src/store-project-and-schema-contract.test.ts`

- [x] Add an exact-manifest `command_decisions` table with independent composite scope columns, a 64-bit cursor, versioned SHA-256 records, factual outcome-shape checks, and an explicit business-receipt or audit-receipt linkage.
- [x] Add a singleton project binding plus per-receipt project scope and validate both before any write or replay.
- [x] Migrate schema v1 additively under the existing startup write lock; validate exact v1 schema first, add only v2 objects, and update manifest/version atomically.
- [x] Test empty migration from an independently frozen exact-v1 fixture. Test that a populated exact-v1 fixture is refused without mutation; never manufacture project/principal scope for an old receipt.
- [x] Test foreign, altered, and too-new schemas fail closed without mutation.

### Task 3: Implement one-transaction accept/reject/replay

**Files:**

- Modify: `packages/store/src/sqlite-event-store.ts`
- Modify: `packages/store/src/decision-ledger.ts`
- Add: `packages/store/src/decision-read-model.ts`
- Modify: `packages/store/src/event-ledger.ts`
- Modify: `packages/store/src/event-read-model.ts`
- Modify: `packages/store/src/store-runtime.ts`
- Modify: `packages/store/src/store-input.ts`
- Modify: `packages/store/src/store-digests.ts`
- Modify: `packages/store/src/store-rows.ts`
- Modify: `packages/store/src/store-internals.ts`
- Modify: `packages/store/src/index.ts`
- Add: `packages/store/src/*.js` runtime bridges for Node strip-types resolution
- Test: `packages/store/src/command-decision-store.test.ts`
- Test: `packages/store/src/command-decision-concurrency.test.ts`
- Test: `packages/store/src/project-binding-contract.test.ts`
- Test: `packages/store/src/store-project-and-schema-contract.test.ts`
- Test: `packages/store/src/store-runtime-entrypoint.test.ts`
- Test: `packages/store/src/store-bootstrap-ambiguity.test.ts`
- Test: `packages/store/src/store-commit-ambiguity.test.ts`
- Test: `packages/store/src/store-project-binding-tamper.test.ts`

- [x] Compute a versioned request digest over the independent project, principal, command, target aggregate, expected version, and exact request bytes.
- [x] Read the tombstone by all three key columns. Same key+digest returns the original outcome as historical with `requiresAffordanceRefresh=true`; same key+different digest throws `IDEMPOTENCY_CONFLICT` with no new rows.
- [x] Serialize on `BEGIN IMMEDIATE`, recheck the tombstone, and decide from the aggregate version inside that transaction.
- [x] Revalidate the live durable project binding inside every write transaction and before early decision replay; stale unbound inspection handles require reopen before scoped receipt reads.
- [x] On match, atomically write the business receipt/events/head/outbox and decision. On mismatch, atomically write only the decision plus a constrained internal audit receipt/event on the existing global event ledger.
- [x] Persist and recompute decision/result digests at startup and on reads; corrupted payload, linkage, outcome columns, scope, or positions must be `STORE_CORRUPT`.
- [x] Add a bounded decision cursor read without silent truncation; audit events remain queryable through the existing global event cursor.
- [x] Bound and snapshot request/result bytes. Prove normalized stale decision/audit fields exclude the tested raw request, rejected proposal result/events, raw correlation, credential/token payload samples, stack, SQL detail, and `nextAllowedCommands` data. Identifiers persist verbatim and must be non-secret daemon-issued values.
- [x] Cover same raw command ID in independent project databases and principal scopes, request-identity changes, stale/future mismatches, races, lost-response reopen/replay, hostile replay-only proposal fields, immutable returned bytes, rollback after effect insertion, and 64-bit cursor pagination.
- [x] Keep the public store runtime-private through a frozen composition facade; test that raw database/state/scope fields and internal mutators are absent under Node's strip-types runtime.
- [x] Treat an unacknowledged bootstrap commit as `OUTCOME_UNKNOWN` and reject append-only ledgers whose durable positions conflict with SQLite sequence evidence.
- [x] Distinguish a definitively rolled-back COMMIT failure from an unacknowledged committed outcome for bootstrap, ordinary effects, and scoped decisions.
- [x] Validate canonical path and deep ledger bytes before changing an existing database's journal mode; retry the valid concurrent WAL transition within a fixed busy bound.

### Task 4: Verify and review

**Files:**

- Modify: `packages/store/README.md`
- Modify: `docs/plans/2026-08-06-versioned-command-decision-slice.md`

- [x] Document that authentication/capability/domain reducers remain required above this primitive. Accepted result bytes remain opaque trusted-command-core input; this slice cannot claim affordance or secret exclusion for them.
- [x] Split oversized source and test files by responsibility before handoff.
- [x] Run `pnpm verify:store`, `pnpm verify:foundation`, `pnpm test`, strict typecheck, repeated race tests, and `git diff --check`.
- [x] Obtain independent transaction/integrity and API/scope adversarial reviews; resolve every BLOCKER/MAJOR before an explicit-path commit.

This slice does not claim a complete command processor or an authoritative `ACCEPTED`/`REJECTED` command verdict. Authentication, session revocation, capability, lease/epoch, graph/policy, and domain-transition decisions must later execute inside the same applying transaction before this primitive can be exposed through an adapter. Accepted result bytes need a trusted structured codec at that boundary. Cursor reads are row-count bounded but still need a total page-byte budget or streaming layer before external exposure. The development migration does not constitute a production backup/reconciliation strategy, and different-request conflicts are not yet durable attempt audits. The store package must remain behind that adapter boundary until then.
