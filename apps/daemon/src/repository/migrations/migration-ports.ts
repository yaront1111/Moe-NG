import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIRECTORY } from "../../bootstrap/activation-receipts-measure.js";
import { nodeBackupPorts } from "../../backups/backup-ports.js";
import { createVerifierProcessRunner } from "../../orchestrator/verifier-process-runner.js";
import { extractCommittedPath } from "../git-source-extract.js";
import { nodeGitRunner } from "../git-landing-port.js";
import { migrationFilename } from "./migration-receipt.js";

export interface MigrationPorts {
  dump(connection: string, path: string): Promise<void>;
  /** `sha` is the commit whose `migrations/` actually runs, and it is REQUIRED: the image is built
   *  from that commit, so a schema change read from anywhere else can be one the image does not
   *  carry. It is not an option a caller can decline into a working-tree read. */
  apply(workspace: string, connection: string, sha: string): Promise<readonly string[]>;
}
/** The extracted source lives BESIDE the pre-migration backups, under the product's own
 *  `.moe-next/` — gitignored by the generated product and excluded from every landing. It cannot
 *  live in `os.tmpdir()`: Node resolves a migration's bare specifiers by walking UP from the FILE,
 *  so an out-of-tree extract never reaches the product's `package.json` or `node_modules`. */
const MIGRATION_SOURCE_PREFIX = "migration-source-";
const MIGRATIONS_LEAF = "migrations";
export class MigrationExecutionError extends Error {
  readonly file: string;
  /** TRUE only when the product workspace could not RESOLVE its migration tool — a tree that was
   *  never installed. Kept as its own field rather than a second sentinel in `file`, because a
   *  missing TOOL and an unknown FILE are different answers for the operator. Optional and last,
   *  so every existing positional construction site keeps its meaning untouched. */
  readonly toolMissing: boolean;
  constructor(file: string | null, toolMissing = false) {
    super("MIGRATION_FAILED@DAEMON_INGRESS");
    this.file = migrationFilename(file) ? file : "MIGRATION_FILE_UNKNOWN";
    this.toolMissing = toolMissing;
  }
}

/**
 * Execute the generated product's installed migration tool, not another daemon dependency.
 * Child output is captured, never logged: imported migration code may itself print values.
 *
 * `dir` is the directory the migration FILES were extracted into, and it is INLINED as a JSON
 * literal rather than delivered through the environment: `deliverEnvironment` silently drops a
 * delivered name that collides with a runtime key, and a name that failed to survive that filter
 * would turn a pinned read back into a working-tree read. The revert script inlines its batch for
 * the same reason.
 *
 * ONLY `migrations/` IS PINNED. A migration that imports a RELATIVE path outside its own directory
 * (`../src/x.js`) now resolves against the extract, which does not contain it, and fails
 * MIGRATION_FAILED naming the importing migration. That is fail-closed and it is a stated
 * behaviour change, not an argument for widening the extract to the whole tree: a whole-tree
 * checkout would put the deployed application's sources under a path the product's own
 * `node_modules` does not sit beside.
 */
const migrateScript = (dir: string): string => String.raw`
import { basename } from 'node:path';
import { readdirSync } from 'node:fs';
const emit = value => process.stdout.write('\nMOE_MIGRATION_RESULT=' + JSON.stringify(value) + '\n');
// The tool belongs to the PRODUCT's workspace, so an uninstalled tree fails HERE, at module
// resolution, before a single migration file is read. RESOLVE the root specifier before importing
// it: a dynamic import raises the same ERR_MODULE_NOT_FOUND when an INSTALLED tool's own
// transitive dependency is missing, and a broken install is not an absent tool. The import itself
// stays outside this branch, so every other import failure keeps the existing catch below.
let missing = false;
try { import.meta.resolve('node-pg-migrate'); } catch { missing = true; }
if (missing) { emit({ applied: [], file: null, toolMissing: true }); process.exitCode = 1; } else {
const { runner } = await import('node-pg-migrate');
let last = null;
const files = readdirSync(${JSON.stringify(dir)});
const secret = new URL(process.env.DATABASE_URL);
const denied = [process.env.DATABASE_URL, decodeURIComponent(secret.password)].filter(Boolean);
const safe = value => typeof value === 'string' && /^\d{13,17}[-_][A-Za-z0-9_-]+\.(?:js|cjs|mjs|sql)$/.test(value)
  && files.includes(value) && !denied.some(part => value.includes(part));
const logger = { debug() {}, error() {}, info(message) {
  const match = /^### MIGRATION (.+) \(UP\) ###$/.exec(String(message));
  if (match) last = files.find(file => file.slice(0, file.lastIndexOf('.')) === match[1]) ?? null;
}, warn(message) {
  // Refuse the library's transaction escape BEFORE it emits COMMIT outside the batch.
  if (String(message).includes('break single transaction')) throw new Error('TRANSACTION_REQUIRED');
} };
try {
  const applied = await runner({ databaseUrl: process.env.DATABASE_URL, dir: ${JSON.stringify(dir)},
    migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true, logger });
  const names = applied.map(item => basename(item.path));
  if (!names.every(safe)) throw new Error('MIGRATION_RESULT_INVALID');
  emit({ applied: names, file: null });
} catch (error) {
  let current = error;
  for (let i = 0; current && i < 8; i++, current = current.cause) {
    const frame = /[/\\]migrations[/\\]([\w.-]+):\d+:\d+/.exec(String(current.stack));
    if (frame && safe(frame[1])) { last = frame[1]; break; }
  }
  emit({ applied: [], file: safe(last) ? last : null }); process.exitCode = 1;
}
}
`;

/** Best-effort removal of extracts a SIGKILLed daemon could not tear down. Safe to run here
 *  because both callers hold the project-wide `.migration.lock`, so no live extract is a sibling.
 *  A directory that refuses to go is left alone: a stale extract is litter, not a failure. */
function sweepStaleSources(metadata: string): void {
  try {
    for (const entry of readdirSync(metadata)) {
      if (!entry.startsWith(MIGRATION_SOURCE_PREFIX)) continue;
      try { rmSync(join(metadata, entry), { recursive: true, force: true }); } catch { /* litter, not a failure */ }
    }
  } catch { /* no metadata directory yet */ }
}

/**
 * Extract `migrations/` at `sha` into a scratch directory under the workspace's own `.moe-next`,
 * hand that directory to `run`, and remove it afterwards on EVERY exit path.
 *
 * Shared with the revert rather than copied into it: the teardown ordering (after the child is
 * closed), the swallowed teardown error and the stale-sibling sweep are one rule, and two copies
 * of a rule about not leaving things behind is how one of them stops being true.
 *
 * `ok: false` means the SOURCE could not be produced. An error thrown by `run` is the migration's
 * own answer and propagates untouched — the extract is still removed on the way out.
 */
export async function withMigrationSource<T>(
  workspace: string, sha: string, run: (dir: string) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  let source: string;
  try {
    const metadata = join(workspace, BACKUP_DIRECTORY);
    sweepStaleSources(metadata);
    mkdirSync(metadata, { recursive: true });
    source = mkdtempSync(join(metadata, MIGRATION_SOURCE_PREFIX));
  } catch { return { ok: false }; }
  try {
    const extracted = await extractCommittedPath(nodeGitRunner,
      { repository: workspace, sha, path: MIGRATIONS_LEAF, destination: source });
    if (extracted !== "OK") return { ok: false };
    return { ok: true, value: await run(join(source, MIGRATIONS_LEAF)) };
  } finally {
    // AFTER the child is closed: on win32 removing a directory the child still holds is EBUSY.
    // Swallowed, because a teardown failure must never replace the migration's own answer.
    try { rmSync(source, { recursive: true, force: true }); } catch { /* teardown never masks the result */ }
  }
}

async function apply(workspace: string, connection: string, sha: string): Promise<readonly string[]> {
  const source = await withMigrationSource(workspace, sha, dir => run(workspace, connection, dir));
  // An unproducible source answers exactly as an unreadable `migrations/` did before:
  // MIGRATION_FAILED with the UNKNOWN file sentinel. No new code is minted, so the receipt's
  // closed code roster and every mirror of it stay as they are.
  if (!source.ok) throw new MigrationExecutionError(null);
  return source.value;
}

async function run(workspace: string, connection: string, dir: string): Promise<readonly string[]> {
  const script = migrateScript(dir);
  const runner = createVerifierProcessRunner({ timeoutMs: 120_000, delivered: { DATABASE_URL: connection },
    spawn: (file, args, options) => options.shell === true
      ? spawn(process.execPath, ["--input-type=module", "--eval", script], { ...options, shell: false, windowsHide: true })
      : spawn(file, [...args], options),
  });
  try {
    const result = await runner({ workspace, test: "migration-engine", instructions: "migrate", title: "migrate" });
    const line = result.output.split(/\r?\n/u).filter(value => value.startsWith("MOE_MIGRATION_RESULT=")).at(-1);
    const decoded: unknown = JSON.parse(line?.slice("MOE_MIGRATION_RESULT=".length) ?? "null");
    if (typeof decoded !== "object" || decoded === null) throw new MigrationExecutionError(null);
    const value = decoded as Record<string, unknown>;
    if (result.exitCode !== 0) throw new MigrationExecutionError(
      typeof value.file === "string" ? value.file : null, value.toolMissing === true);
    if (!Array.isArray(value.applied) || !value.applied.every(migrationFilename)) throw new MigrationExecutionError(null);
    return Object.freeze([...value.applied]);
  } catch (error) { throw error instanceof MigrationExecutionError ? error : new MigrationExecutionError(null); }
  finally { await runner.close(); }
}

export function nodeMigrationPorts(): MigrationPorts {
  return Object.freeze({ dump: nodeBackupPorts().database, apply });
}
