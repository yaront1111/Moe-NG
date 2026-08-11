import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DurableStoreError, SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "./index.js";
import {
  validateExactSchemaObjects,
  validateSchemaManifestMetadata,
} from "./sqlite-schema-conformance.js";
import { validateSchema } from "./sqlite-schema-integrity.js";
import { SCHEMA_OBJECT_SQL, SCHEMA_V3_OBJECT_SQL } from "./sqlite-schema-manifest.js";
import { SCHEMA_V3_MANIFEST_VERSION, SCHEMA_VERSION } from "./store-internals.js";

const encoder = new TextEncoder();
const PROJECT_ID = "schema-v4-project";

/** Hand-written: the v3 table set the migration must carry forward untouched. */
const V3_TABLES: readonly string[] = [
  "aggregate_heads", "command_decisions", "command_receipt_scopes", "command_receipts",
  "cursor_generations", "domain_events", "event_subscriptions", "inbox_receipts",
  "outbox_messages", "projections", "store_metadata", "store_project_binding",
];

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-schema-v4-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

function commitOneEvent(path: string): { readonly eventId: string; readonly payload: Uint8Array } {
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  try {
    store.commit({
      aggregateId: "aggregate-1",
      commandBytes: encoder.encode("command-bytes"),
      commandId: "command-1",
      committedAt: "2026-08-11T09:00:00.000Z",
      events: [
        {
          eventId: "event-1",
          eventType: "recovery.probe",
          payload: encoder.encode("durable-payload"),
        },
      ],
      expectedVersion: 0,
    });
    return { eventId: "event-1", payload: encoder.encode("durable-payload") };
  } finally {
    store.close();
  }
}

/**
 * Rewinds a freshly written v4 file to a genuine v3 file. The rows were written
 * by the production surface, so the migration under test faces real ledger
 * history rather than a hand-assembled approximation; the v3 conformance check
 * below is what proves the fixture is valid at the earlier layer.
 */
function rewindToV3(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("DROP TABLE recovery_bindings;");
    database
      .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
      .run(SCHEMA_V3_MANIFEST_VERSION, "schema_manifest_version");
    database.exec("PRAGMA user_version = 3;");
    validateExactSchemaObjects(database, SCHEMA_V3_OBJECT_SQL, 3);
    validateSchemaManifestMetadata(database, SCHEMA_V3_MANIFEST_VERSION);
    expect(
      database.prepare("SELECT count(*) AS value FROM domain_events").get(),
    ).toEqual({ value: 1 });
  } finally {
    database.close();
  }
}

function expectSchemaRefusal(run: () => unknown, detail: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, detail).toBeInstanceOf(DurableStoreError);
  expect((caught as DurableStoreError).code, detail).toBe("STORE_SCHEMA_INVALID");
}

describe("SQLite schema v4 recovery binding migration", () => {
  it("installs the exact v4 manifest and keeps every v3 object", () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/4");
    expect(SCHEMA_V3_MANIFEST_VERSION).toBe("moe-sqlite-schema/3");
    expect(Object.keys(SCHEMA_V3_OBJECT_SQL)).toHaveLength(14);
    expect(Object.keys(SCHEMA_OBJECT_SQL)).toHaveLength(15);
    for (const table of V3_TABLES) {
      expect(SCHEMA_V3_OBJECT_SQL, table).toHaveProperty(table);
      expect(SCHEMA_OBJECT_SQL, table).toHaveProperty(table);
    }
    expect(SCHEMA_OBJECT_SQL.recovery_bindings).toContain("STRICT");
    expect(SCHEMA_OBJECT_SQL.recovery_bindings).not.toContain("AUTOINCREMENT");

    const path = databasePath("fresh");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    store.close();
    const database = new DatabaseSync(path);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(
        database
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/4" });
      expect(database.prepare("SELECT count(*) AS value FROM recovery_bindings").get()).toEqual({
        value: 0,
      });
      validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, 4);
      validateSchema(database);
    } finally {
      database.close();
    }
  });

  it("still refuses an unknown table after the migration", () => {
    const path = databasePath("unknown-table");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE recovery_grants (grant_id TEXT PRIMARY KEY NOT NULL) STRICT");
      expectSchemaRefusal(() => validateSchema(database), "conformance still rejects extra tables");
      expectSchemaRefusal(
        () => validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, 4),
        "exact object validation still rejects extra tables",
      );
    } finally {
      database.close();
    }
    expectSchemaRefusal(
      () => SqliteEventStore.openForProject(path, PROJECT_ID).close(),
      "opening a store with an extra table",
    );
  });

  it("still refuses unknown store_metadata after the migration", () => {
    const path = databasePath("unknown-metadata");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    store.close();
    const database = new DatabaseSync(path);
    try {
      database
        .prepare("INSERT INTO store_metadata (key, value) VALUES (?, ?)")
        .run("recovery_authority", "GRANTED");
      expectSchemaRefusal(() => validateSchema(database), "conformance still rejects extra metadata");
      expectSchemaRefusal(
        () => validateSchemaManifestMetadata(database, SQLITE_SCHEMA_MANIFEST_VERSION),
        "metadata validation still rejects extra rows",
      );
    } finally {
      database.close();
    }
    expectSchemaRefusal(
      () => SqliteEventStore.openForProject(path, PROJECT_ID).close(),
      "opening a store with extra metadata",
    );
  });

  it("migrates a POPULATED v3 database and preserves its prior rows", () => {
    const path = databasePath("populated-v3");
    const written = commitOneEvent(path);
    const before = new DatabaseSync(path);
    let priorEventRow: unknown;
    let priorReceiptRow: unknown;
    try {
      priorEventRow = before.prepare("SELECT * FROM domain_events ORDER BY global_position").all();
      priorReceiptRow = before.prepare("SELECT * FROM command_receipts ORDER BY command_id").all();
    } finally {
      before.close();
    }
    rewindToV3(path);

    const migrated = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const events = migrated.readEvents("aggregate-1");
      expect(events).toHaveLength(1);
      expect(events[0]?.eventId).toBe(written.eventId);
      expect(events[0]?.payload).toEqual(written.payload);
      expect(migrated.getCommandReceipt("command-1")?.currentVersion).toBe(1);
      expect(migrated.getAggregateVersion("aggregate-1")).toBe(1);
    } finally {
      migrated.close();
    }

    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(
        after
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/4" });
      expect(after.prepare("SELECT * FROM domain_events ORDER BY global_position").all()).toEqual(
        priorEventRow,
      );
      expect(after.prepare("SELECT * FROM command_receipts ORDER BY command_id").all()).toEqual(
        priorReceiptRow,
      );
      expect(after.prepare("SELECT project_id FROM store_project_binding").get()).toEqual({
        project_id: PROJECT_ID,
      });
      expect(after.prepare("SELECT count(*) AS value FROM recovery_bindings").get()).toEqual({
        value: 0,
      });
      validateExactSchemaObjects(after, SCHEMA_OBJECT_SQL, 4);
      validateSchema(after);
    } finally {
      after.close();
    }
  });

  it("keeps a populated recovery slot across a reopen of the migrated database", () => {
    const path = databasePath("populated-recovery");
    commitOneEvent(path);
    rewindToV3(path);

    const migrated = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const result = migrated.installRecoveryBinding({
        bindingCodecVersion: "moe-recovery-binding/1",
        incarnationRef: "9f".repeat(32),
        installedAt: "2026-08-11T09:30:00.000Z",
        keyEpochRef: "8e".repeat(32),
        payload: encoder.encode("post-migration-binding"),
        slot: "ACTIVE",
      });
      expect(result.ok).toBe(true);
    } finally {
      migrated.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const read = reopened.readRecoveryBinding("ACTIVE");
      expect(read.outcome).toBe("FOUND");
      expect(reopened.readEvents("aggregate-1")).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
