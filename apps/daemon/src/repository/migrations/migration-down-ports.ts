import { spawn } from "node:child_process";
import { nodeBackupPorts } from "../../backups/backup-ports.js";
import { createVerifierProcessRunner } from "../../orchestrator/verifier-process-runner.js";
import { migrationFilename } from "./migration-receipt.js";

/**
 * The REVERT half of the migration engine, separate from `migration-ports.ts` because that
 * module's `MigrationPorts` is the forward contract and every existing fake implements exactly
 * `{ dump, apply }`. Widening it would red those fakes for a capability they do not provide.
 */
export interface MigrationDownPorts {
  /** The pre-REVERT dump. A revert destroys the data the forward migration created, so it backs
   *  up first for exactly the reason the forward path does -- and the receipt refuses to record a
   *  REVERTED outcome without a `backupRef`, so this cannot be skipped and still look successful. */
  dump(connection: string, path: string): Promise<void>;
  /** Reverts `batch` (oldest first, WITH extension) and answers what it actually reverted. */
  revert(workspace: string, connection: string, batch: readonly string[]): Promise<readonly string[]>;
}

/** The refusal the child emits when the named batch is not the tail of `pgmigrations`. */
export const MIGRATION_DOWN_NOT_LAST = "NOT_LAST_BATCH" as const;
/** Anything else: a broken `down()`, an unreachable database, an unparseable child result. */
export const MIGRATION_DOWN_FAILED_CODE = "REVERT_FAILED" as const;

/** Carries WHICH failure, because NOT_LAST_BATCH and a broken `down()` are different incidents
 *  and the receipt has to say which one happened. The forward path's execution error cannot: it
 *  runs its payload through `migrationFilename` and would rewrite a code to an unknown file. */
export class MigrationDownError extends Error {
  readonly code: typeof MIGRATION_DOWN_NOT_LAST | typeof MIGRATION_DOWN_FAILED_CODE;
  constructor(code: unknown) {
    super("MIGRATION_DOWN_FAILED@DAEMON_INGRESS");
    this.code = code === MIGRATION_DOWN_NOT_LAST ? MIGRATION_DOWN_NOT_LAST : MIGRATION_DOWN_FAILED_CODE;
  }
}

/**
 * Executes the GENERATED PRODUCT's installed `node-pg-migrate`, in its workspace, never a
 * daemon dependency. Two properties matter and neither is incidental:
 *
 * 1. THE LAST-BATCH GUARD RUNS BEFORE ANYTHING IS REVERTED. `node-pg-migrate down N` always
 *    unwinds the N most recent rows, so a caller naming an OLDER batch would silently destroy a
 *    NEWER one. The child reads `pgmigrations` first and refuses if the tail is not the batch it
 *    was told to undo — before the runner is constructed, so a mismatch changes nothing.
 * 2. NOTHING DERIVED FROM THE CONNECTION STRING IS EVER EMITTED. The child writes only migration
 *    FILENAMES (each re-validated against the same strict pattern the forward path uses) and a
 *    fixed code. An error's own message is never printed: imported migration code may itself
 *    hold values, and the URL carries a password.
 *
 * The batch is INLINED as a JSON literal rather than passed through the environment: the runner
 * merges a delivered-variable allowlist, and a name that failed to survive it would turn a
 * guarded revert into an unguarded one. Every name is `migrationFilename`-validated first.
 */
const revertScript = (batch: readonly string[]): string => String.raw`
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { basename, join } from 'node:path';
const batch = ${JSON.stringify([...batch])};
const bare = name => name.slice(0, name.lastIndexOf('.'));
const emit = value => process.stdout.write('\nMOE_MIGRATION_DOWN_RESULT=' + JSON.stringify(value) + '\n');
const logger = { debug() {}, error() {}, info() {}, warn(message) {
  // Refuse the library's transaction escape BEFORE it emits COMMIT outside the batch, exactly
  // as the forward path does: a half-reverted schema is the outcome this whole row exists to
  // prevent.
  if (String(message).includes('break single transaction')) throw new Error('TRANSACTION_REQUIRED');
} };
try {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let tail;
  try {
    tail = (await client.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT $1', [batch.length])).rows.map(row => row.name);
  } finally { await client.end(); }
  const want = [...batch].reverse().map(bare);
  if (tail.length !== want.length || want.some((name, index) => tail[index] !== name)) {
    emit({ reverted: [], code: '${MIGRATION_DOWN_NOT_LAST}' }); process.exitCode = 1;
  } else {
    const undone = await runner({ databaseUrl: process.env.DATABASE_URL, dir: join(process.cwd(), 'migrations'),
      migrationsTable: 'pgmigrations', direction: 'down', count: batch.length, singleTransaction: true, checkOrder: true, logger });
    emit({ reverted: undone.map(item => basename(item.path)), code: null });
  }
} catch {
  emit({ reverted: [], code: '${MIGRATION_DOWN_FAILED_CODE}' }); process.exitCode = 1;
}
`;

async function revert(
  workspace: string, connection: string, batch: readonly string[],
): Promise<readonly string[]> {
  if (batch.length === 0 || !batch.every(migrationFilename)) throw new MigrationDownError(null);
  const script = revertScript(batch);
  const runner = createVerifierProcessRunner({ timeoutMs: 120_000, delivered: { DATABASE_URL: connection },
    spawn: (file, args, options) => options.shell === true
      ? spawn(process.execPath, ["--input-type=module", "--eval", script], { ...options, shell: false, windowsHide: true })
      : spawn(file, [...args], options),
  });
  try {
    const result = await runner({ workspace, test: "migration-engine", instructions: "migrate down", title: "migrate down" });
    const line = result.output.split(/\r?\n/u)
      .filter(value => value.startsWith("MOE_MIGRATION_DOWN_RESULT=")).at(-1);
    const decoded: unknown = JSON.parse(line?.slice("MOE_MIGRATION_DOWN_RESULT=".length) ?? "null");
    if (typeof decoded !== "object" || decoded === null) throw new MigrationDownError(null);
    const value = decoded as Record<string, unknown>;
    // The child's own code is carried through so the receipt records WHY it refused rather than
    // a generic failure: NOT_LAST_BATCH and a broken down() are different incidents.
    if (result.exitCode !== 0) throw new MigrationDownError(value.code);
    if (!Array.isArray(value.reverted) || !value.reverted.every(migrationFilename)
      || value.reverted.length !== batch.length) throw new MigrationDownError(null);
    return Object.freeze([...value.reverted] as string[]);
  } catch (error) { throw error instanceof MigrationDownError ? error : new MigrationDownError(null); }
  finally { await runner.close(); }
}

export function nodeMigrationDownPorts(): MigrationDownPorts {
  return Object.freeze({ dump: nodeBackupPorts().database, revert });
}
