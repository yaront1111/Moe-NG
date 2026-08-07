import type { DatabaseSync } from "node:sqlite";

import {
  DurableStoreError,
  SQLITE_APPLICATION_ID,
} from "./store-contracts.js";
import { validateSchema } from "./sqlite-schema-integrity.js";
import { migrateLocked } from "./sqlite-schema-migration.js";
import {
  readScalar,
  requireRowInteger,
  requireStoredIdentifier,
} from "./store-rows.js";

function isFreshDatabase(
  database: DatabaseSync,
  allowTransactionHeaderPage = false,
): boolean {
  const applicationId = Number(
    readScalar(database, "PRAGMA application_id", "application_id"),
  );
  const userVersion = Number(readScalar(database, "PRAGMA user_version", "user_version"));
  if (applicationId === SQLITE_APPLICATION_ID) {
    if (userVersion === 0) {
      throw new DurableStoreError(
        "DATABASE_IDENTITY_MISMATCH",
        "recognized Moe application ID has no committed schema version",
      );
    }
    return false;
  }
  if (applicationId !== 0 || userVersion !== 0) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `expected Moe application ID ${SQLITE_APPLICATION_ID}, found ${applicationId} with schema version ${userVersion}`,
    );
  }

  const schemaObjectCount = Number(
    readScalar(
      database,
      "SELECT count(*) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      "value",
    ),
  );
  const pageCount = Number(readScalar(database, "PRAGMA page_count", "page_count"));
  const maximumFreshPageCount = allowTransactionHeaderPage ? 1 : 0;
  if (schemaObjectCount !== 0 || pageCount > maximumFreshPageCount) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `refusing to adopt an unidentified non-empty database (${schemaObjectCount} schema objects, ${pageCount} pages)`,
    );
  }
  return true;
}

function resolveProjectBinding(
  database: DatabaseSync,
  requestedProjectId: string | null,
): string | null {
  const rows = database
    .prepare("SELECT singleton, project_id FROM store_project_binding ORDER BY singleton")
    .all();
  if (rows.length > 1) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "the store has more than one project binding",
    );
  }
  if (rows.length === 1) {
    if (requireRowInteger(rows[0]!, "singleton") !== 1) {
      throw new DurableStoreError("STORE_CORRUPT", "the project binding singleton is invalid");
    }
    const boundProjectId = requireStoredIdentifier(rows[0]!, "project_id");
    const inconsistentScopeRow = database
      .prepare(`
          SELECT count(*) AS value
          FROM (
            SELECT receipts.command_id AS receipt_command_id
            FROM command_receipts AS receipts
            LEFT JOIN command_receipt_scopes AS scopes
              ON scopes.receipt_command_id = receipts.command_id
            WHERE scopes.receipt_command_id IS NULL

            UNION ALL

            SELECT receipt_command_id
            FROM command_receipt_scopes
            WHERE project_id <> ?

            UNION ALL

            SELECT receipt_command_id
            FROM command_decisions
            WHERE project_id <> ?
          )
        `)
      .get(boundProjectId, boundProjectId);
    const inconsistentScopeCount = requireRowInteger(
      inconsistentScopeRow ?? {},
      "value",
    );
    if (inconsistentScopeCount !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "the project binding conflicts with durable command scope evidence",
      );
    }
    if (requestedProjectId !== null && requestedProjectId !== boundProjectId) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_MISMATCH",
        `the database is bound to project ${JSON.stringify(boundProjectId)}`,
      );
    }
    return boundProjectId;
  }

  const durableRowCount = Number(
    readScalar(
      database,
      `
        SELECT
          (SELECT count(*) FROM aggregate_heads)
          + (SELECT count(*) FROM command_receipts)
          + (SELECT count(*) FROM domain_events)
          + (SELECT count(*) FROM outbox_messages)
          + (SELECT count(*) FROM command_decisions)
          + (SELECT count(*) FROM command_receipt_scopes) AS value
      `,
      "value",
    ),
  );
  const advancedSequence = Number(
    readScalar(
      database,
      `
        SELECT count(*) AS value
        FROM sqlite_sequence
        WHERE name IN ('domain_events', 'outbox_messages', 'command_decisions')
          AND seq > 0
      `,
      "value",
    ),
  );
  if (durableRowCount !== 0 || advancedSequence !== 0) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "durable ledger history exists without its required project binding",
    );
  }
  if (requestedProjectId === null) {
    return null;
  }
  const inserted = database
    .prepare("INSERT INTO store_project_binding (singleton, project_id) VALUES (1, ?)")
    .run(requestedProjectId);
  if (inserted.changes !== 1) {
    throw new DurableStoreError("STORE_UNAVAILABLE", "SQLite did not persist the project binding");
  }
  return requestedProjectId;
}

export function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return (
    record.errcode === 5 ||
    record.errstr === "database is locked" ||
    (typeof record.message === "string" && record.message.includes("database is locked"))
  );
}

export function bootstrapAndValidateSchema(
  database: DatabaseSync,
  freshDatabaseCandidate: boolean,
  requestedProjectId: string | null,
): string | null {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new DurableStoreError("STORE_BUSY", "database startup lock timed out", {
        cause: error,
      });
    }
    throw new DurableStoreError("STORE_UNAVAILABLE", "unable to acquire database startup lock", {
      cause: error,
    });
  }

  let commitAttempted = false;
  try {
    const freshDatabase = isFreshDatabase(database, freshDatabaseCandidate);
    migrateLocked(database, freshDatabase);
    validateSchema(database);
    const projectId = resolveProjectBinding(database, requestedProjectId);
    commitAttempted = true;
    database.exec("COMMIT");
    return projectId;
  } catch (error) {
    const transactionEndedAfterCommitAttempt = commitAttempted && !database.isTransaction;
    let rollbackError: unknown;
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    if (transactionEndedAfterCommitAttempt || rollbackError !== undefined) {
      const causes = rollbackError === undefined ? [error] : [error, rollbackError];
      throw new DurableStoreError(
        "OUTCOME_UNKNOWN",
        "database bootstrap outcome could not be proven; reopen and verify durable state",
        { cause: new AggregateError(causes) },
      );
    }
    if (isSqliteBusy(error)) {
      throw new DurableStoreError("STORE_BUSY", "database bootstrap timed out", {
        cause: error,
      });
    }
    throw error;
  }
}
