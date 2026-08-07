import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
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
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(
        database
          .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
          .get(),
      ).toEqual({ value: "moe-sqlite-schema/3" });
      expect(SQLITE_SCHEMA_MANIFEST_VERSION).toBe("moe-sqlite-schema/3");
      expect(Object.keys(schemaManifest.SCHEMA_OBJECT_SQL)).toHaveLength(14);
      validateSchema(database);
      validateExactSchemaObjects(database, schemaManifest.SCHEMA_OBJECT_SQL, 3);

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
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
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
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(migrated.prepare("SELECT project_id FROM store_project_binding").get()).toEqual({
        project_id: "project-1",
      });
      validateExactSchemaObjects(migrated, schemaManifest.SCHEMA_OBJECT_SQL, 3);
    } finally {
      migrated.close();
    }
  });

  it("refuses populated v1 and v2 databases without migrating them", () => {
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

      expect(() => openAndClose(path)).toThrowError(/STORE_MIGRATION_REQUIRED/u);
      const verification = new DatabaseSync(path);
      try {
        expect(verification.prepare("PRAGMA user_version").get()).toEqual({
          user_version: version,
        });
      } finally {
        verification.close();
      }
    }
  });

  it("refuses a newer schema version", () => {
    const path = databasePath("too-new");
    openAndClose(path);
    const tamper = new DatabaseSync(path);
    try {
      tamper.exec("PRAGMA user_version = 4");
    } finally {
      tamper.close();
    }

    expect(() => openAndClose(path)).toThrowError(/STORE_SCHEMA_INVALID/u);
  });

  it("creates deterministic schema bytes", () => {
    expect(schemaDump(databasePath("deterministic-a"))).toBe(
      schemaDump(databasePath("deterministic-b")),
    );
  });
});
