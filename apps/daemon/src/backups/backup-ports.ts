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

async function ready(name: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(["exec", name, "pg_isready", "-U", "postgres"]); return; }
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
  });
}
