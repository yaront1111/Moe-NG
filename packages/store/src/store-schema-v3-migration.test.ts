import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableStoreError,
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_MANIFEST_VERSION,
  SqliteEventStore,
} from "./index.js";
import { installFrozenV1Schema } from "./command-decision-test-helpers.js";
import { validateExactSchemaObjects } from "./sqlite-schema-conformance.js";
import { validateSchema } from "./sqlite-schema-integrity.js";
import * as schemaManifest from "./sqlite-schema-manifest.js";
import { SCHEMA_V2_MANIFEST_VERSION } from "./store-internals.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-schema-v3-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

function v2Manifest(): Readonly<Record<string, string>> {
  const manifest = Reflect.get(schemaManifest, "SCHEMA_V2_OBJECT_SQL");
  expect(manifest, "the frozen v2 manifest must be exported").toBeDefined();
  return manifest as Readonly<Record<string, string>>;
}

function installV2Schema(database: DatabaseSync, projectId?: string): void {
  database.exec(`${Object.values(v2Manifest()).join(";\n")};`);
  database
    .prepare("INSERT INTO store_metadata (key, value) VALUES (?, ?)")
    .run("schema_manifest_version", SCHEMA_V2_MANIFEST_VERSION);
  if (projectId !== undefined) {
    database
      .prepare("INSERT INTO store_project_binding (singleton, project_id) VALUES (1, ?)")
      .run(projectId);
  }
  database.exec(`
    PRAGMA application_id = ${SQLITE_APPLICATION_ID};
    PRAGMA user_version = 2;
  `);
}

function openAndClose(path: string, projectId?: string): void {
  const store =
    projectId === undefined
      ? SqliteEventStore.open(path)
      : SqliteEventStore.openForProject(path, projectId);
  store.close();
}

/**
 * Captures the durable failure rather than regex-matching a message. The CODE is
 * the stable contract; the message is retained only to attribute WHICH layer
 * refused, because more than one layer can answer on these paths.
 */
function captureDurableFailure(
  run: () => void,
): { readonly code: string; readonly message: string } {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DurableStoreError);
  const failure = caught as DurableStoreError;
  return { code: failure.code, message: failure.message };
}

function schemaDump(path: string): string {
  openAndClose(path);
  const database = new DatabaseSync(path);
  try {
    return JSON.stringify(
      database
        .prepare(`
          SELECT type, name, tbl_name, sql
          FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name
        `)
        .all(),
    );
  } finally {
    database.close();
  }
}

describe("SQLite schema v3 migration", () => {
  it("creates the exact v3 projection schema without new autoincrement ledgers", () => {
    const path = databasePath("fresh");
    openAndClose(path);
    const database = new DatabaseSync(path);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(
        database
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/6" });
      expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/6");
      expect(Object.keys(schemaManifest.SCHEMA_OBJECT_SQL)).toHaveLength(17);
      validateSchema(database);
      validateExactSchemaObjects(database, schemaManifest.SCHEMA_OBJECT_SQL, 6);

      const domainSql = schemaManifest.SCHEMA_OBJECT_SQL.domain_events;
      expect(domainSql).toContain("global_position INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(domainSql).toContain(
        "domain_schema_version TEXT NOT NULL DEFAULT 'moe-domain-schema/0'",
      );
      for (const table of [
        "projections",
        "inbox_receipts",
        "event_subscriptions",
        "cursor_generations",
      ] as const) {
        expect(schemaManifest.SCHEMA_OBJECT_SQL[table]).toBeDefined();
        expect(schemaManifest.SCHEMA_OBJECT_SQL[table]).not.toContain("AUTOINCREMENT");
      }
    } finally {
      database.close();
    }
  });

  it("migrates an empty v1 database through both schema legs", () => {
    const path = databasePath("v1-empty");
    const database = new DatabaseSync(path);
    installFrozenV1Schema(database);
    database.close();

    openAndClose(path);
    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      validateSchema(migrated);
    } finally {
      migrated.close();
    }
  });

  it("migrates a bound but otherwise empty v2 database", () => {
    const path = databasePath("v2-bound-empty");
    const database = new DatabaseSync(path);
    try {
      installV2Schema(database, "project-1");
    } finally {
      database.close();
    }

    openAndClose(path, "project-1");
    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(migrated.prepare("SELECT project_id FROM store_project_binding").get()).toEqual({
        project_id: "project-1",
      });
      validateExactSchemaObjects(migrated, schemaManifest.SCHEMA_OBJECT_SQL, 6);
    } finally {
      migrated.close();
    }
  });

  it("refuses populated v1 and v2 databases without migrating them", () => {
    const observed: { readonly code: string; readonly version: number }[] = [];
    for (const version of [1, 2] as const) {
      const path = databasePath(`v${version}-populated`);
      const database = new DatabaseSync(path);
      try {
        if (version === 1) installFrozenV1Schema(database);
        else installV2Schema(database);
        database
          .prepare("INSERT INTO aggregate_heads (aggregate_id, version) VALUES (?, ?)")
          .run("aggregate-1", 1);
      } finally {
        database.close();
      }

      observed.push({ code: captureDurableFailure(() => openAndClose(path)).code, version });
      const verification = new DatabaseSync(path);
      try {
        expect(verification.prepare("PRAGMA user_version").get()).toEqual({
          user_version: version,
        });
      } finally {
        verification.close();
      }
    }

    expect(observed).toEqual([
      { code: "STORE_MIGRATION_REQUIRED", version: 1 },
      { code: "STORE_MIGRATION_REQUIRED", version: 2 },
    ]);
  });

  /**
   * Three rejections a bare "it threw" would blur into one. Only the future
   * version is a schema judgement; the two identity mismatches come from
   * DIFFERENT layers — bootstrap's fresh-database probe answers first when the
   * version is missing, while migrateLocked owns the unrecognized-source branch.
   * With 1-5 all recognized and 6 current, a negative stamp is the only value
   * that still reaches that branch, so this is what keeps it non-vacuous.
   */
  it("refuses every schema version outside the recognized migration range", () => {
    const cases = [
      { code: "STORE_SCHEMA_INVALID", label: "future",
        layer: "newer than supported version", stamped: 7 },
      { code: "DATABASE_IDENTITY_MISMATCH", label: "no-committed-version",
        layer: "has no committed schema version", stamped: 0 },
      { code: "DATABASE_IDENTITY_MISMATCH", label: "unrecognized-source",
        layer: "is not a recognized migration source", stamped: -1 },
    ] as const;

    const observed = cases.map((testCase) => {
      const path = databasePath(testCase.label);
      openAndClose(path);
      const tamper = new DatabaseSync(path);
      try {
        tamper.exec(`PRAGMA user_version = ${testCase.stamped};`);
      } finally {
        tamper.close();
      }

      const failure = captureDurableFailure(() => openAndClose(path));
      const retained = new DatabaseSync(path);
      try {
        expect(retained.prepare("PRAGMA user_version").get(), testCase.label).toEqual({
          user_version: testCase.stamped,
        });
      } finally {
        retained.close();
      }
      return {
        attributedLayer: failure.message.includes(testCase.layer),
        code: failure.code,
        label: testCase.label,
      };
    });

    expect(observed).toEqual([
      { attributedLayer: true, code: "STORE_SCHEMA_INVALID", label: "future" },
      { attributedLayer: true, code: "DATABASE_IDENTITY_MISMATCH",
        label: "no-committed-version" },
      { attributedLayer: true, code: "DATABASE_IDENTITY_MISMATCH",
        label: "unrecognized-source" },
    ]);
  });

  it("creates deterministic schema bytes", () => {
    expect(schemaDump(databasePath("deterministic-a"))).toBe(
      schemaDump(databasePath("deterministic-b")),
    );
  });
});
