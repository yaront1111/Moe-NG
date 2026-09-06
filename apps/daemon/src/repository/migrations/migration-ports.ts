import { spawn } from "node:child_process";
import { nodeBackupPorts } from "../../backups/backup-ports.js";
import { createVerifierProcessRunner } from "../../orchestrator/verifier-process-runner.js";
import { migrationFilename } from "./migration-receipt.js";

export interface MigrationPorts {
  dump(connection: string, path: string): Promise<void>;
  apply(workspace: string, connection: string): Promise<readonly string[]>;
}
export class MigrationExecutionError extends Error {
  readonly file: string;
  constructor(file: string | null) {
    super("MIGRATION_FAILED@DAEMON_INGRESS");
    this.file = migrationFilename(file) ? file : "MIGRATION_FILE_UNKNOWN";
  }
}

// Execute the generated product's installed migration tool, not another daemon dependency.
// Child output is captured, never logged: imported migration code may itself print values.
const MIGRATE = String.raw`
import { runner } from 'node-pg-migrate';
import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
let last = null;
const files = readdirSync('migrations');
const secret = new URL(process.env.DATABASE_URL);
const denied = [process.env.DATABASE_URL, decodeURIComponent(secret.password)].filter(Boolean);
const safe = value => typeof value === 'string' && /^\d{13,17}[-_][A-Za-z0-9_-]+\.(?:js|cjs|mjs|sql)$/.test(value)
  && files.includes(value) && !denied.some(part => value.includes(part));
const emit = value => process.stdout.write('\nMOE_MIGRATION_RESULT=' + JSON.stringify(value) + '\n');
const logger = { debug() {}, error() {}, info(message) {
  const match = /^### MIGRATION (.+) \(UP\) ###$/.exec(String(message));
  if (match) last = files.find(file => file.slice(0, file.lastIndexOf('.')) === match[1]) ?? null;
}, warn(message) {
  // Refuse the library's transaction escape BEFORE it emits COMMIT outside the batch.
  if (String(message).includes('break single transaction')) throw new Error('TRANSACTION_REQUIRED');
} };
try {
  const applied = await runner({ databaseUrl: process.env.DATABASE_URL, dir: join(process.cwd(), 'migrations'),
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
`;

async function apply(workspace: string, connection: string): Promise<readonly string[]> {
  const runner = createVerifierProcessRunner({ timeoutMs: 120_000, delivered: { DATABASE_URL: connection },
    spawn: (file, args, options) => options.shell === true
      ? spawn(process.execPath, ["--input-type=module", "--eval", MIGRATE], { ...options, shell: false, windowsHide: true })
      : spawn(file, [...args], options),
  });
  try {
    const result = await runner({ workspace, test: "migration-engine", instructions: "migrate", title: "migrate" });
    const line = result.output.split(/\r?\n/u).filter(value => value.startsWith("MOE_MIGRATION_RESULT=")).at(-1);
    const decoded: unknown = JSON.parse(line?.slice("MOE_MIGRATION_RESULT=".length) ?? "null");
    if (typeof decoded !== "object" || decoded === null) throw new MigrationExecutionError(null);
    const value = decoded as Record<string, unknown>;
    if (result.exitCode !== 0) throw new MigrationExecutionError(typeof value.file === "string" ? value.file : null);
    if (!Array.isArray(value.applied) || !value.applied.every(migrationFilename)) throw new MigrationExecutionError(null);
    return Object.freeze([...value.applied]);
  } catch (error) { throw error instanceof MigrationExecutionError ? error : new MigrationExecutionError(null); }
  finally { await runner.close(); }
}

export function nodeMigrationPorts(): MigrationPorts {
  return Object.freeze({ dump: nodeBackupPorts().database, apply });
}
