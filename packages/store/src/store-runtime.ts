import type { DatabaseSync } from "node:sqlite";

import { DurableStoreError } from "./store-contracts.js";
import type { StoreHealth } from "./store-contracts.js";
import {
  readScalar,
  requireRowString,
  requireStoredIdentifier,
  requireStoredIntegerAtLeast,
  synchronousMode,
} from "./store-rows.js";
import { isSqliteBusy } from "./sqlite-schema.js";

export class StoreRuntime {
  protected readonly database: DatabaseSync;
  protected readonly databasePath: string | null;
  protected readonly durability: StoreHealth["durability"];
  protected readonly projectId: string | null;
  protected readonly writeProjectAsserted: boolean;
  protected state: "CLOSED" | "OPEN" | "POISONED" = "OPEN";

  protected constructor(
    database: DatabaseSync,
    databasePath: string | null,
    durability: StoreHealth["durability"],
    projectId: string | null,
    writeProjectAsserted: boolean,
  ) {
    this.database = database;
    this.databasePath = databasePath;
    this.durability = durability;
    this.projectId = projectId;
    this.writeProjectAsserted = writeProjectAsserted;
  }

  public close(): void {
    if (this.state === "CLOSED") {
      return;
    }
    if (this.state === "OPEN") {
      this.database.close();
    }
    this.state = "CLOSED";
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public getHealth(): StoreHealth {
    return this.readOperation("read store health", () => {
      const liveProjectId = this.readLiveProjectBinding();
      if (this.projectId !== null && liveProjectId !== this.projectId) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "the live database project binding diverges from the asserted store handle",
        );
      }
      return Object.freeze({
        accessMode: this.writeProjectAsserted
          ? "PROJECT_ASSERTED_WRITE"
          : "READ_ONLY_INSPECTION",
        applicationId: Number(
          readScalar(this.database, "PRAGMA application_id", "application_id"),
        ),
        busyTimeoutMilliseconds: Number(
          readScalar(this.database, "PRAGMA busy_timeout", "timeout"),
        ),
        databasePath: this.databasePath,
        durability: this.durability,
        foreignKeys:
          Number(readScalar(this.database, "PRAGMA foreign_keys", "foreign_keys")) === 1,
        foreignKeyViolations: this.database.prepare("PRAGMA foreign_key_check").all().length,
        journalMode: String(
          readScalar(this.database, "PRAGMA journal_mode", "journal_mode"),
        ),
        projectId: liveProjectId,
        quickCheck: String(
          readScalar(this.database, "PRAGMA quick_check", "quick_check"),
        ),
        recursiveTriggers:
          Number(
            readScalar(this.database, "PRAGMA recursive_triggers", "recursive_triggers"),
          ) === 1,
        sqliteVersion: String(
          readScalar(this.database, "SELECT sqlite_version() AS value", "value"),
        ),
        synchronous: synchronousMode(
          Number(readScalar(this.database, "PRAGMA synchronous", "synchronous")),
        ),
        trustedSchema:
          Number(readScalar(this.database, "PRAGMA trusted_schema", "trusted_schema")) === 1,
        userVersion: Number(
          readScalar(this.database, "PRAGMA user_version", "user_version"),
        ),
        walAutocheckpointPages: Number(
          readScalar(this.database, "PRAGMA wal_autocheckpoint", "wal_autocheckpoint"),
        ),
        writeProjectAsserted: this.writeProjectAsserted,
      });
    });
  }

  protected requireStoredVersion<const Version extends string>(
    row: Record<string, unknown>,
    column: string,
    expected: Version,
  ): Version {
    const actual = requireRowString(row, column);
    if (actual !== expected) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `${column} version ${JSON.stringify(actual)} is unsupported`,
      );
    }
    return expected;
  }

  protected assertAggregateTail(aggregateId: string): number {
    const headRow = this.database
      .prepare("SELECT version FROM aggregate_heads WHERE aggregate_id = ?")
      .get(aggregateId);
    const tailRow = this.database
      .prepare(`
        SELECT aggregate_sequence
        FROM domain_events
        WHERE aggregate_id = ?
        ORDER BY aggregate_sequence DESC
        LIMIT 1
      `)
      .get(aggregateId);
    if (headRow === undefined) {
      if (tailRow === undefined) {
        return 0;
      }
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} has events without a head`,
      );
    }
    const headVersion = requireStoredIntegerAtLeast(headRow, "version", 0);
    if (tailRow === undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} has a head without events`,
      );
    }
    const tailSequence = requireStoredIntegerAtLeast(tailRow, "aggregate_sequence", 1);
    if (headVersion !== tailSequence) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} head does not match its event tail`,
      );
    }
    return headVersion;
  }

  protected assertDurableProjectBinding(): void {
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "the operation requires an explicitly project-asserted store handle",
      );
    }
    this.assertLiveProjectBinding();
  }

  protected assertLiveProjectBinding(): void {
    if (this.projectId === null) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "the operation requires a project-bound store handle",
      );
    }
    if (this.readLiveProjectBinding() !== this.projectId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "the live database project binding diverges from the asserted store handle",
      );
    }
  }

  protected assertCachedProjectBinding(): void {
    if (this.projectId !== null) {
      this.assertLiveProjectBinding();
    }
  }

  protected assertReceiptReadBinding(): void {
    const liveProjectId = this.readLiveProjectBinding();
    if (this.projectId === null) {
      if (liveProjectId !== null) {
        throw new DurableStoreError(
          "PROJECT_SCOPE_REQUIRED",
          "the inspection handle predates the database project binding; reopen it before reading scoped receipts",
        );
      }
      return;
    }
    if (liveProjectId !== this.projectId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "the live database project binding diverges from the asserted store handle",
      );
    }
  }

  protected readLiveProjectBinding(): string | null {
    const rows = this.database
      .prepare("SELECT singleton, project_id FROM store_project_binding ORDER BY singleton")
      .all();
    if (rows.length === 0) {
      return null;
    }
    if (rows.length !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "the live database has an invalid project binding cardinality",
      );
    }
    if (requireStoredIntegerAtLeast(rows[0]!, "singleton", 1) !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "the live database project binding singleton is invalid",
      );
    }
    return requireStoredIdentifier(rows[0]!, "project_id");
  }

  protected requireOpen(): void {
    if (this.state === "POISONED") {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "the SQLite event store is quarantined after an uncertain transaction outcome",
      );
    }
    if (this.state === "CLOSED") {
      throw new DurableStoreError("STORE_CLOSED", "the SQLite event store is closed");
    }
  }

  protected readOperation<Result>(operation: string, read: () => Result): Result {
    this.requireOpen();
    try {
      return read();
    } catch (error) {
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, operation);
    }
  }

  protected normalizeOperationalError(error: unknown, operation: string): DurableStoreError {
    if (isSqliteBusy(error)) {
      return new DurableStoreError("STORE_BUSY", `${operation} timed out waiting for SQLite`, {
        cause: error,
      });
    }
    return new DurableStoreError("STORE_UNAVAILABLE", `${operation} failed`, {
      cause: error,
    });
  }

  protected poison(): void {
    try {
      this.database.close();
    } catch {
      // The state remains poisoned even when SQLite cannot confirm close.
    }
    this.state = "POISONED";
  }
}
