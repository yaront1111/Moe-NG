import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  DurableStoreError,
  MINIMUM_SQLITE_VERSION,
} from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommandReceipt,
  CommitExpectedVersionDecisionInput,
  CommitInput,
  CommitResult,
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
  StoreHealth,
} from "./store-contracts.js";
import { createDecisionLedgerCore } from "./decision-ledger.js";
import type { DecisionLedgerCore } from "./decision-ledger.js";
import { requireIdentifier } from "./store-input.js";
import { readScalar, requireRowString } from "./store-rows.js";
import {
  bootstrapAndValidateSchema,
  canonicalDatabasePath,
  compareVersions,
  isFreshDatabaseFileCandidate,
  isSqliteBusy,
} from "./sqlite-schema.js";

export * from "./store-contracts.js";
export { RECEIPT_OUTBOX_QUERY } from "./event-ledger.js";

const journalModeRetrySignal = new Int32Array(new SharedArrayBuffer(4));
const JOURNAL_MODE_RETRY_COUNT = 500;
const JOURNAL_MODE_RETRY_DELAY_MILLISECONDS = 10;

function establishJournalMode(
  database: DatabaseSync,
  expectedJournalMode: "memory" | "wal",
): string {
  let lastBusyError: unknown;
  for (let attempt = 0; attempt <= JOURNAL_MODE_RETRY_COUNT; attempt += 1) {
    try {
      const current = requireRowString(
        database.prepare("PRAGMA journal_mode").get() ?? {},
        "journal_mode",
      );
      if (current === expectedJournalMode) {
        return current;
      }
      const requested = requireRowString(
        database.prepare("PRAGMA journal_mode = WAL").get() ?? {},
        "journal_mode",
      );
      if (requested !== expectedJournalMode) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          `SQLite returned journal mode ${JSON.stringify(requested)}, expected ${JSON.stringify(expectedJournalMode)}`,
        );
      }
      return requested;
    } catch (error) {
      if (!isSqliteBusy(error)) {
        throw error;
      }
      lastBusyError = error;
      if (attempt < JOURNAL_MODE_RETRY_COUNT) {
        Atomics.wait(
          journalModeRetrySignal,
          0,
          0,
          JOURNAL_MODE_RETRY_DELAY_MILLISECONDS,
        );
      }
    }
  }
  throw new DurableStoreError(
    "STORE_BUSY",
    "timed out establishing SQLite journal mode",
    { cause: lastBusyError },
  );
}

export class SqliteEventStore {
  readonly #core: DecisionLedgerCore;

  private constructor(core: DecisionLedgerCore) {
    this.#core = core;
    Object.freeze(this);
  }

  public static open(path: string): SqliteEventStore {
    const databasePath = canonicalDatabasePath(path);
    return SqliteEventStore.#open(databasePath, databasePath, "WAL_FILE", null);
  }

  public static openForProject(path: string, projectId: string): SqliteEventStore {
    const databasePath = canonicalDatabasePath(path);
    const safeProjectId = requireIdentifier(projectId, "projectId");
    return SqliteEventStore.#open(
      databasePath,
      databasePath,
      "WAL_FILE",
      safeProjectId,
    );
  }

  /** Test-only escape hatch. Production code must use {@link open}. */
  public static openEphemeralForTest(): SqliteEventStore {
    return SqliteEventStore.#open(
      ":memory:",
      null,
      "EPHEMERAL_TEST",
      "moe-test-project",
    );
  }

  /** Test-only project-bound escape hatch. Production code must use {@link openForProject}. */
  public static openEphemeralForProjectTest(projectId: string): SqliteEventStore {
    return SqliteEventStore.#open(
      ":memory:",
      null,
      "EPHEMERAL_TEST",
      requireIdentifier(projectId, "projectId"),
    );
  }

  static #open(
    sqlitePath: string,
    databasePath: string | null,
    durability: StoreHealth["durability"],
    requestedProjectId: string | null,
  ): SqliteEventStore {
    const freshDatabaseCandidate = isFreshDatabaseFileCandidate(databasePath);
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(sqlitePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
    } catch (error) {
      throw new DurableStoreError("STORE_UNAVAILABLE", "unable to open SQLite database", {
        cause: error,
      });
    }
    try {
      if (databasePath !== null) {
        const mainDatabase = database
          .prepare("PRAGMA database_list")
          .all()
          .find((row) => row.name === "main");
        const reportedPath =
          mainDatabase === undefined ? "" : requireRowString(mainDatabase, "file");
        if (reportedPath.length === 0 || realpathSync.native(reportedPath) !== databasePath) {
          throw new DurableStoreError(
            "STORE_UNAVAILABLE",
            "SQLite opened a different database path than requested",
          );
        }
      }
      const sqliteVersion = String(
        readScalar(database, "SELECT sqlite_version() AS value", "value"),
      );
      if (compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
        throw new Error(
          `SQLITE_VERSION_UNSUPPORTED: ${sqliteVersion} < ${MINIMUM_SQLITE_VERSION}`,
        );
      }
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA recursive_triggers = OFF;
        PRAGMA wal_autocheckpoint = 1000;
      `);
      const projectId = bootstrapAndValidateSchema(
        database,
        freshDatabaseCandidate,
        requestedProjectId,
      );
      const core = createDecisionLedgerCore(
        database,
        databasePath,
        durability,
        projectId,
        requestedProjectId !== null,
      );
      core.validateStartup();

      const expectedJournalMode = durability === "WAL_FILE" ? "wal" : "memory";
      establishJournalMode(database, expectedJournalMode);
      database.exec("PRAGMA synchronous = FULL;");
      if (
        Number(readScalar(database, "PRAGMA foreign_keys", "foreign_keys")) !== 1 ||
        Number(readScalar(database, "PRAGMA synchronous", "synchronous")) !== 2 ||
        Number(readScalar(database, "PRAGMA trusted_schema", "trusted_schema")) !== 0 ||
        Number(readScalar(database, "PRAGMA recursive_triggers", "recursive_triggers")) !== 0 ||
        Number(readScalar(database, "PRAGMA wal_autocheckpoint", "wal_autocheckpoint")) !== 1_000 ||
        Number(readScalar(database, "PRAGMA busy_timeout", "timeout")) !== 5_000
      ) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          "SQLite connection safety settings could not be established",
        );
      }
      database.enableDefensive(true);
      return new SqliteEventStore(core);
    } catch (error) {
      let closeError: unknown;
      try {
        database.close();
      } catch (caughtCloseError) {
        closeError = caughtCloseError;
      }
      if (error instanceof DurableStoreError) {
        if (closeError !== undefined) {
          const cleanupCause =
            error.cause === undefined
              ? closeError
              : new AggregateError([error.cause, closeError]);
          Object.defineProperty(error, "cause", {
            configurable: true,
            value: cleanupCause,
            writable: true,
          });
        }
        throw error;
      }
      throw new DurableStoreError("STORE_UNAVAILABLE", "SQLite initialization failed", {
        cause:
          closeError === undefined
            ? error
            : new AggregateError([error, closeError]),
      });
    }
  }

  public close(): void {
    this.#core.close();
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public commit(input: CommitInput): CommitResult {
    return this.#core.commit(input);
  }

  public commitExpectedVersionDecision(
    input: CommitExpectedVersionDecisionInput,
  ): CommandDecisionResponse {
    return this.#core.commitExpectedVersionDecision(input);
  }

  public getAggregateVersion(aggregateId: string): number {
    return this.#core.getAggregateVersion(aggregateId);
  }

  public getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null {
    return this.#core.getCommandDecision(key);
  }

  public getCommandReceipt(commandId: string): CommandReceipt | null {
    return this.#core.getCommandReceipt(commandId);
  }

  public getHealth(): StoreHealth {
    return this.#core.getHealth();
  }

  public readAggregateEvents(
    aggregateId: string,
    afterAggregateSequence = 0,
    limit = 100,
    maxDecodedBytes?: number,
  ): CursorPage<StoredEvent, number> {
    return this.#core.readAggregateEvents(
      aggregateId,
      afterAggregateSequence,
      limit,
      maxDecodedBytes,
    );
  }

  public readCommandDecisionsAfter(
    afterDecisionPosition: bigint,
    limit = 100,
    maxDecodedBytes?: number,
  ): CursorPage<CommandDecisionRecord, bigint> {
    return this.#core.readCommandDecisionsAfter(
      afterDecisionPosition,
      limit,
      maxDecodedBytes,
    );
  }

  public readEvents(aggregateId: string): readonly StoredEvent[] {
    return this.#core.readEvents(aggregateId);
  }

  public readEventsAfter(
    afterGlobalPosition: bigint,
    limit = 100,
    maxDecodedBytes?: number,
  ): CursorPage<StoredEvent, bigint> {
    return this.#core.readEventsAfter(afterGlobalPosition, limit, maxDecodedBytes);
  }

  public readPendingOutbox(limit = 100): readonly PendingOutboxMessage[] {
    return this.#core.readPendingOutbox(limit);
  }

  public readPendingOutboxPage(
    afterOutboxPosition: bigint,
    limit = 100,
    maxDecodedBytes?: number,
  ): CursorPage<PendingOutboxMessage, bigint> {
    return this.#core.readPendingOutboxPage(
      afterOutboxPosition,
      limit,
      maxDecodedBytes,
    );
  }
}

Object.freeze(SqliteEventStore.prototype);
Object.freeze(SqliteEventStore);
