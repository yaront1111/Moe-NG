import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "./index.js";
import { validateExactSchemaObjects } from "./sqlite-schema-conformance.js";
import * as schemaManifest from "./sqlite-schema-manifest.js";
import * as storeInternals from "./store-internals.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function pathFor(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-schema-v6-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

describe("SQLite schema v6 durable subscription offers", () => {
  it("installs the exact additive v6 object and version identities", () => {
    expect(storeInternals.SCHEMA_VERSION).toBe(6);
    expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/6");
    expect(Object.keys(schemaManifest.SCHEMA_OBJECT_SQL)).toHaveLength(17);
    expect(schemaManifest.SCHEMA_OBJECT_SQL).toHaveProperty("subscription_pending_offers");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers).toContain("STRICT");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(from_position) BETWEEN 1 AND 19");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(issued_position) BETWEEN 1 AND 19");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(checkpoint) BETWEEN 1 AND 19");

    const path = pathFor("fresh");
    const store = SqliteEventStore.openForProject(path, "schema-v6-project");
    store.close();
    const database = new DatabaseSync(path);
    try {
      validateExactSchemaObjects(database, schemaManifest.SCHEMA_OBJECT_SQL, 6);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    } finally {
      database.close();
    }
  });

  it("migrates a populated v5 store without rewriting its ledger rows", () => {
    const path = pathFor("populated-v5");
    const seeded = SqliteEventStore.openForProject(path, "schema-v6-project");
    seeded.commit({
      aggregateId: "goal-1",
      commandBytes: new TextEncoder().encode("command"),
      commandId: "command-1",
      committedAt: "2026-08-16T10:00:00.000Z",
      events: [{
        eventId: "event-1", eventType: "goal.created",
        payload: new TextEncoder().encode("payload"),
      }],
      expectedVersion: 0,
    });
    seeded.close();

    const rewind = new DatabaseSync(path);
    const before = rewind.prepare("SELECT * FROM domain_events").all();
    rewind.exec("DROP TABLE subscription_pending_offers;");
    rewind.prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
      .run(storeInternals.SCHEMA_V5_MANIFEST_VERSION, "schema_manifest_version");
    rewind.exec("PRAGMA user_version = 5;");
    validateExactSchemaObjects(rewind, schemaManifest.SCHEMA_V5_OBJECT_SQL, 5);
    rewind.close();

    SqliteEventStore.openForProject(path, "schema-v6-project").close();
    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare("SELECT * FROM domain_events").all()).toEqual(before);
      expect(migrated.prepare("SELECT count(*) AS value FROM subscription_pending_offers").get())
        .toEqual({ value: 0 });
      validateExactSchemaObjects(migrated, schemaManifest.SCHEMA_OBJECT_SQL, 6);
    } finally {
      migrated.close();
    }
  });
});
