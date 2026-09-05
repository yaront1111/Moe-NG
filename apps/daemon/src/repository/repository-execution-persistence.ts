import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import type { RepositoryExecutionIdentity, RepositoryExecutionResult } from "./repository-execution-contracts.js";
import { decodeExecutionRecord } from "./repository-execution-record.js";
import type { RepositoryExecutionRecord } from "./repository-execution-record.js";

type Mutation<T> = (record: RepositoryExecutionRecord | null, nextRevision: number) => RepositoryExecutionResult<{ record: RepositoryExecutionRecord | null; value: T }>;
const unknown = () => repositoryExecutionFailure("REPOSITORY_EXECUTION_UNKNOWN");

/** Short SQLite transactions own physical serialization; the logical reservation survives process death. */
export function accessRepositoryExecution<T>(identity: RepositoryExecutionIdentity, mode: "READ" | "CREATE" | "UPDATE",
  action: Mutation<T>): RepositoryExecutionResult<{ value: T }> {
  const path = join(identity.gitDirectory, "moe-repository-execution.sqlite");
  const existed = existsSync(path);
  if (!existed && mode === "READ") {
    const result = action(null, 1); return result.ok ? { ok: true, value: result.value } : result;
  }
  if (!existed && mode !== "CREATE") return unknown();
  let database: DatabaseSync | null = null;
  let transaction = false;
  try {
    // An existing SQLite database needs write access to roll back a hot journal left by
    // a killed writer. READ executes no logical writes; absent-file READ returned above.
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 1000");
    if (mode !== "READ") database.exec("PRAGMA synchronous = FULL");
    database.exec(mode === "READ" ? "BEGIN" : "BEGIN IMMEDIATE"); transaction = true;
    const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
    if (version === 0 && !existed && mode === "CREATE") {
      if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length !== 0) return unknown();
      database.exec("CREATE TABLE binding (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), identity_json TEXT NOT NULL, revision INTEGER NOT NULL)");
      database.exec("CREATE TABLE reservation (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_json TEXT NOT NULL, state_json TEXT NOT NULL, revision INTEGER NOT NULL, ever_executed INTEGER NOT NULL)");
      database.prepare("INSERT INTO binding VALUES (1, ?, 0)").run(JSON.stringify(identity));
      database.exec("PRAGMA user_version = 1");
      chmodSync(path, 0o600);
    } else if (version !== 1) return unknown();
    const binding = database.prepare("SELECT identity_json, revision FROM binding WHERE singleton = 1").get();
    if (binding?.["identity_json"] !== JSON.stringify(identity)) return unknown();
    const revision = binding["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
      || (mode !== "READ" && revision === Number.MAX_SAFE_INTEGER)) return unknown();
    const rows = database.prepare("SELECT owner_json, state_json, revision, ever_executed FROM reservation").all();
    if (rows.length > 1) return unknown();
    const row = rows[0]; const record = row === undefined ? null : decodeExecutionRecord(row);
    if ((row !== undefined && record === null) || (record !== null && record.revision !== revision)) return unknown();
    const result = action(record, revision + 1);
    if (!result.ok) return result;
    if (mode !== "READ") {
      if (result.record === null) database.exec("DELETE FROM reservation WHERE singleton = 1");
      else {
        const next = result.record;
        if (next.revision !== revision + 1) return unknown();
        database.prepare("INSERT INTO reservation VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner_json=excluded.owner_json, state_json=excluded.state_json, revision=excluded.revision, ever_executed=excluded.ever_executed")
          .run(JSON.stringify(next.owner), JSON.stringify(next.state), next.revision, next.everExecuted ? 1 : 0);
        database.prepare("UPDATE binding SET revision = ? WHERE singleton = 1").run(next.revision);
      }
    }
    database.exec("COMMIT"); transaction = false;
    return { ok: true, value: result.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return repositoryExecutionFailure(/(?:database is locked|database table is locked)/u.test(message)
      ? "REPOSITORY_EXECUTION_BUSY" : "REPOSITORY_EXECUTION_UNKNOWN");
  } finally {
    if (database !== null) {
      if (transaction) { try { database.exec("ROLLBACK"); } catch { /* Logical owner remains held. */ } }
      database.close();
    }
  }
}
