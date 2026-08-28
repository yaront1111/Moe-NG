import type { DatabaseSync } from "node:sqlite";

import {
  DurableStoreError,
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_MANIFEST_VERSION,
} from "./store-contracts.js";
import {
  LEGACY_SCHEMA_MANIFEST_VERSION,
  SCHEMA_V2_MANIFEST_VERSION,
  SCHEMA_V3_MANIFEST_VERSION,
  SCHEMA_V4_MANIFEST_VERSION,
  SCHEMA_V5_MANIFEST_VERSION,
  SCHEMA_V6_MANIFEST_VERSION,
  SCHEMA_VERSION,
} from "./store-internals.js";
import {
  validateExactSchemaObjects,
  validateSchemaManifestMetadata,
} from "./sqlite-schema-conformance.js";
import {
  SCHEMA_OBJECT_SQL,
  SCHEMA_V1_OBJECT_SQL,
  SCHEMA_V2_OBJECT_SQL,
  SCHEMA_V3_OBJECT_SQL,
  SCHEMA_V4_OBJECT_SQL,
  SCHEMA_V5_OBJECT_SQL,
  SCHEMA_V6_OBJECT_SQL,
} from "./sqlite-schema-manifest.js";
import { backfillDecisionLegRosters } from "./sqlite-schema-v7-backfill.js";
import { readScalar } from "./store-rows.js";

function validateMigrationSource(
  database: DatabaseSync,
  manifest: Readonly<Record<string, string>>,
  manifestVersion: string,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6,
): void {
  validateExactSchemaObjects(database, manifest, schemaVersion);
  validateSchemaManifestMetadata(database, manifestVersion);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `foreign-key verification found v${schemaVersion} relationship violations`,
    );
  }
  if (String(readScalar(database, "PRAGMA quick_check", "quick_check")) !== "ok") {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `SQLite v${schemaVersion} quick_check did not pass`,
    );
  }
}

function hasDurableRows(database: DatabaseSync, rowCountSql: string): boolean {
  const populated = Number(readScalar(database, rowCountSql, "value"));
  const advancedSequence = Number(
    readScalar(
      database,
      "SELECT count(*) AS value FROM sqlite_sequence WHERE seq > 0",
      "value",
    ),
  );
  return populated !== 0 || advancedSequence !== 0;
}

function migrateV1ToV2(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V1_OBJECT_SQL, LEGACY_SCHEMA_MANIFEST_VERSION, 1);
  if (
    hasDurableRows(
      database,
      `
        SELECT
          (SELECT count(*) FROM aggregate_heads)
          + (SELECT count(*) FROM command_receipts)
          + (SELECT count(*) FROM domain_events)
          + (SELECT count(*) FROM outbox_messages) AS value
      `,
    )
  ) {
    throw new DurableStoreError(
      "STORE_MIGRATION_REQUIRED",
      "populated schema v1 stores require explicit scope/result reconciliation before migration",
    );
  }

  database.exec(`
    ${SCHEMA_V2_OBJECT_SQL.command_decisions};
    ${SCHEMA_V2_OBJECT_SQL.store_project_binding};
    ${SCHEMA_V2_OBJECT_SQL.command_receipt_scopes};
  `);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SCHEMA_V2_MANIFEST_VERSION, "schema_manifest_version");
  database.exec("PRAGMA user_version = 2;");
}

function migrateV2ToV3(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V2_OBJECT_SQL, SCHEMA_V2_MANIFEST_VERSION, 2);
  if (
    hasDurableRows(
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
    )
  ) {
    throw new DurableStoreError(
      "STORE_MIGRATION_REQUIRED",
      "populated schema v2 stores require explicit projection reconciliation before migration",
    );
  }

  database.exec(`
    DROP TABLE domain_events;
    ${SCHEMA_V3_OBJECT_SQL.domain_events};
    ${SCHEMA_V3_OBJECT_SQL.projections};
    ${SCHEMA_V3_OBJECT_SQL.inbox_receipts};
    ${SCHEMA_V3_OBJECT_SQL.event_subscriptions};
    ${SCHEMA_V3_OBJECT_SQL.cursor_generations};
  `);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SCHEMA_V3_MANIFEST_VERSION, "schema_manifest_version");
  database.exec("PRAGMA user_version = 3;");
}

/**
 * Purely additive: creates one new table and touches nothing that already
 * exists, so an upgrade in place is provable rather than hoped for. The earlier
 * legs refuse durable history because they rebuild domain_events and cannot
 * reconcile the rows they would rewrite. This is no longer the only
 * populated-safe leg — v4->v5 below is additive on the same terms — so it must
 * stamp the FROZEN v4 identity and stop at 4, letting the next leg advance.
 */
function migrateV3ToV4(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V3_OBJECT_SQL, SCHEMA_V3_MANIFEST_VERSION, 3);
  database.exec(`${SCHEMA_V4_OBJECT_SQL.recovery_bindings};`);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SCHEMA_V4_MANIFEST_VERSION, "schema_manifest_version");
  database.exec("PRAGMA user_version = 4;");
}

/**
 * Additive index creation. A populated v4 store keeps every durable row,
 * position, sequence and opaque byte: creating an index rewrites no table, so
 * this leg never needs to decode a payload or reconcile history.
 */
function migrateV4ToV5(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V4_OBJECT_SQL, SCHEMA_V4_MANIFEST_VERSION, 4);
  database.exec(`${SCHEMA_V5_OBJECT_SQL.domain_events_event_type_position};`);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SCHEMA_V5_MANIFEST_VERSION, "schema_manifest_version");
  database.exec("PRAGMA user_version = 5;");
}

/** Additive durable page offers. Existing subscribers start with no issued page. */
function migrateV5ToV6(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V5_OBJECT_SQL, SCHEMA_V5_MANIFEST_VERSION, 5);
  database.exec(`${SCHEMA_V6_OBJECT_SQL.subscription_pending_offers};`);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SCHEMA_V6_MANIFEST_VERSION, "schema_manifest_version");
  database.exec("PRAGMA user_version = 6;");
}

function migrateV6ToV7(database: DatabaseSync): void {
  validateMigrationSource(database, SCHEMA_V6_OBJECT_SQL, SCHEMA_V6_MANIFEST_VERSION, 6);
  database.exec(`
    ${SCHEMA_OBJECT_SQL.command_decision_leg_rosters};
    ${SCHEMA_OBJECT_SQL.command_decision_legs};
  `);
  // Every surviving decision gets the roster its own rows imply. A decision whose
  // evidence is incomplete throws STORE_MIGRATION_REQUIRED from here, and the
  // BEGIN IMMEDIATE this runs inside rolls the store back to an intact v6.
  backfillDecisionLegRosters(database);
  database
    .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
    .run(SQLITE_SCHEMA_MANIFEST_VERSION, "schema_manifest_version");
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

function installFreshSchema(database: DatabaseSync): void {
  database.exec(`${Object.values(SCHEMA_OBJECT_SQL).join(";\n")};`);
  database
    .prepare("INSERT INTO store_metadata (key, value) VALUES (?, ?)")
    .run("schema_manifest_version", SQLITE_SCHEMA_MANIFEST_VERSION);
  database.exec(`
    PRAGMA application_id = ${SQLITE_APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function migrateLocked(database: DatabaseSync, freshDatabase: boolean): void {
  const currentVersion = Number(readScalar(database, "PRAGMA user_version", "user_version"));
  if (currentVersion > SCHEMA_VERSION) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) return;
  if (freshDatabase) {
    installFreshSchema(database);
    return;
  }
  if (
    currentVersion !== 1 && currentVersion !== 2
    && currentVersion !== 3 && currentVersion !== 4 && currentVersion !== 5
    && currentVersion !== 6
  ) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `schema version ${currentVersion} is not a recognized migration source`,
    );
  }
  if (currentVersion === 1) migrateV1ToV2(database);
  if (currentVersion <= 2) migrateV2ToV3(database);
  if (currentVersion <= 3) migrateV3ToV4(database);
  if (currentVersion <= 4) migrateV4ToV5(database);
  if (currentVersion <= 5) migrateV5ToV6(database);
  migrateV6ToV7(database);
}
