import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DurableStoreError, SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "./index.js";
import type { CommitExpectedVersionDecisionInput } from "./index.js";
import { proposedDecision } from "./command-decision-test-helpers.js";
import {
  validateExactSchemaObjects,
  validateSchemaManifestMetadata,
} from "./sqlite-schema-conformance.js";
import { validateSchema } from "./sqlite-schema-integrity.js";
import {
  SCHEMA_OBJECT_SQL,
  SCHEMA_V3_OBJECT_SQL,
  SCHEMA_V4_OBJECT_SQL,
  SCHEMA_V5_OBJECT_SQL,
} from "./sqlite-schema-manifest.js";
import {
  SCHEMA_V3_MANIFEST_VERSION,
  SCHEMA_V4_MANIFEST_VERSION,
  SCHEMA_VERSION,
} from "./store-internals.js";

const encoder = new TextEncoder();
const PROJECT_ID = "schema-v4-project";
const EVENT_TYPE_INDEX = "domain_events_event_type_position";

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
    database.exec("DROP TABLE command_decision_legs;");
    database.exec("DROP TABLE command_decision_leg_rosters;");
    database.exec("DROP TABLE subscription_pending_offers;");
    database.exec(`DROP INDEX ${EVENT_TYPE_INDEX};`);
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

function captureSchemaCode(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DurableStoreError);
  return (caught as DurableStoreError).code;
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
    expect(SCHEMA_VERSION).toBe(7);
    expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/7");
    expect(SCHEMA_V4_MANIFEST_VERSION).toBe("moe-sqlite-schema/4");
    expect(SCHEMA_V3_MANIFEST_VERSION).toBe("moe-sqlite-schema/3");
    expect(Object.keys(SCHEMA_V3_OBJECT_SQL)).toHaveLength(14);
    expect(Object.keys(SCHEMA_V4_OBJECT_SQL)).toHaveLength(15);
    expect(Object.keys(SCHEMA_V5_OBJECT_SQL)).toHaveLength(16);
    expect(Object.keys(SCHEMA_OBJECT_SQL)).toHaveLength(19);
    expect(
      Object.keys(SCHEMA_OBJECT_SQL).filter((name) => !(name in SCHEMA_V4_OBJECT_SQL)),
    ).toEqual([
      EVENT_TYPE_INDEX,
      "subscription_pending_offers",
      "command_decision_leg_rosters",
      "command_decision_legs",
    ]);
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
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      expect(
        database
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/7" });
      expect(database.prepare("SELECT count(*) AS value FROM recovery_bindings").get()).toEqual({
        value: 0,
      });
      validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, 7);
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
        () => validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, 7),
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
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      expect(
        after
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/7" });
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
      validateExactSchemaObjects(after, SCHEMA_OBJECT_SQL, 7);
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

const TARGET_EVENT_TYPE = "recovery.probe";

/**
 * The predicate the v5 index exists to serve. Design line 959 requires the event
 * API to support type filters; without the index this is a full table scan.
 */
const TYPE_POSITION_QUERY = `
  SELECT event_id
  FROM domain_events
  WHERE event_type = ? AND global_position > ?
  ORDER BY global_position
`;

/** Every durable table whose bytes an additive migration must leave alone. */
const DURABLE_TABLES: readonly string[] = [
  "aggregate_heads", "command_decisions", "command_receipt_scopes", "command_receipts",
  "cursor_generations", "domain_events", "event_subscriptions", "inbox_receipts",
  "outbox_messages", "projections", "recovery_bindings", "store_project_binding",
];

interface AtomicDecisionStore {
  commitExpectedVersionDecisionWithApply(
    input: CommitExpectedVersionDecisionInput,
    apply: (context: { readonly database: DatabaseSync }) => void,
  ): unknown;
}

/**
 * Seeds every durable category through the PUBLIC production surface — one
 * decision carrying three events (two of the target type, one other) plus an
 * outbox message, the projection/cursor/inbox/subscription rows written inside
 * the production apply transaction, and one installed recovery binding. A
 * hand-assembled fixture would not prove the migration faces real ledger bytes.
 */
function writeProductionFixture(path: string): void {
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  try {
    (store as unknown as AtomicDecisionStore).commitExpectedVersionDecisionWithApply(
      proposedDecision({
        events: [
          {
            eventId: "event-1",
            eventType: TARGET_EVENT_TYPE,
            outbox: [
              { messageId: "message-1", payload: encoder.encode("wire-1"), topic: "recovery.events" },
            ],
            payload: encoder.encode("payload-1"),
          },
          { eventId: "event-2", eventType: "other.kind", payload: encoder.encode("payload-2") },
          { eventId: "event-3", eventType: TARGET_EVENT_TYPE, payload: encoder.encode("payload-3") },
        ],
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
      }),
      ({ database }) => {
        database
          .prepare(`
            INSERT INTO projections (projection_name, last_applied_position, state_digest)
            VALUES (?, ?, ?)
          `)
          .run("recovery-view", "3", "a1".repeat(32));
        database
          .prepare("INSERT INTO cursor_generations (generation, created_at, reason) VALUES (?, ?, ?)")
          .run(1, "2026-08-16T00:00:00.000Z", "bootstrap");
        database
          .prepare(`
            INSERT INTO inbox_receipts (consumer_id, message_id, receipt_digest) VALUES (?, ?, ?)
          `)
          .run("consumer-1", "message-1", "b2".repeat(32));
        database
          .prepare(`
            INSERT INTO event_subscriptions (subscriber_id, filter_json, created_at) VALUES (?, ?, ?)
          `)
          .run("subscriber-1", '{"eventType":"recovery.probe"}', "2026-08-16T00:00:00.000Z");
      },
    );
    const installed = store.installRecoveryBinding({
      bindingCodecVersion: "moe-recovery-binding/1",
      incarnationRef: "9f".repeat(32),
      installedAt: "2026-08-16T00:30:00.000Z",
      keyEpochRef: "8e".repeat(32),
      payload: encoder.encode("pre-migration-binding"),
      slot: "ACTIVE",
    });
    expect(installed.ok, "recovery binding fixture must install").toBe(true);
  } finally {
    store.close();
  }
}

function rowCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path);
  try {
    const counts: Record<string, number> = {};
    for (const table of DURABLE_TABLES) {
      counts[table] = Number(
        (database.prepare(`SELECT count(*) AS value FROM ${table}`).get() as { value: number })
          .value,
      );
    }
    return counts;
  } finally {
    database.close();
  }
}

/**
 * store_metadata is deliberately excluded: the manifest stamp is the ONE row the
 * migration is allowed to change, so folding it in here would hide a rewrite of
 * anything else behind an expected difference.
 */
function snapshotDurableRows(path: string): Record<string, readonly unknown[]> {
  const database = new DatabaseSync(path);
  try {
    const snapshot: Record<string, readonly unknown[]> = {};
    for (const table of DURABLE_TABLES) {
      snapshot[table] = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    snapshot["sqlite_sequence"] = database
      .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
      .all();
    return snapshot;
  } finally {
    database.close();
  }
}

/** Rewinds a v5 file to a genuine v4 file by dropping ONLY the new index. */
function rewindToV4(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("DROP TABLE command_decision_legs;");
    database.exec("DROP TABLE command_decision_leg_rosters;");
    database.exec("DROP TABLE subscription_pending_offers;");
    database.exec(`DROP INDEX ${EVENT_TYPE_INDEX};`);
    database
      .prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
      .run(SCHEMA_V4_MANIFEST_VERSION, "schema_manifest_version");
    database.exec("PRAGMA user_version = 4;");
    validateExactSchemaObjects(database, SCHEMA_V4_OBJECT_SQL, 4);
    validateSchemaManifestMetadata(database, SCHEMA_V4_MANIFEST_VERSION);
  } finally {
    database.close();
  }
}

describe("SQLite schema v5 event-type index migration", () => {
  it("serves the filtered ordered read from the named index, not a scan", () => {
    const path = databasePath("index-plan");
    writeProductionFixture(path);

    const database = new DatabaseSync(path);
    try {
      expect(
        database
          .prepare(`
            SELECT name FROM sqlite_schema
            WHERE type = 'index' AND tbl_name = 'domain_events' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      ).toEqual([EVENT_TYPE_INDEX]);

      // Column ORDER, not just membership: a reversed index keeps the same name.
      expect(
        database
          .prepare(`PRAGMA index_info(${EVENT_TYPE_INDEX})`)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      ).toEqual(["event_type", "global_position"]);

      const plan = database.prepare(`EXPLAIN QUERY PLAN ${TYPE_POSITION_QUERY}`).all();
      expect(plan).toHaveLength(1);
      const detail = String((plan[0] as { detail: unknown }).detail);
      expect(detail).toContain(EVENT_TYPE_INDEX);
      expect(detail).toContain("(event_type=? AND global_position>?)");
      expect(detail).not.toContain("SCAN ");
      expect(detail).not.toContain("USE TEMP B-TREE");

      // The plan is only evidence if the query it describes returns the right rows.
      const idsAfter = (position: number): readonly string[] =>
        database
          .prepare(TYPE_POSITION_QUERY)
          .all(TARGET_EVENT_TYPE, position)
          .map((row) => String((row as { event_id: unknown }).event_id));
      expect(idsAfter(0)).toEqual(["event-1", "event-3"]);
      expect(idsAfter(1)).toEqual(["event-3"]);
    } finally {
      database.close();
    }
  });

  it("refuses a populated v4 decision store instead of inventing leg authority", () => {
    const path = databasePath("populated-v4");
    writeProductionFixture(path);

    // Prove every asserted category is actually seeded; an empty snapshot
    // would compare equal to itself and prove nothing.
    expect(rowCounts(path)).toEqual({
      aggregate_heads: 1, command_decisions: 1, command_receipt_scopes: 1, command_receipts: 1,
      cursor_generations: 1, domain_events: 3, event_subscriptions: 1, inbox_receipts: 1,
      outbox_messages: 1, projections: 1, recovery_bindings: 1, store_project_binding: 1,
    });

    rewindToV4(path);
    const before = snapshotDurableRows(path);
    expect(
      before["domain_events"]?.map((row) => Number((row as { global_position: unknown }).global_position)),
    ).toEqual([1, 2, 3]);
    expect(before["sqlite_sequence"]).toEqual([
      { name: "command_decisions", seq: 1 },
      { name: "domain_events", seq: 3 },
      { name: "outbox_messages", seq: 1 },
    ]);

    expect(captureSchemaCode(() =>
      SqliteEventStore.openForProject(path, PROJECT_ID).close(),
    )).toBe("STORE_MIGRATION_REQUIRED");
    expect(snapshotDurableRows(path)).toEqual(before);

    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(
        after
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/4" });
      expect(after.prepare(`PRAGMA index_info(${EVENT_TYPE_INDEX})`).all()).toEqual([]);
      expect(after.prepare(`
        SELECT count(*) AS value
        FROM sqlite_schema
        WHERE name IN ('command_decision_leg_rosters', 'command_decision_legs')
      `).get()).toEqual({ value: 0 });
      validateExactSchemaObjects(after, SCHEMA_V4_OBJECT_SQL, 4);
    } finally {
      after.close();
    }
  });

  it("fails closed when the v5 index is missing, renamed, or column-reversed", () => {
    const cases = [
      { label: "missing", rebuild: null },
      {
        label: "renamed",
        rebuild: `CREATE INDEX domain_events_type_lookup
      ON domain_events(event_type, global_position)`,
      },
      {
        label: "reversed",
        rebuild: `CREATE INDEX ${EVENT_TYPE_INDEX}
      ON domain_events(global_position, event_type)`,
      },
    ] as const;

    const observed = cases.map((testCase) => {
      const path = databasePath(`tamper-${testCase.label}`);
      SqliteEventStore.openForProject(path, PROJECT_ID).close();
      const tamper = new DatabaseSync(path);
      try {
        tamper.exec(`DROP INDEX ${EVENT_TYPE_INDEX};`);
        if (testCase.rebuild !== null) tamper.exec(`${testCase.rebuild};`);
      } finally {
        tamper.close();
      }
      return {
        code: captureSchemaCode(() =>
          SqliteEventStore.openForProject(path, PROJECT_ID).close(),
        ),
        label: testCase.label,
      };
    });

    expect(observed).toEqual([
      { code: "STORE_SCHEMA_INVALID", label: "missing" },
      { code: "STORE_SCHEMA_INVALID", label: "renamed" },
      { code: "STORE_SCHEMA_INVALID", label: "reversed" },
    ]);
  });
});
