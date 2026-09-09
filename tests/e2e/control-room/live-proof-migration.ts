/**
 * THE MIGRATION RECEIPT on the fresh product -- WRITTEN BY THE PRODUCT, READ BACK HERE.
 *
 * WHAT CHANGED AND WHY, because the earlier version of this file APPLIED the migration itself.
 * MEASURED 2026-09-09: `deployment.deploy` runs the product's own migration inside the deploy
 * (`deploy-command.ts:273`), takes the `DATABASE_URL` from the environment slice, dumps a
 * pre-migration backup, applies `migrations/` AT THE DEPLOYED SHA through the product's own
 * `node-pg-migrate`, and records the receipt keyed by the deploy DECISION. A lane that recorded
 * its own receipt for that same decision hit `MIGRATION_RECEIPT_CONFLICT@DAEMON_INGRESS` -- the
 * product had already written one. So the receipt DoD 1 asks for is the product's, and this file
 * reads it and then asks PostgreSQL whether the schema really moved.
 *
 * TWO INDEPENDENT READS, and that is the point. The RECEIPT is what the daemon believes: the
 * files it applied, the backup it took, its outcome. `pg_constraint` is what the DATABASE says
 * happened. A receipt claiming APPLIED against a database with no such constraint fails here,
 * and a constraint present with no receipt fails too.
 *
 * `psql` IS NOT ON THIS HOST'S PATH (measured 2026-09-09) and is not needed: every statement runs
 * through `docker exec` inside the postgres container the environment brought up.
 */
import { execFileSync } from "node:child_process";

import { SqliteEventStore } from "@moe/store";

import { readMigrationReceipt }
  from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";
import type { MigrationReceipt }
  from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";

const DATABASE = "standup";
const DATABASE_USER = "postgres";

/** The constraint the approved criterion A5 names by its exact database identifier. */
export const UNIQUE_CONSTRAINT = "standup_entry_author_email_entry_date_key";

interface Ran { readonly out: string; readonly status: number }

function run(argv: readonly string[], timeoutMs = 120_000): Ran {
  try {
    return {
      out: execFileSync("docker", [...argv],
        { encoding: "utf8", shell: false, timeout: timeoutMs, windowsHide: true }).trim(),
      status: 0,
    };
  } catch (error) {
    const shaped = error as { status?: number; stderr?: string; stdout?: string };
    return {
      out: `${String(shaped.stdout ?? "")}${String(shaped.stderr ?? "")}`.trim().slice(-400),
      status: shaped.status ?? -1,
    };
  }
}

const psql = (container: string, sql: string, extra: readonly string[] = []): Ran =>
  run(["exec", container, "psql", "--username", DATABASE_USER, "--dbname", DATABASE,
    ...extra, "--command", sql]);

export interface LiveMigrationOutcome {
  /** The constraint name PostgreSQL itself reports, asked of `pg_constraint`. */
  readonly constraintFromDatabase: string;
  /** Every statement run, with its status, so the reading can be re-run. */
  readonly log: readonly string[];
  readonly ok: boolean;
  /** The receipt the PRODUCT recorded for this deploy decision. */
  readonly receipt: MigrationReceipt | null;
  readonly serverVersion: string;
}

/**
 * Reads the product's migration receipt for one deploy decision and asks the database what ran.
 *
 * `requestId` is the DEPLOY DECISION id: `migrateWithBackup` keys the receipt by it, so a receipt
 * read under any other id would be a different migration -- or none.
 */
export function readProductMigration(options: {
  readonly database: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly storePath: string;
}): LiveMigrationOutcome {
  const log: string[] = [];
  const note = (label: string, ran: Ran): Ran => {
    log.push(`${label} -> status ${String(ran.status)} :: ${ran.out.trim().slice(0, 300)}`);
    return ran;
  };
  const store = SqliteEventStore.openForProject(options.storePath, options.projectId);
  let receipt: MigrationReceipt | null = null;
  let failure = "";
  try { receipt = readMigrationReceipt(store, options.projectId, options.requestId); }
  catch (error) { failure = String(error).slice(0, 300); }
  finally { store.close(); }
  log.push(`readMigrationReceipt(${options.requestId}) -> ${receipt === null ? `none ${failure}` : receipt.outcome}`);

  const version = note("server_version", psql(options.database, "SHOW server_version;",
    ["--tuples-only", "--no-align"]));
  const constraint = note("read pg_constraint", psql(options.database,
    "SELECT conname FROM pg_constraint WHERE conrelid = 'standup_entry'::regclass AND contype = 'u';",
    ["--tuples-only", "--no-align"]));
  // THE TOOL'S OWN LEDGER, asked as a third witness: `node-pg-migrate` records what it ran in
  // `pgmigrations`, so a receipt naming files the tool never recorded is caught here.
  const ledger = note("read pgmigrations", psql(options.database,
    "SELECT name FROM pgmigrations ORDER BY id;", ["--tuples-only", "--no-align"]));
  return {
    constraintFromDatabase: constraint.out.trim(),
    log: Object.freeze([...log, `pgmigrations: ${ledger.out.replace(/\s+/gu, ",")}`]),
    ok: receipt !== null && receipt.outcome === "APPLIED"
      && constraint.out.trim() === UNIQUE_CONSTRAINT,
    receipt,
    serverVersion: version.out.trim(),
  };
}

/** Removes a database container by NAME, for a caller that started one outside compose. */
export function removeMigrationDatabase(containerName: string): void {
  run(["rm", "--force", containerName], 60_000);
}
