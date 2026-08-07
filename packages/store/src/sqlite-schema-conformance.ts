import type { DatabaseSync } from "node:sqlite";

import { DurableStoreError } from "./store-contracts.js";
import { requireRowString } from "./store-rows.js";

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;\s*$/u, "");
}

export function validateExactSchemaObjects(
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

export function validateSchemaManifestMetadata(
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
