import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_MANIFEST_VERSION,
} from "./store-contracts.js";
import { invalidInput } from "./store-input.js";
import {
  LEGACY_SCHEMA_MANIFEST_VERSION,
  SCHEMA_VERSION,
  stringIsWellFormed,
} from "./store-internals.js";
import {
  SCHEMA_OBJECT_SQL,
  SCHEMA_V1_OBJECT_SQL,
} from "./sqlite-schema-manifest.js";
import {
  readScalar,
  requireRowInteger,
  requireRowString,
  requireStoredIdentifier,
} from "./store-rows.js";

/** Package-internal query exported only so its production access plan can be regression-tested. */
export function canonicalDatabasePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.startsWith("file:") ||
    !isAbsolute(value)
  ) {
    return invalidInput("database path must be a well-formed absolute filesystem path");
  }
  try {
    if (existsSync(value)) {
      return realpathSync.native(value);
    }
    return join(realpathSync.native(dirname(value)), basename(value));
  } catch (error) {
    throw new DurableStoreError(
      "STORE_INPUT_INVALID",
      "database path parent must exist and be canonically resolvable",
      { cause: error },
    );
  }
}

export function isFreshDatabaseFileCandidate(databasePath: string | null): boolean {
  if (databasePath === null) {
    return true;
  }
  try {
    return !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      "unable to inspect the SQLite database file",
      { cause: error },
    );
  }
}

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

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;\s*$/u, "");
}

function validateExactSchemaObjects(
  database: DatabaseSync,
  manifest: Readonly<Record<string, string>>,
  version: number,
): void {
  const expectedObjects = new Map<string, { readonly sql: string; readonly type: string }>();
  for (const [name, sql] of Object.entries(manifest)) {
    const normalized = normalizeSchemaSql(sql);
    expectedObjects.set(name, {
      sql: normalized,
      type: normalized.startsWith("CREATE INDEX") ? "index" : "table",
    });
  }
  const actualRows = database
    .prepare(`
      SELECT name, type, sql
      FROM sqlite_schema
      WHERE substr(name, 1, 7) <> 'sqlite_'
      ORDER BY name
    `)
    .all();
  if (actualRows.length !== expectedObjects.size) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `expected ${expectedObjects.size} application schema objects, found ${actualRows.length}`,
    );
  }
  for (const row of actualRows) {
    const name = requireRowString(row, "name");
    const expected = expectedObjects.get(name);
    const actualType = requireRowString(row, "type");
    const actualSql = requireRowString(row, "sql");
    if (
      expected === undefined ||
      actualType !== expected.type ||
      normalizeSchemaSql(actualSql) !== expected.sql
    ) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        `schema object ${JSON.stringify(name)} does not match the version ${version} manifest`,
      );
    }
  }
}

function validateSchemaManifestMetadata(
  database: DatabaseSync,
  expectedVersion: string,
): void {
  const metadataRows = database
    .prepare("SELECT key, value FROM store_metadata ORDER BY key")
    .all();
  if (
    metadataRows.length !== 1 ||
    requireRowString(metadataRows[0]!, "key") !== "schema_manifest_version" ||
    requireRowString(metadataRows[0]!, "value") !== expectedVersion
  ) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      "schema manifest metadata is missing or unsupported",
    );
  }
}

function validateSchema(database: DatabaseSync): void {
  try {
    validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, SCHEMA_VERSION);
    validateSchemaManifestMetadata(database, SQLITE_SCHEMA_MANIFEST_VERSION);
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        "foreign-key verification found durable relationship violations",
      );
    }
    if (String(readScalar(database, "PRAGMA quick_check", "quick_check")) !== "ok") {
      throw new DurableStoreError("STORE_SCHEMA_INVALID", "SQLite quick_check did not pass");
    }

    const semanticRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM command_receipts AS receipts
        WHERE
          receipts.request_identity_version <> ?
          OR receipts.result_version <> ?
          OR receipts.effect_identity_version <> ?
          OR receipts.current_version - receipts.previous_version <> receipts.event_count
          OR NOT EXISTS (
            SELECT 1
            FROM aggregate_heads AS heads
            WHERE heads.aggregate_id = receipts.aggregate_id
              AND heads.version >= receipts.current_version
          )
          OR (
            SELECT count(*)
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
          ) <> receipts.event_count
          OR EXISTS (
            SELECT 1
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
              AND (
                events.aggregate_id <> receipts.aggregate_id
                OR events.aggregate_sequence <>
                  receipts.previous_version + events.command_event_index + 1
                OR events.command_event_index >= receipts.event_count
                OR events.record_version <> ?
                OR events.payload_codec_version <> ?
                OR events.request_sha256 <> receipts.request_sha256
                OR events.committed_at <> receipts.committed_at
              )
          )
          OR (
            SELECT count(*)
            FROM outbox_messages AS messages
            INNER JOIN domain_events AS events ON events.event_id = messages.event_id
            WHERE events.command_id = receipts.command_id
          ) <> receipts.outbox_count
      `)
      .get(
        COMMAND_REQUEST_IDENTITY_VERSION,
        RECEIPT_RESULT_VERSION,
        COMMAND_EFFECT_IDENTITY_VERSION,
        EVENT_RECORD_VERSION,
        OPAQUE_PAYLOAD_CODEC_VERSION,
      );
    if (requireRowInteger(semanticRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "durable command receipts do not match the authoritative event ledger",
      );
    }
    const aggregateRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT heads.aggregate_id
          FROM aggregate_heads AS heads
          LEFT JOIN (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger ON ledger.aggregate_id = heads.aggregate_id
          WHERE
            ledger.maximum_sequence IS NULL
            OR heads.version <> ledger.maximum_sequence
            OR ledger.event_count <> ledger.maximum_sequence

          UNION ALL

          SELECT ledger.aggregate_id
          FROM (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger
          LEFT JOIN aggregate_heads AS heads ON heads.aggregate_id = ledger.aggregate_id
          WHERE heads.aggregate_id IS NULL
        )
      `)
      .get();
    if (requireRowInteger(aggregateRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "aggregate heads do not exactly match the event ledger",
      );
    }

    const unexpectedSequenceRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM sqlite_sequence
        WHERE
          name IS NULL
          OR name NOT IN ('domain_events', 'outbox_messages', 'command_decisions')
      `)
      .get();
    if (requireRowInteger(unexpectedSequenceRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "SQLite sequence metadata names an unknown append-only ledger",
      );
    }

    const sequenceRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT
            'domain_events' AS table_name,
            (SELECT min(global_position) FROM domain_events) AS minimum_position,
            (SELECT max(global_position) FROM domain_events) AS maximum_position,
            (SELECT count(*) FROM domain_events) AS ledger_row_count,
            (SELECT seq FROM sqlite_sequence WHERE name = 'domain_events') AS sequence_value,
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'domain_events')) AS sequence_type,
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'domain_events') AS sequence_row_count

          UNION ALL

          SELECT
            'outbox_messages',
            (SELECT min(outbox_position) FROM outbox_messages),
            (SELECT max(outbox_position) FROM outbox_messages),
            (SELECT count(*) FROM outbox_messages),
            (SELECT seq FROM sqlite_sequence WHERE name = 'outbox_messages'),
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'outbox_messages')),
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'outbox_messages')

          UNION ALL

          SELECT
            'command_decisions',
            (SELECT min(decision_position) FROM command_decisions),
            (SELECT max(decision_position) FROM command_decisions),
            (SELECT count(*) FROM command_decisions),
            (SELECT seq FROM sqlite_sequence WHERE name = 'command_decisions'),
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'command_decisions')),
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'command_decisions')
        ) AS sequence_evidence
        WHERE
          (
            maximum_position IS NULL
            AND sequence_row_count <> 0
          )
          OR (
            maximum_position IS NOT NULL
            AND (
              minimum_position <> 1
              OR ledger_row_count <> maximum_position
              OR sequence_row_count <> 1
              OR sequence_type <> 'integer'
              OR sequence_value <> maximum_position
            )
          )
      `)
      .get();
    if (requireRowInteger(sequenceRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "append-only ledger positions conflict with SQLite sequence evidence",
      );
    }
  } catch (error) {
    if (error instanceof DurableStoreError) {
      throw error;
    }
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      "unable to verify the application schema",
      { cause: error },
    );
  }
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

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`SQLITE_VERSION_INVALID: ${value}`);
    }
    return value.split(".").map((part) => Number.parseInt(part, 10));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function migrateLocked(database: DatabaseSync, freshDatabase: boolean): void {
  const currentVersion = Number(readScalar(database, "PRAGMA user_version", "user_version"));
  if (currentVersion > SCHEMA_VERSION) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) {
    return;
  }

  if (freshDatabase) {
    database.exec(`${Object.values(SCHEMA_OBJECT_SQL).join(";\n")};`);
    database
      .prepare("INSERT INTO store_metadata (key, value) VALUES (?, ?)")
      .run("schema_manifest_version", SQLITE_SCHEMA_MANIFEST_VERSION);
    database.exec(`
      PRAGMA application_id = ${SQLITE_APPLICATION_ID};
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    return;
  }

  if (currentVersion !== 1) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `schema version ${currentVersion} is not a recognized migration source`,
    );
  }

  validateExactSchemaObjects(database, SCHEMA_V1_OBJECT_SQL, 1);
  validateSchemaManifestMetadata(database, LEGACY_SCHEMA_MANIFEST_VERSION);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      "foreign-key verification found v1 relationship violations",
    );
  }
  if (String(readScalar(database, "PRAGMA quick_check", "quick_check")) !== "ok") {
    throw new DurableStoreError("STORE_SCHEMA_INVALID", "SQLite v1 quick_check did not pass");
  }
  const populated = Number(
    readScalar(
      database,
      `
        SELECT
          (SELECT count(*) FROM aggregate_heads)
          + (SELECT count(*) FROM command_receipts)
          + (SELECT count(*) FROM domain_events)
          + (SELECT count(*) FROM outbox_messages) AS value
      `,
      "value",
    ),
  );
  const advancedSequence = Number(
    readScalar(
      database,
      "SELECT count(*) AS value FROM sqlite_sequence WHERE seq > 0",
      "value",
    ),
  );
  if (populated !== 0 || advancedSequence !== 0) {
    throw new DurableStoreError(
      "STORE_MIGRATION_REQUIRED",
      "populated schema v1 stores require explicit scope/result reconciliation before migration",
    );
  }

  database.exec(`
    ${SCHEMA_OBJECT_SQL.command_decisions};
    ${SCHEMA_OBJECT_SQL.store_project_binding};
    ${SCHEMA_OBJECT_SQL.command_receipt_scopes};
  `);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SQLITE_SCHEMA_MANIFEST_VERSION, "schema_manifest_version");
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
