import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SqliteEventStore } from "@moe/store";
import { BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF } from "../../bootstrap/activation-receipts-measure.js";
import { backupFileHash } from "../../backups/backup-ports.js";
import { MigrationExecutionError, nodeMigrationPorts, type MigrationPorts } from "./migration-ports.js";
import { MIGRATION_RECEIPT_VERSION, migrationError, migrationReceiptId, migrationRefusal,
  decodeMigrationReceiptBytes, readMigrationReceipt, recordMigrationReceipt, type MigrationReceipt } from "./migration-receipt.js";

export interface MigrationInput {
  readonly projectRoot: string;
  readonly workspace: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly environment: string;
  readonly sha: string;
  readonly databaseUrl: string;
  readonly now?: Date;
}
/** The ONE project-wide migration lock leaf. Exported so the revert takes the SAME lock the
 *  forward path does: an up and a down interleaving on one database is the half-applied schema
 *  every guard here exists to prevent, and two leaf names would be two locks. */
export const MIGRATION_LOCK_LEAF = ".migration.lock";

/** The pre-migration backup directory for an environment, created 0700 and refused if anything
 *  on the path is a symlink or not a directory. Exported for the revert, which backs up before
 *  it destroys: a second derivation of this path would be a second place for the rule to live. */
export function migrationBackupDirectory(input: Pick<MigrationInput, "projectRoot" | "environment">): string {
  let directory = realpathSync(input.projectRoot);
  for (const part of [BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF, input.environment]) {
    directory = join(directory, part);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw migrationError("MIGRATION_BACKUP_FAILED");
  }
  return directory;
}
function baseReceipt(input: MigrationInput): MigrationReceipt {
  const now = input.now ?? new Date();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(input.environment)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.sha)
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw migrationError("MIGRATION_RECEIPT_INVALID");
  const value: MigrationReceipt = { version: MIGRATION_RECEIPT_VERSION, projectId: input.projectId, requestId: input.requestId,
    receiptId: migrationReceiptId(input.projectId, input.requestId), environment: input.environment,
    sha: input.sha, decidedAt: now.toISOString(), applied: [], backupRef: null,
    outcome: "REFUSED", refusal: migrationRefusal("MIGRATION_BACKUP_FAILED", "backup failed") };
  const decoded = decodeMigrationReceiptBytes(new TextEncoder().encode(JSON.stringify(value)));
  if (!decoded.ok) throw migrationError("MIGRATION_RECEIPT_INVALID");
  return decoded.receipt;
}

async function execute(
  input: MigrationInput, ports: MigrationPorts, base: MigrationReceipt, directory: string,
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
    const applied = await ports.apply(input.workspace, input.databaseUrl);
    return { ...base, applied, backupRef, outcome: "APPLIED", refusal: null };
  } catch (error) {
    if (backupRef !== null) return { ...base, backupRef,
      refusal: migrationRefusal("MIGRATION_FAILED", error instanceof MigrationExecutionError ? error.file : "MIGRATION_FILE_UNKNOWN") };
    if (ownsFile && path !== null) {
      try { rmSync(path, { force: true }); } catch { throw migrationError("MIGRATION_BACKUP_FAILED"); }
    }
    return base;
  }
}

/** Effect entry point, not authority: the deploy decision owner composes this callable. */
export async function migrateWithBackup(
  store: SqliteEventStore, input: MigrationInput, ports: MigrationPorts = nodeMigrationPorts(),
): Promise<MigrationReceipt> {
  const base = baseReceipt(input);
  const existing = readMigrationReceipt(store, input.projectId, input.requestId);
  if (existing !== null) {
    if (existing.environment !== input.environment || existing.sha !== input.sha) throw migrationError("MIGRATION_RECEIPT_CONFLICT");
    return existing;
  }
  let directory: string;
  try { directory = migrationBackupDirectory(input); }
  catch { return recordMigrationReceipt(store, base); }
  // Project-wide lock spans the RECEIPT write too; a concurrent refusal must not win its id.
  const lock = join(dirname(directory), MIGRATION_LOCK_LEAF);
  try { mkdirSync(lock); }
  catch { throw migrationError(existsSync(lock) ? "MIGRATION_IN_PROGRESS" : "MIGRATION_BACKUP_FAILED"); }
  try { return recordMigrationReceipt(store, await execute(input, ports, base, directory)); }
  finally {
    try { rmdirSync(lock); } catch { throw migrationError("MIGRATION_RECEIPT_WRITE_FAILED"); }
  }
}
