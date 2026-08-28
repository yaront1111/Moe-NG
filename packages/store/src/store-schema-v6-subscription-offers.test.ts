import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableStoreError,
  SQLITE_SCHEMA_MANIFEST_VERSION,
  SqliteEventStore,
} from "./index.js";
import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import { validateExactSchemaObjects } from "./sqlite-schema-conformance.js";
import * as schemaManifest from "./sqlite-schema-manifest.js";
import * as storeDigests from "./store-digests.js";
import * as storeInternals from "./store-internals.js";

const RESULT_BYTES_LEGS = JSON.stringify({ goalId: "goal-a" });
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

  // Seeds the three decision shapes the backfill must derive: a one-leg
  // EFFECTS_COMMITTED decision, a three-leg decision whose legs all carry events (so
  // each leaves a receipt the v6 rows still hold), and a NO_BUSINESS_EFFECT decision
  // produced by a genuine expected-version conflict rather than written by hand. A
  // FENCE leg is deliberately NOT here: it writes no receipt, so v6 keeps no record of
  // its aggregate at all, and the refusal arm below pins that as underivable.
  function seedDecisions(path: string): void {
    const seeded = SqliteEventStore.openForProject(path, "project-1");
    try {
      seeded.commitExpectedVersionDecision(proposedDecision());
      seeded.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create",
        committedResultBytes: bytes(RESULT_BYTES_LEGS),
        correlationId: "correlation-1",
        decidedAt: "2026-08-06T18:00:00.000Z",
        key: { commandId: "command-legs", principalId: "principal-1", projectId: "project-1" },
        legs: [
          {
            aggregateId: "goal-a",
            events: [{ eventId: "event-a", eventType: "goal.created", payload: bytes("payload-a") }],
            expectedVersion: 0,
          },
          {
            aggregateId: "goal-b",
            events: [{ eventId: "event-b", eventType: "goal.created", payload: bytes("payload-b") }],
            expectedVersion: 0,
          },
          {
            aggregateId: "goal-c",
            events: [{ eventId: "event-c", eventType: "goal.created", payload: bytes("payload-c") }],
            expectedVersion: 0,
          },
        ],
        requestBytes: bytes("goal.create/v1"),
      });
      seeded.commitExpectedVersionDecision(proposedDecision({
        key: { commandId: "stale-command", principalId: "principal-1", projectId: "project-1" },
        requestBytes: bytes("stale-request"),
      }));
    } finally {
      seeded.close();
    }
  }

  function stableRows(database: DatabaseSync, sql: string): string {
    return JSON.stringify(database.prepare(sql).all(), (_key, value: unknown) =>
      value instanceof Uint8Array ? `bytes:${Buffer.from(value).toString("hex")}` : value);
  }

  function digestOf(database: DatabaseSync, table: string): string {
    return createHash("sha256")
      .update(stableRows(database, `SELECT * FROM ${table} ORDER BY rowid`))
      .digest("hex");
  }

  interface GoldenV7 {
    readonly carried: Readonly<Record<string, string>>;
    readonly legs: unknown[];
    readonly rosters: unknown[];
  }

  function readGolden(path: string): GoldenV7 {
    const database = new DatabaseSync(path);
    try {
      return {
        carried: {
          command_decisions: digestOf(database, "command_decisions"),
          command_receipts: digestOf(database, "command_receipts"),
          domain_events: digestOf(database, "domain_events"),
        },
        legs: database
          .prepare("SELECT * FROM command_decision_legs ORDER BY decision_id, leg_index").all(),
        rosters: database
          .prepare("SELECT * FROM command_decision_leg_rosters ORDER BY decision_id").all(),
      };
    } finally {
      database.close();
    }
  }

  /** The exact rewind the refusal arm has always used: v7 tables dropped, v6 stamped. */
  function rewindToV6(path: string): void {
    const rewind = new DatabaseSync(path);
    try {
      rewind.exec("DROP TABLE command_decision_legs;");
      rewind.exec("DROP TABLE command_decision_leg_rosters;");
      rewind.prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
        .run(storeInternals.SCHEMA_V6_MANIFEST_VERSION, "schema_manifest_version");
      rewind.exec("PRAGMA user_version = 6;");
      validateExactSchemaObjects(rewind, schemaManifest.SCHEMA_V6_OBJECT_SQL, 6);
    } finally {
      rewind.close();
    }
  }

  function decisionIdOf(database: DatabaseSync, commandId: string): string {
    const row = database.prepare(
      "SELECT decision_id AS value FROM command_decisions WHERE command_id = ?",
    ).get(commandId) as { value: string } | undefined;
    if (row === undefined) throw new Error(`no decision row for ${commandId}`);
    return row.value;
  }

  it("upgrades a populated v6 store in place by deriving every decision leg roster", () => {
    const path = pathFor("populated-v6-upgrade");
    seedDecisions(path);
    const golden = readGolden(path);
    // A seed that silently produced nothing would make every assertion below vacuous.
    expect(golden.rosters).toHaveLength(3);
    expect(golden.legs).toHaveLength(5);
    rewindToV6(path);

    const upgraded = SqliteEventStore.openForProject(path, "project-1");
    try {
      // Each decision still reads through the v7 reader, which validates the roster the
      // migration just derived rather than trusting the rows it wrote.
      expect(upgraded.getCommandDecision(proposedDecision().key)).not.toBeNull();
      expect(upgraded.getCommandDecision({
        commandId: "command-legs", principalId: "principal-1", projectId: "project-1",
      })).not.toBeNull();
      expect(upgraded.getCommandDecision({
        commandId: "stale-command", principalId: "principal-1", projectId: "project-1",
      })).not.toBeNull();
    } finally {
      upgraded.close();
    }

    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      const after = readGolden(path);
      // Row for row, including roster_sha256 and every receipt triple: the derived
      // rosters must BE the writer's, not merely well formed.
      expect(after.rosters).toEqual(golden.rosters);
      expect(after.legs).toEqual(golden.legs);
      // Nothing the migration was not asked to touch may have moved.
      expect(after.carried).toEqual(golden.carried);
      validateExactSchemaObjects(migrated, schemaManifest.SCHEMA_OBJECT_SQL, 7);
    } finally {
      migrated.close();
    }
  });

  it("refuses only a v6 decision it cannot derive deterministically", () => {
    // Both cases remove a receipt the derivation would need, but they are refused by
    // DIFFERENT mechanisms and the difference is a schema fact, not a choice:
    // command_decisions.receipt_command_id REFERENCES command_receipts(command_id)
    // (sqlite-schema-manifest.ts), so a missing CANONICAL receipt is a dangling
    // foreign key that the store's own foreign_key_check refuses before any migration
    // reasoning happens. Only a LEG receipt is unreferenced in v6 - the table that
    // pointed at it is dropped on the way down - so the index gap is the case that
    // actually reaches the backfill and must refuse STORE_MIGRATION_REQUIRED.
    const damages: readonly (readonly [string, string, (database: DatabaseSync) => void])[] = [
      ["leg-index-gap", "STORE_MIGRATION_REQUIRED", (database: DatabaseSync): void => {
        // Leg 1 and everything that hung off it go together, so the store stays
        // FOREIGN-KEY CONSISTENT: this is a v6 database that genuinely no longer holds
        // that leg, not a dangling reference. The consistency is asserted, not assumed,
        // so the refusal below cannot be the foreign-key check answering first.
        const legReceipt = storeDigests
          .legReceiptCommandId(decisionIdOf(database, "command-legs"), 1);
        database.exec("PRAGMA foreign_keys = OFF;");
        database.prepare(`
          DELETE FROM outbox_messages WHERE event_id IN (
            SELECT event_id FROM domain_events WHERE command_id = ?
          )
        `).run(legReceipt);
        database.prepare("DELETE FROM domain_events WHERE command_id = ?").run(legReceipt);
        database.prepare("DELETE FROM command_receipt_scopes WHERE receipt_command_id = ?")
          .run(legReceipt);
        database.prepare("DELETE FROM command_receipts WHERE command_id = ?").run(legReceipt);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }],
      ["missing-canonical-receipt", "STORE_SCHEMA_INVALID", (database: DatabaseSync): void => {
        database.exec("PRAGMA foreign_keys = OFF;");
        database.prepare("DELETE FROM command_receipts WHERE command_id = ?")
          .run(storeDigests.internalReceiptCommandId(decisionIdOf(database, "command-1")));
      }],
    ];
    for (const [label, expectedCode, damage] of damages) {
      const path = pathFor(`underivable-${label}`);
      seedDecisions(path);
      rewindToV6(path);
      const damaged = new DatabaseSync(path);
      try { damage(damaged); } finally { damaged.close(); }

      let refusal: unknown;
      try {
        SqliteEventStore.openForProject(path, "project-1").close();
      } catch (error) {
        refusal = error;
      }
      expect(refusal, label).toBeInstanceOf(DurableStoreError);
      expect(refusal, label).toMatchObject({ code: expectedCode });

      const retained = new DatabaseSync(path);
      try {
        expect(retained.prepare("PRAGMA user_version").get(), label).toEqual({ user_version: 6 });
        expect(retained.prepare("SELECT count(*) AS value FROM command_decisions").get(), label)
          .toEqual({ value: 3 });
        expect(retained.prepare(`
          SELECT count(*) AS value FROM sqlite_schema
          WHERE name IN ('command_decision_leg_rosters', 'command_decision_legs')
        `).get(), label).toEqual({ value: 0 });
        validateExactSchemaObjects(retained, schemaManifest.SCHEMA_V6_OBJECT_SQL, 6);
      } finally {
        retained.close();
      }
    }
  });
});
