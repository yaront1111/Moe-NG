# @moe/store

The durable spine. This is the only package in the workspace that opens SQLite, and the
only place a command decision becomes fact: a receipt, its ordered domain events, the
aggregate head, the outbox rows and the decision record land in one `BEGIN IMMEDIATE`
transaction or none of them do. It proves exactly two things about a write — scoped
idempotency and the target's expected version (`EXPECTED_VERSION_ONLY`) — and deliberately
knows nothing about goals, policy or leases. `src/` imports no `@moe/*` package at all;
`node:sqlite`, `node:crypto`, `node:fs` and friends are the whole dependency list.
`README.md` states the guarantees and the exact boundary; read it before changing one.

## Seams

- Export map is three entries: `.` → `src/index.ts`, `./projections/*`, `./subscriptions/*`.
  `src/outbox-relay/**` is deliberately outside it and has no importer outside this package.
- `SqliteEventStore.openForProject(path, projectId)` is the only production opener, reached
  through `apps/daemon/src/daemon-store-acquisition.ts` (`FoundationStoreOpener`), which then
  runs `ensureGenesisRecoveryBinding`. `open(path)` is a mutation-disabled inspection handle;
  `openEphemeralForTest` / `openEphemeralForProjectTest` are the documented test escapes.
- Writes: `commit`, `commitWithApply`, `commitExpectedVersionDecision`,
  `commitExpectedVersionDecisionLegs`, `commitExpectedVersionDecisionWithApply`.
  Reads: `readEventsAfter`, `readEventsByTypeAfter`, `readCommandDecisionsAfter`,
  `readPendingOutboxPage`, `readEventHorizon`, `enumerateAggregateIdsByPrefix`.
- `./projections/*`: `foldProjection`, `rebuildProjection`, `compileStoredEventUpcaster` —
  used by `apps/daemon/src/projections/board-projection-{contracts,fold,service}.ts`.
- `./subscriptions/*`: `readSubscriptionPage`, `subscription-writes.js`, `refuse` —
  `apps/daemon/src/daemon-store-foundation-composition.ts`, `http/event-resume-command.ts`.
- Backup and restore: `createBackupGeneration` / `verifyBackupGeneration`
  (`apps/daemon/src/recovery/restore-controller.ts`), `installInitialRecoveryBinding`
  (`apps/daemon/src/identity/genesis-recovery-binding.ts`), and the anchor readers
  `prepareRecoveryAnchor` / `installRecoveryAnchor` / `inspectRecoveryAnchor`, whose only
  real drivers are `tests/fault/disaster-restore/*`.
- Only `apps/daemon` and `packages/coordination` declare `@moe/store` in a `package.json`.

## The model

- **One frozen facade over a 17-class chain.** `SqliteEventStore` holds an ECMAScript-private
  `#core` built by `createDecisionLedgerCore`, itself a frozen object of bound methods. The
  behavior lives in single inheritance: `StoreRuntime` → `EventReadDecodeStore` →
  `…Materialization` → `…Query` → `EventReadModelStore` → `EventOutboxStore` →
  `EventAppendStore` → `EventRecoveryStore` → `EventTransactionStore` →
  `EventLedgerStore` → `DecisionReadModelStore` → `DecisionReplayStore` →
  `DecisionPreflightStore` → `DecisionTransactionStore` → `RecoveryInstallStore` →
  `RecoveryInitialInstallStore` → `DecisionLedgerStore`. The files are split to hold the
  250-line rail, so grep for the method name, never guess the file from the capability.
- **The project binding is a singleton row.** `resolveProjectBinding`
  (`sqlite-schema-bootstrap.ts`) reads `store_project_binding` under the startup lock.
  Ledger history with no binding, or scope rows disagreeing with it, is `STORE_CORRUPT`; a
  different `projectId` is `PROJECT_SCOPE_MISMATCH`. Every write transaction re-validates it.
- **The schema manifest is the census.** `SCHEMA_VERSION = 7` (`store-internals.ts`),
  `SQLITE_SCHEMA_MANIFEST_VERSION = "moe-sqlite-schema/7"`. `validateExactSchemaObjects`
  compares every `sqlite_schema` row byte-for-byte (after trimming a trailing `;`) against
  `SCHEMA_OBJECT_SQL`, and counts them. `migrateLocked` walks v1→v7 in order; a higher
  `user_version` is `STORE_SCHEMA_INVALID`, an unrecognized one `DATABASE_IDENTITY_MISMATCH`.
- **Startup re-proves the ledger, not just the schema.** `validateSchema` runs
  `foreign_key_check`, `quick_check` and three hand-written SQL sweeps: receipts versus their
  events, aggregate heads exactly matching the ledger, and `sqlite_sequence` evidence for
  `domain_events` / `outbox_messages` / `command_decisions`. Each failure is `STORE_CORRUPT`.
- **Replay is byte equality, never recomputation.** `store-digests.ts` owns the one preimage:
  `identifyCommandRequest`, `identifyExpectedVersionRequest`, and `identifyReplayRequest`,
  which re-reads both co-inputs off the stored decision so an honest replay still matches
  after the aggregates advanced. An identical retry echoes the decision with
  `requiresAffordanceRefresh=true`; a different request on the same scoped key is
  `IDEMPOTENCY_CONFLICT` with no effect.
- **Multi-leg decisions.** `MAX_DECISION_LEGS = 8`. `legs[0]` is primary and is what the
  decision record describes; a later leg with an exactly empty `events` array is a read-only
  fence and grants no receipt authority. Leg receipts are `<canonical>:leg:<index>` via
  `LEG_RECEIPT_SEPARATOR`, so SQL recovers the canonical ID by truncation and leg 0 stays
  byte-identical to a single-aggregate decision.
- **Two refusal styles.** The ledger *throws* `DurableStoreError` with one of 17
  `DurableStoreErrorCode` values. Everything added later *returns* a frozen union with its
  own closed, `Object.freeze`d code list plus a layer: `SubscriptionCode`/`SubscriptionLayer`,
  `ProjectionFoldCode`, `ProjectionRebuildCode`, `OutboxRelayCode`/`OutboxRelayLayer`,
  `RECOVERY_INSTALL_REASON_CODES`, `RECOVERY_ANCHOR_REASON_CODES`, `BACKUP_GENERATION_REASONS`.
- **Pages are bounded twice.** `MAX_PAGE_SIZE = 1_000` rows *and*
  `MAX_PAGE_DECODED_BYTES = 2 × MAX_COMMIT_BYTES` (64 MiB). `requirePageDecodedByteLimit` lets
  a caller lower the ceiling and never raise it; preflight picks the largest ordered prefix
  and fails explicitly rather than returning a zero-progress page. Cursors stay exact `bigint`.
- **Caller records are snapshotted before use.** `store-input-*.ts` (`snapshotCommitInput`,
  `snapshotCommandDecisionKey`, `snapshotDenseArray`, `readOwnDataProperty`) reduces hostile
  input to own data properties first; nothing downstream re-reads a caller object.
- **Connection safety is asserted, not requested.** After setting them, `#open` reads back
  `foreign_keys`, `synchronous=FULL`, `trusted_schema=OFF`, `recursive_triggers=OFF`,
  `wal_autocheckpoint=1000` and `busy_timeout=5000`, calls `enableDefensive(true)`, and
  verifies `realpathSync.native` of the path SQLite actually opened.
  `MINIMUM_SQLITE_VERSION = "3.51.3"`. `establishJournalMode` retries a busy WAL switch 500×
  with `Atomics.wait` — there is no async escape from this synchronous path.

## Gotchas

- **Every non-test `.ts` here needs its sibling one-line `.js` bridge**
  (`export * from "./x.ts";`) — 82 exist. The exceptions are `src/index.ts` (the export map
  points at the `.ts` directly) and the three `*-test-helpers.ts`.
- `tests/security/boundary-roster.security.ts` pins `"packages/store": 5` and names
  `DECISION_LEDGER_LAYER`, `RECOVERY_ANCHOR_LAYER`, `RECOVERY_BINDING_CODEC_LAYER`,
  `RECOVERY_INSTALL_LAYERS`, `RECOVERY_INSTALL_TRANSACTION_LAYER`. A sixth `*_LAYER` export
  reds the security lane.
- `tests/integration/distribution/store-pack-boundary.test.ts` shells out to a real
  `pnpm pack --dry-run` in this folder: `files` must stay `["src", "tsconfig.json"]`, the pack
  must exceed 200 paths, carry no `test-fixtures/`, and hold no non-`src/` `.json` but
  `package.json` and `tsconfig.json`. It also pins `test-fixtures/recovery-slot-manifest-v1.json`
  at exactly 405 bytes and sha256 `56e2189c…`.
  `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json` too.
- Editing any SQL string in `sqlite-schema-manifest.ts` without a matching migration step
  makes **every existing database refuse to open** with `STORE_SCHEMA_INVALID`.
- `proposedDecision()` in `command-decision-test-helpers.ts` is scoped to project `"project-1"`;
  an ephemeral store opened under another id refuses its commit
  (`store-domain-schema-version.test.ts` documents this in a comment).
- Seven `.mjs` workers (`*-race-worker.mjs`, `store-entrypoint-smoke-worker.mjs`,
  `projections/projection-crash-worker.mjs`, …) are spawned with
  `execArgv: ["--experimental-strip-types"]`. Vitest's `.js`→`.ts` rewrite does not reach
  them, so a missing bridge surfaces only in those worker suites.
- The root vitest config caps `maxWorkers` between 2 and 8 *because* the store suites open
  SQLite temp stores; an unbounded fork pool on Windows produces timeout-only failures in
  files that pass standalone. `VITEST_MAX_WORKERS` overrides.

## Testing

- One file, from the repo root: `pnpm vitest run packages/store/src/decision-ledger.test.ts`
  (root config: `packages/**/*.test.ts`, `environment: "node"`, `pool: "forks"`).
- Whole folder: `pnpm test:store` (`vitest run packages/store/src`) or
  `pnpm --filter @moe/store test` (the same run, via `--root ../..`).
  `pnpm verify:store` = `pnpm typecheck && pnpm test:store`.
- Outside coverage: `pnpm test:security` (`durable-store-boundaries.security.ts`,
  `project-integrity-hostile-cases.ts`, `integrity-hostile-cases.ts`, `boundary-roster`),
  `pnpm test:fault` (`tests/fault/disaster-restore/*` — the only arms that drive every
  `RECOVERY_ANCHOR_FAULT_POINTS` crash point), `pnpm test:migration`
  (`tests/migration/import/import-determinism.test.ts`), the two
  `tests/integration/distribution` pack suites, and 36 `tests/e2e` files.
- `projections/projection-generated-history.test.ts` sweeps seeded `mulberry32` histories over
  a fixed `SEEDS` array — no clock, no `Math.random` — and asserts its own shape, so a run
  that generated zero cases fails instead of passing silently.
