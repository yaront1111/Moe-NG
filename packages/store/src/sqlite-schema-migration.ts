import type { DatabaseSync } from "node:sqlite";

import {
  DurableStoreError,
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_MANIFEST_VERSION,
} from "./store-contracts.js";
import {
  LEGACY_SCHEMA_MANIFEST_VERSION,
  SCHEMA_VERSION,
} from "./store-internals.js";
import {
  validateExactSchemaObjects,
  validateSchemaManifestMetadata,
} from "./sqlite-schema-conformance.js";
import {
  SCHEMA_OBJECT_SQL,
  SCHEMA_V1_OBJECT_SQL,
} from "./sqlite-schema-manifest.js";
import { readScalar } from "./store-rows.js";

export function migrateLocked(database: DatabaseSync, freshDatabase: boolean): void {
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
