import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableStoreError,
  SQLITE_SCHEMA_MANIFEST_VERSION,
  SqliteEventStore,
} from "./index.js";
import { proposedDecision } from "./command-decision-test-helpers.js";
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

describe("SQLite schema v6 offers and v7 decision-leg authority", () => {
  it("retains the frozen v6 manifest and installs exact v7 authority tables", () => {
    expect(storeInternals.SCHEMA_VERSION).toBe(7);
    expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/7");
    expect(storeInternals.SCHEMA_V6_MANIFEST_VERSION).toBe("moe-sqlite-schema/6");
    expect(Object.keys(schemaManifest.SCHEMA_V6_OBJECT_SQL)).toHaveLength(17);
    expect(Object.keys(schemaManifest.SCHEMA_OBJECT_SQL)).toHaveLength(19);
    expect(schemaManifest.SCHEMA_OBJECT_SQL).toHaveProperty("subscription_pending_offers");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers).toContain("STRICT");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(from_position) BETWEEN 1 AND 19");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(issued_position) BETWEEN 1 AND 19");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.subscription_pending_offers)
      .toContain("length(checkpoint) BETWEEN 1 AND 19");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.command_decision_leg_rosters).toContain("STRICT");
    expect(schemaManifest.SCHEMA_OBJECT_SQL.command_decision_legs).toContain("STRICT");

    const path = pathFor("fresh");
    const store = SqliteEventStore.openForProject(path, "schema-v6-project");
    store.close();
    const database = new DatabaseSync(path);
    try {
      validateExactSchemaObjects(database, schemaManifest.SCHEMA_OBJECT_SQL, 7);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
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
    rewind.exec("DROP TABLE command_decision_legs;");
    rewind.exec("DROP TABLE command_decision_leg_rosters;");
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
      validateExactSchemaObjects(migrated, schemaManifest.SCHEMA_OBJECT_SQL, 7);
    } finally {
      migrated.close();
    }
  });

  it("refuses populated v6 command decisions without inferring a surviving roster", () => {
    const path = pathFor("populated-v6-decisions");
    const seeded = SqliteEventStore.openForProject(path, "project-1");
    seeded.commitExpectedVersionDecision(proposedDecision());
    seeded.close();

    const rewind = new DatabaseSync(path);
    rewind.exec("DROP TABLE command_decision_legs;");
    rewind.exec("DROP TABLE command_decision_leg_rosters;");
    rewind.prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
      .run(storeInternals.SCHEMA_V6_MANIFEST_VERSION, "schema_manifest_version");
    rewind.exec("PRAGMA user_version = 6;");
    validateExactSchemaObjects(rewind, schemaManifest.SCHEMA_V6_OBJECT_SQL, 6);
    rewind.close();

    let refusal: unknown;
    try {
      SqliteEventStore.openForProject(path, "project-1").close();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DurableStoreError);
    expect(refusal).toMatchObject({ code: "STORE_MIGRATION_REQUIRED" });

    const retained = new DatabaseSync(path);
    try {
      expect(retained.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(retained.prepare("SELECT count(*) AS value FROM command_decisions").get())
        .toEqual({ value: 1 });
      expect(retained.prepare(`
        SELECT count(*) AS value FROM sqlite_schema
        WHERE name IN ('command_decision_leg_rosters', 'command_decision_legs')
      `).get()).toEqual({ value: 0 });
      validateExactSchemaObjects(retained, schemaManifest.SCHEMA_V6_OBJECT_SQL, 6);
    } finally {
      retained.close();
    }
  });
});
