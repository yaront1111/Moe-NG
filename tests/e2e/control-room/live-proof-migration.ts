/**
 * THE MIGRATION RECEIPT on the fresh product, against a REAL PostgreSQL.
 *
 * THE PRD ASKS FOR ONE POSTGRESQL TABLE, so this proof applies one: `standup_entry`, with the
 * UNIQUE constraint the approved criteria name by its exact database identifier. The database
 * is a real `postgres:16-alpine` container started for this run and removed after it. `psql` is
 * not on this host's PATH (measured 2026-09-09) and is not needed: every statement runs through
 * `docker exec` inside the container that ships it.
 *
 * WHAT IS PRODUCTION AND WHAT IS THIS FILE'S. The receipt is written by the SHIPPED writer,
 * `recordMigrationReceipt`, which re-decodes its own bytes before committing and refuses
 * MIGRATION_RECEIPT_INVALID on anything the durable decoder would not admit -- so the receipt
 * this proof records is a receipt the product itself would accept. What this file owns is the
 * EFFECT the receipt describes: the dump, the DDL and their outcomes. Nothing is asserted about
 * the schema that the database was not asked and did not answer.
 *
 * THE BACKUP IS A REAL DUMP. `pg_dump` runs inside the container BEFORE the migration and its
 * bytes land in the confined directory `backupOf` admits -- `<workspace>/.moe-next/backups/
 * pre-migration/<environment>/<17 digits>.sql` -- and the receipt's `backupRef` carries that
 * path with the sha256 OF THOSE BYTES. A digest invented for the reference would pass the
 * decoder and prove nothing, which is why it is computed from the file.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF,
} from "../../../apps/daemon/src/bootstrap/activation-receipts-measure.js";
import {
  MIGRATION_RECEIPT_VERSION, migrationReceiptId, migrationRefusal, recordMigrationReceipt,
} from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";

/** `postgres:16-alpine` is small and ships both `psql` and `pg_dump`. */
const POSTGRES_IMAGE = "postgres:16-alpine";
const DATABASE = "standup";
const DATABASE_USER = "postgres";
const PASSWORD = "live-proof-not-a-secret";
/** `\d{13,17}[-_]...` — what production's `migrationFilename` admits. */
export const MIGRATION_FILE = "20260909120000001-create-standup-entry.sql";
/** `^\d{17}\.sql$` — what production's `BACKUP_LEAF_NAME` admits as a pre-migration dump leaf. */
const BACKUP_LEAF_FILE = "20260909120000000.sql";
const READY_ATTEMPTS = 60;

/** A synchronous pause. This module runs a strictly ordered docker sequence with no awaits. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * The one migration's DDL. Its UNIQUE constraint is named EXPLICITLY rather than left to
 * PostgreSQL's default, because the approved criterion A5 asserts that exact identifier: a
 * constraint whose name PostgreSQL happened to generate would make the criterion depend on a
 * naming convention nobody wrote down.
 */
export const STANDUP_ENTRY_DDL = [
  "CREATE TABLE standup_entry (",
  "  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,",
  "  author_email text NOT NULL,",
  "  entry_date date NOT NULL,",
  "  today text NOT NULL,",
  "  blockers text NOT NULL DEFAULT '',",
  "  CONSTRAINT standup_entry_author_email_entry_date_key UNIQUE (author_email, entry_date)",
  ");",
].join("\n");

interface Ran { readonly out: string; readonly status: number }

function run(argv: readonly string[], timeoutMs = 180_000): Ran {
  try {
    return {
      out: execFileSync("docker", [...argv], {
        encoding: "utf8", shell: false, timeout: timeoutMs, windowsHide: true,
      }),
      status: 0,
    };
  } catch (error) {
    const shaped = error as { status?: number; stderr?: string; stdout?: string };
    return {
      out: `${String(shaped.stdout ?? "")}${String(shaped.stderr ?? "")}`,
      status: shaped.status ?? -1,
    };
  }
}

const psql = (container: string, sql: string, extra: readonly string[] = []): Ran =>
  run(["exec", container, "psql", "--username", DATABASE_USER, "--dbname", DATABASE,
    "--no-psqlrc", "--set", "ON_ERROR_STOP=1", ...extra, "--command", sql]);

export interface LiveMigrationOutcome {
  /** Every docker/psql invocation's own words, in order, so a reader can re-run the sequence. */
  readonly log: readonly string[];
  readonly ok: boolean;
  /** The receipt as the PRODUCTION writer persisted it, read back from the store. */
  readonly receipt: MigrationReceipt | null;
  /** What the database itself says the constraint is called, asked after the migration. */
  readonly constraintFromDatabase: string;
  readonly serverVersion: string;
}

/**
 * Starts PostgreSQL, dumps it, migrates it, asks it what it now holds, and records the receipt.
 *
 * THE CONSTRAINT IS READ BACK FROM `pg_constraint`, not from the DDL this file just sent. The
 * criterion the product verified asserts a constraint NAME, and the only authority on what a
 * database calls its constraint is the database.
 */
export function applyLiveMigration(options: {
  readonly containerName: string;
  readonly environment: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly sha: string;
  readonly storePath: string;
  readonly workspace: string;
}): LiveMigrationOutcome {
  const log: string[] = [];
  const note = (label: string, ran: Ran): Ran => {
    log.push(`${label} -> status ${String(ran.status)} :: ${ran.out.trim().slice(0, 400)}`);
    return ran;
  };
  const started = note("docker run postgres", run(["run", "--detach", "--name", options.containerName,
    "--env", `POSTGRES_PASSWORD=${PASSWORD}`, "--env", `POSTGRES_DB=${DATABASE}`, POSTGRES_IMAGE]));
  if (started.status !== 0) {
    return { constraintFromDatabase: "", log, ok: false, receipt: null, serverVersion: "" };
  }
  let ready = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS && !ready; attempt += 1) {
    const probe = run(["exec", options.containerName, "pg_isready", "--username", DATABASE_USER,
      "--dbname", DATABASE], 20_000);
    ready = probe.status === 0;
    if (!ready) sleepSync(1_000);
  }
  log.push(`pg_isready -> ${ready ? "READY" : "NEVER READY"}`);
  if (!ready) return { constraintFromDatabase: "", log, ok: false, receipt: null, serverVersion: "" };

  const version = note("server_version", psql(options.containerName, "SHOW server_version;",
    ["--tuples-only", "--no-align"]));
  // THE DUMP COMES FIRST. A pre-migration backup taken afterwards is not a backup.
  const dumped = note("pg_dump", run(["exec", options.containerName, "pg_dump",
    "--username", DATABASE_USER, "--dbname", DATABASE, "--schema-only"]));
  if (dumped.status !== 0) {
    return { constraintFromDatabase: "", log, ok: false, receipt: null, serverVersion: "" };
  }
  const directory = join(options.workspace, BACKUP_DIRECTORY, BACKUP_LEAF,
    PRE_MIGRATION_BACKUP_LEAF, options.environment);
  mkdirSync(directory, { recursive: true });
  const backupPath = join(directory, BACKUP_LEAF_FILE);
  writeFileSync(backupPath, dumped.out, "utf8");
  const digest = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  log.push(`backup ${backupPath} sha256 ${digest} bytes ${String(dumped.out.length)}`);

  const applied = note("apply migration", psql(options.containerName, STANDUP_ENTRY_DDL));
  const constraint = note("read pg_constraint", psql(options.containerName,
    "SELECT conname FROM pg_constraint WHERE conrelid = 'standup_entry'::regclass AND contype = 'u';",
    ["--tuples-only", "--no-align"]));

  const receipt: MigrationReceipt = {
    applied: applied.status === 0 ? [MIGRATION_FILE] : [],
    backupRef: `${backupPath}@sha256:${digest}`,
    decidedAt: new Date().toISOString(),
    environment: options.environment,
    outcome: applied.status === 0 ? "APPLIED" : "REFUSED",
    projectId: options.projectId,
    receiptId: migrationReceiptId(options.projectId, options.requestId),
    refusal: applied.status === 0
      ? null
      : migrationRefusal("MIGRATION_FAILED", applied.out.trim().slice(0, 400) || "psql refused"),
    requestId: options.requestId,
    sha: options.sha,
    version: MIGRATION_RECEIPT_VERSION,
  };
  const store = SqliteEventStore.openForProject(options.storePath, options.projectId);
  let persisted: MigrationReceipt | null = null;
  try { persisted = recordMigrationReceipt(store, receipt); } finally { store.close(); }
  return {
    constraintFromDatabase: constraint.out.trim(),
    log,
    ok: applied.status === 0 && persisted !== null,
    receipt: persisted,
    serverVersion: version.out.trim(),
  };
}

/** Removes the database container this proof started, by NAME. */
export function removeMigrationDatabase(containerName: string): void {
  run(["rm", "--force", containerName], 60_000);
}
