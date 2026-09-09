import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupFailure, nodeActivationReceiptPorts } from "../bootstrap/activation-receipts-measure.js";

export interface BackupProof { readonly sha256: string; readonly restoredSha256: string }
export interface BackupPorts {
  store(source: string, destination: string): Promise<void>;
  database(connection: string, destination: string): Promise<void>;
  restoreStore(path: string): Promise<BackupProof>;
  restoreDatabase(path: string): Promise<BackupProof>;
  /**
   * THE DESTINATION-BOUND RESTORE, and the reason it takes a connection at all.
   *
   * `restoreDatabase(path)` above is a VERIFICATION: it loads the dump into a throwaway
   * `--network none` container, re-dumps it and returns a proof. It writes to no database anyone
   * named, which is exactly right for the scheduled backup's weekly check and exactly wrong for a
   * rollback that has to put a schema back. The dump side already takes a connection
   * (`database(connection, destination)`); the missing counterpart is this one, and that asymmetry
   * is what made `deployment.rollback` refuse every restore outright.
   *
   * ONE ATTEMPT, NO PARTIAL APPLY: a single `psql -v ON_ERROR_STOP=1 --single-transaction`
   * invocation, no retry loop and no recovery pass. `--single-transaction` is what makes "no
   * partial apply" a property of the operation rather than a hope — plain `pg_dump` output is NOT
   * wrapped in a transaction, so without it a statement failing half way leaves a half-restored
   * schema behind. With it, a failure is a failure and the schema is as it was.
   */
  restoreDatabaseInto(connection: string, path: string): Promise<void>;
}
const IMAGE = "postgres:17-alpine";
const DUMP_ARGS = ["--no-owner", "--no-privileges", "--no-comments", "--no-password"];
const fail = (): Error => Object.assign(new Error("BACKUP_FAILED"), backupFailure());
async function sanitized<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw fail(); }
}

/** Stream actual bytes; an empty artifact is not a backup. */
export async function backupFileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  if (size === 0) throw fail();
  return hash.digest("hex");
}

/** No shell, no error/argv logging; PG failures can echo credentials. Files use inherited FDs. */
function docker(
  args: readonly string[], env: NodeJS.ProcessEnv = {}, input?: number, output?: number,
): Buffer {
  try {
    return execFileSync("docker", [...args], { shell: false, windowsHide: true,
      env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 65_536,
      stdio: [input ?? "ignore", output ?? "pipe", "pipe"],
    }) ?? Buffer.alloc(0);
  } catch { throw fail(); }
}

function disposeContainer(name: string): void {
  if (docker(["ps", "-aq", "--filter", `name=^${name}$`]).length === 0) return;
  docker(["rm", "-f", name]);
  if (docker(["ps", "-aq", "--filter", `name=^${name}$`]).length !== 0) throw fail();
}

function pgEnvironment(connection: string, network?: string): NodeJS.ProcessEnv {
  const url = new URL(connection);
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname || url.hash) throw fail();
  for (const key of url.searchParams.keys()) if (key !== "sslmode") throw fail();
  const host = network === undefined && ["localhost", "127.0.0.1"].includes(url.hostname)
    ? "host.docker.internal" : url.hostname;
  return { PGHOST: host, PGPORT: url.port || "5432", PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer", PGCONNECT_TIMEOUT: "10" };
}

function dumpDatabase(connection: string, destination: string, network?: string): void {
  const env = pgEnvironment(connection, network);
  const name = `moe-backup-dump-${randomUUID()}`;
  const output = openSync(destination, "wx", 0o600);
  try {
    docker(["run", "--rm", "--name", name, ...(network ? ["--network", network] : []),
      ...Object.keys(env).flatMap(key => ["--env", key]), IMAGE, "pg_dump", ...DUMP_ARGS], env, undefined, output);
  } finally { try { closeSync(output); } finally { disposeContainer(name); } }
}

async function restoreStore(path: string): Promise<BackupProof> {
  const temporary = mkdtempSync(join(tmpdir(), "moe-backup-restore-"));
  try {
    const destination = join(temporary, "restored.sqlite");
    copyFileSync(path, destination);
    const db = new DatabaseSync(destination, { readOnly: true });
    try {
      const rows = db.prepare("PRAGMA integrity_check").all();
      if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") throw fail();
      db.prepare("SELECT name FROM sqlite_schema").all();
    } finally { db.close(); }
    return Object.freeze({ sha256: await backupFileHash(path), restoredSha256: await backupFileHash(destination) });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// The image initializes using a temporary socket-only server, then restarts it.
// Only TCP on the final server's fixed port proves restoration can safely begin.
async function ready(name: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw fail();
}

/** Reuse the artifact's unpredictable restrict key; never strip psql's restore safety guard. */
function restrictKey(path: string): string {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(8192);
    const size = readSync(fd, prefix, 0, prefix.length, 0);
    const key = /^\\restrict ([A-Za-z0-9]+)$/mu.exec(prefix.subarray(0, size).toString("utf8"))?.[1];
    if (key === undefined) throw fail();
    return key;
  } finally { closeSync(fd); }
}

function restoreAndDump(name: string, source: string, destination: string): void {
  const input = openSync(source, "r");
  try { docker(["exec", "-i", name, "psql", "-X", "-q", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], {}, input); }
  finally { closeSync(input); }
  const output = openSync(destination, "wx", 0o600);
  try { docker(["exec", name, "pg_dump", "-U", "postgres", ...DUMP_ARGS,
    `--restrict-key=${restrictKey(source)}`], {}, undefined, output); }
  finally { closeSync(output); }
}

async function restoreDatabase(path: string): Promise<BackupProof> {
  const name = `moe-backup-restore-${randomUUID()}`;
  const temporary = mkdtempSync(join(tmpdir(), "moe-backup-restore-"));
  try {
    docker(["run", "--rm", "-d", "--name", name, "--network", "none", "--env",
      "POSTGRES_HOST_AUTH_METHOD", IMAGE], { POSTGRES_HOST_AUTH_METHOD: "trust" });
    await ready(name);
    const restored = join(temporary, "restored.sql");
    restoreAndDump(name, path, restored);
    return Object.freeze({ sha256: await backupFileHash(path), restoredSha256: await backupFileHash(restored) });
  } finally {
    try { disposeContainer(name); } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

/**
 * THE DESTINATION IS RESET INSIDE THE SAME TRANSACTION AS THE APPLY, and it has to be.
 *
 * MEASURED, not assumed: `DUMP_ARGS` produces a PLAIN dump with no DROP statements, so piping it
 * at a live database that still holds the objects fails on the first `CREATE TABLE` —
 * `ERROR: relation "app_metadata" already exists`, psql exit 3. A restore that can only ever
 * succeed against an EMPTY destination is not a restore; it is the verification
 * `restoreDatabase(path)` already performs. Adding `--clean` on the DUMP side instead would have
 * changed the artifact `scheduled-backup.ts` verifies, so the reset belongs HERE.
 *
 * `--single-transaction` makes the drop and the apply ONE unit, which is what keeps DoD 3 true:
 * measured against a deliberately failing artifact, psql exits 3 and the destination still holds
 * the objects the drop had removed. There is no window in which the schema is gone and the dump
 * has not landed, and a failure is a failure rather than a half-restored schema.
 *
 * Same env-only credential handling and same container disposal as `dumpDatabase` — the
 * connection is decomposed into PG* variables passed by NAME on the argv (`--env PGPASSWORD`), so
 * the value itself never appears in an argument vector that a crash dump or a process listing
 * could carry. The reset is a FIXED literal with nothing interpolated into it.
 */
/**
 * `client_min_messages` FIRST, and it is not cosmetic. `DROP SCHEMA ... CASCADE` emits one
 * "drop cascades to ..." NOTICE PER OBJECT, and `docker()` runs under `maxBuffer: 65_536`: a
 * production schema with enough objects would overflow the captured stream, kill the child and
 * refuse a restore that was about to succeed. Silencing NOTICEs bounds that output. `warning`,
 * not `error`: a real warning still reaches the operator, and `ON_ERROR_STOP=1` is what stops on
 * failure regardless of this setting.
 */
const RESET_DESTINATION =
  "SET client_min_messages TO warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;";

function restoreIntoDatabase(connection: string, source: string, network?: string): void {
  const env = pgEnvironment(connection, network);
  const name = `moe-backup-apply-${randomUUID()}`;
  const input = openSync(source, "r");
  try {
    // `-c` then `-f -`: psql runs them in the order given, so the reset precedes the dump read
    // from stdin, and `-f -` (not a bare redirect) is what keeps the artifact's `\restrict`
    // meta-commands executable rather than being fed to the SQL parser.
    docker(["run", "--rm", "-i", "--name", name, ...(network ? ["--network", network] : []),
      ...Object.keys(env).flatMap(key => ["--env", key]), IMAGE,
      "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction",
      "-c", RESET_DESTINATION, "-f", "-"], env, input);
  } finally { try { closeSync(input); } finally { disposeContainer(name); } }
}

/** Network is an operator-supplied Docker network; credentials are inherited environment only. */
export function nodeBackupPorts(options: { readonly network?: string } = {}): BackupPorts {
  return Object.freeze({
    store: (source: string, destination: string) => sanitized(async () => {
      const result = await nodeActivationReceiptPorts().backup(source, destination);
      if (!result.ok) throw fail();
    }),
    database: (connection: string, destination: string) => sanitized(() => dumpDatabase(connection, destination, options.network)),
    restoreStore: (path: string) => sanitized(() => restoreStore(path)),
    restoreDatabase: (path: string) => sanitized(() => restoreDatabase(path)),
    // FAIL CLOSED BEFORE THE FIRST BYTE MOVES. `backupFileHash` streams the artifact and throws
    // on a zero-length one, so an absent, empty or unreadable dump refuses here instead of
    // "restoring nothing successfully" against a live destination. Inside `sanitized()` like
    // every other member: a thrown pg message can echo a connection value, and this is the one
    // operation that is holding one.
    restoreDatabaseInto: (connection: string, path: string) => sanitized(async () => {
      await backupFileHash(path);
      restoreIntoDatabase(connection, path, options.network);
    }),
  });
}
