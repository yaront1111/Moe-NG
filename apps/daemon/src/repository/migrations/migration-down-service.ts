import { existsSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SqliteEventStore } from "@moe/store";
import { backupFileHash } from "../../backups/backup-ports.js";
import { MIGRATION_DOWN_NOT_LAST, MigrationDownError, nodeMigrationDownPorts,
  type MigrationDownPorts } from "./migration-down-ports.js";
import { MIGRATION_RECEIPT_VERSION, migrationError, migrationReceiptId, migrationRefusal,
  decodeMigrationReceiptBytes, readMigrationReceipt, recordMigrationReceipt, type MigrationReceipt } from "./migration-receipt.js";
import { MIGRATION_LOCK_LEAF, migrationBackupDirectory } from "./migration-service.js";

/**
 * `deployment.migrate_down`'s effect: undo the LAST BATCH and record that it happened.
 *
 * THE BATCH IS NAMED BY THE RECEIPT THAT CREATED IT, never by a count. `node-pg-migrate down N`
 * unwinds the N most recent rows whatever they are, so a command carrying a number could
 * silently destroy a batch nobody meant to touch. Naming the APPLIED receipt makes the request
 * say which change is being undone, and the port re-checks against `pgmigrations` before
 * reverting anything, so a receipt that is no longer the tail refuses with the schema untouched.
 *
 * IT BACKS UP FIRST, into the same pre-migration directory and under the same project-wide lock
 * the forward path uses. A revert destroys data, so the dump is what makes it recoverable; and
 * an up interleaving with a down on one database is the half-applied schema the lock exists to
 * prevent, which is why the leaf is imported rather than restated.
 */
export interface MigrationDownInput {
  readonly projectRoot: string;
  readonly workspace: string;
  readonly projectId: string;
  /** THIS command's id: the revert's own receipt is keyed by it, so a retry replays. */
  readonly requestId: string;
  readonly environment: string;
  /** The `requestId` of the APPLIED receipt whose batch is being undone. */
  readonly toMigrationRequestId: string;
  readonly databaseUrl: string;
  readonly now?: Date;
}

type DownCode = "MIGRATION_DOWN_BATCH_UNKNOWN" | "MIGRATION_DOWN_NOT_LAST_BATCH"
  | "MIGRATION_DOWN_FAILED";

/** The shape every answer shares. `sha` is the SOURCE receipt's: a revert is about the schema
 *  that sha's migrations created, so minting a second one would leave the pair unlinkable. */
function baseReceipt(input: MigrationDownInput, sha: string): MigrationReceipt {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())
    || typeof input.toMigrationRequestId !== "string" || input.toMigrationRequestId.length === 0
    || input.toMigrationRequestId.length > 4096) {
    throw migrationError("MIGRATION_RECEIPT_INVALID");
  }
  const value: MigrationReceipt = { version: MIGRATION_RECEIPT_VERSION, projectId: input.projectId, requestId: input.requestId,
    receiptId: migrationReceiptId(input.projectId, input.requestId), environment: input.environment,
    sha, decidedAt: now.toISOString(), applied: [], backupRef: null,
    outcome: "REFUSED", refusal: migrationRefusal("MIGRATION_DOWN_BATCH_UNKNOWN", "no applied batch") };
  const decoded = decodeMigrationReceiptBytes(new TextEncoder().encode(JSON.stringify(value)));
  if (!decoded.ok) throw migrationError("MIGRATION_RECEIPT_INVALID");
  return decoded.receipt;
}

const refused = (base: MigrationReceipt, code: DownCode, detail: string): MigrationReceipt =>
  ({ ...base, applied: [], backupRef: null, outcome: "REFUSED", refusal: migrationRefusal(code, detail) });

/** The batch this request may undo, or null. FAIL CLOSED: an absent receipt, a refused one,
 *  another environment's, or one that reverted nothing are all "no". */
function batchOf(store: SqliteEventStore, input: MigrationDownInput): MigrationReceipt | null {
  const source = readMigrationReceipt(store, input.projectId, input.toMigrationRequestId);
  if (source === null || source.outcome !== "APPLIED" || source.environment !== input.environment
    || source.applied.length === 0) return null;
  return source;
}

async function execute(
  input: MigrationDownInput, ports: MigrationDownPorts, base: MigrationReceipt,
  batch: readonly string[], directory: string,
): Promise<MigrationReceipt> {
  let path: string | null = null;
  let ownsFile = false;
  let backupRef: string | null = null;
  try {
    const stamp = base.decidedAt.replaceAll(/\D/gu, "");
    path = join(directory, `${stamp}.sql`);
    if (!/^\d{17}$/u.test(stamp) || existsSync(path)) throw migrationError("MIGRATION_BACKUP_FAILED");
    ownsFile = true;
    await ports.dump(input.databaseUrl, path);
    backupRef = `${path}@sha256:${await backupFileHash(path)}`;
    const applied = await ports.revert(input.workspace, input.databaseUrl, batch);
    if (applied.length !== batch.length || applied.some((name, index) => name !== batch[batch.length - 1 - index])) {
      throw new MigrationDownError(null);
    }
    return { ...base, applied, backupRef, outcome: "REVERTED", refusal: null };
  } catch (error) {
    // THE NAMED BATCH WAS NOT THE TAIL is reported under its own code with the schema untouched:
    // the port checks before it reverts. Everything else is MIGRATION_DOWN_FAILED, and the dump
    // taken above is the recovery path for the one case where a down() failed part way.
    const code: DownCode = error instanceof MigrationDownError && error.code === MIGRATION_DOWN_NOT_LAST
      ? "MIGRATION_DOWN_NOT_LAST_BATCH" : "MIGRATION_DOWN_FAILED";
    if (backupRef === null && ownsFile && path !== null) {
      try { rmSync(path, { force: true }); } catch { throw migrationError("MIGRATION_BACKUP_FAILED"); }
    }
    return { ...refused(base, code, code), backupRef };
  }
}

/** Effect entry point, not authority: the command edge composes this callable. */
export async function revertLastBatch(
  store: SqliteEventStore, input: MigrationDownInput,
  ports: MigrationDownPorts = nodeMigrationDownPorts(),
): Promise<MigrationReceipt> {
  baseReceipt(input, "0".repeat(40)); // Validate identity before reading receipts or performing effects.
  const replayed = readMigrationReceipt(store, input.projectId, input.requestId);
  if (replayed !== null) {
    if (replayed.environment !== input.environment || replayed.outcome === "APPLIED") {
      throw migrationError("MIGRATION_RECEIPT_CONFLICT");
    }
    if (replayed.outcome === "REVERTED") {
      const source = batchOf(store, input);
      if (source === null || source.sha !== replayed.sha
        || JSON.stringify([...source.applied].reverse()) !== JSON.stringify(replayed.applied)) {
        throw migrationError("MIGRATION_RECEIPT_CONFLICT");
      }
    }
    return replayed;
  }
  const source = batchOf(store, input);
  if (source === null) {
    // No source receipt means no sha to carry, so the refusal takes a syntactically valid
    // placeholder the decoder accepts. The CODE is what says nothing was reverted, and the
    // detail names the receipt that could not be undone.
    return recordMigrationReceipt(store, refused(baseReceipt(input, "0".repeat(40)),
      "MIGRATION_DOWN_BATCH_UNKNOWN", input.toMigrationRequestId));
  }
  const base = baseReceipt(input, source.sha);
  let directory: string;
  try { directory = migrationBackupDirectory(input); }
  catch { return recordMigrationReceipt(store, refused(base, "MIGRATION_DOWN_FAILED", "backup directory")); }
  // The SAME project-wide lock the forward path takes, spanning the receipt write: a second
  // revert arriving mid-flight is refused MIGRATION_IN_PROGRESS rather than racing this one
  // into a schema that is half of each.
  const lock = join(dirname(directory), MIGRATION_LOCK_LEAF);
  try { mkdirSync(lock); }
  catch { throw migrationError(existsSync(lock) ? "MIGRATION_IN_PROGRESS" : "MIGRATION_BACKUP_FAILED"); }
  try { return recordMigrationReceipt(store, await execute(input, ports, base, source.applied, directory)); }
  finally {
    try { rmdirSync(lock); } catch { throw migrationError("MIGRATION_RECEIPT_WRITE_FAILED"); }
  }
}
