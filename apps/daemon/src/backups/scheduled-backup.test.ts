import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_APPLICATION_ID } from "@moe/store";
import { BACKUP_DIRECTORY, BACKUP_LEAF, BACKUP_RETENTION, SCHEDULED_BACKUP_LEAF, nodeActivationReceiptPorts } from "../bootstrap/activation-receipts-measure.js";
import { BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, createBackupRestoreProofStore } from "./backup-restore-proof.js";
import { backupFileHash, nodeBackupPorts } from "./backup-ports.js";
import { runScheduledBackup } from "./scheduled-backup.js";

const roots: string[] = [];
const failure = { code: "BACKUP_FAILED", layer: "DAEMON_ACTIVATION_RECEIPTS" };
const clock = new Date("2026-09-06T10:00:00.000Z");
// Linux CI provides Linux containers. Other hosts opt in only when configured to
// run them; an enabled arm still fails if Docker or the required image is unavailable.
const RUN_POSTGRES_RESTORE = process.platform === "linux" || process.env.MOE_MIGRATION_RESTORE === "1";
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-backup-test-")));
  roots.push(projectRoot);
  const storePath = join(projectRoot, "store.sqlite");
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}; CREATE TABLE proof (note TEXT);`);
    db.exec("INSERT INTO proof VALUES ('durable-row');");
  } finally { db.close(); }
  return { projectRoot, storePath, environments: [], now: clock };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const docker = (args: readonly string[]) => execFileSync("docker", [...args], {
  encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const containers = () => docker(["ps", "-aq", "--filter", "name=moe-backup-"]).split(/\s+/u).filter(Boolean).sort();

describe("scheduled backups", () => {
  it("proves a real online SQLite backup and records matching restored bytes", async () => {
    const input = fixture();
    const ports = nodeBackupPorts();
    const destination = join(input.projectRoot, "copy.sqlite");
    await ports.store(input.storePath, destination);
    const proof = await ports.restoreStore(destination);
    expect(await backupFileHash(destination)).toBe(fileHash(destination));
    expect(proof).toEqual({ sha256: fileHash(destination), restoredSha256: fileHash(destination) });
    const db = new DatabaseSync(destination, { readOnly: true });
    try { expect(db.prepare("SELECT note FROM proof").get()).toEqual({ note: "durable-row" }); }
    finally { db.close(); }
  });

  it("sanitizes a malformed connection at the production port boundary", async () => {
    const input = fixture();
    const error: unknown = await nodeBackupPorts().database("not a postgres URL", join(input.projectRoot, "bad.sql"))
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "not an error").toBe("BACKUP_FAILED");
    expect(error).toMatchObject(failure);
    expect(Object.hasOwn(error as object, "input")).toBe(false);
  });

  it.each([0, 1])("allows exactly one writer for overlapping runs with clock offset %i", async (offset) => {
    const input = fixture();
    const real = nodeBackupPorts(); let copies = 0;
    const ports = { ...real, store: async (source: string, destination: string) => {
      copies++; await real.store(source, destination);
    } };
    const results = await Promise.all([runScheduledBackup(input, ports),
      runScheduledBackup({ ...input, now: new Date(clock.getTime() + offset) }, ports)]);
    expect(copies).toBe(1);
    expect(results.map(r => r.backups[0]!.status).sort()).toEqual(["FAILED", "VERIFIED"]);
    expect(results.find(r => r.backups[0]!.status === "FAILED")?.backups[0])
      .toMatchObject({ failure, stage: "WRITE" });
  });

  it("records files, skips database-free environments, and refuses a repeated clock", async () => {
    const input = { ...fixture(), environments: [{ name: "dev", databaseUrl: null }] };
    const receipt = await runScheduledBackup(input);
    expect(receipt.schemaVersion).toBe("moe-scheduled-backup/1");
    expect(receipt.backups).toHaveLength(1);
    const backup = receipt.backups[0]!;
    expect(backup.status).toBe("VERIFIED");
    expect(backup.sha256).toBe(fileHash(backup.ref));
    expect(backup.proof).toEqual({ sha256: backup.sha256, restoredSha256: backup.sha256 });
    expect(dirname(backup.ref)).toBe(join(input.projectRoot, ".moe-next", "backups", "scheduled", "store"));
    expect(receipt.skipped).toEqual([{ environment: "dev", reason: "DATABASE_ABSENT" }]);
    const repeated = await runScheduledBackup(input);
    expect(repeated.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "WRITE" });
    expect(fileHash(backup.ref)).toBe(backup.sha256);
  });

  it("does not certify corrupt files or a lying restore proof", async () => {
    const input = fixture();
    const real = nodeBackupPorts();
    let attempted = 0;
    for (const variant of ["corrupt", "mismatch", "disk-full"] as const) {
      attempted++;
      const current = { ...input, now: new Date(clock.getTime() + (variant === "corrupt" ? 1 : 2)) };
      const ports = variant === "corrupt" ? { ...real, store: async (_s: string, dest: string) => {
        writeFileSync(dest, "not sqlite");
      } } : variant === "disk-full" ? { ...real, restoreStore: async () => { throw new Error("ENOSPC"); } }
        : { ...real, restoreStore: async (path: string) => ({
        sha256: await backupFileHash(path), restoredSha256: "0".repeat(64),
      }) };
      const receipt = await runScheduledBackup(current, ports);
      expect(receipt.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "RESTORE", proof: null });
      expect(existsSync(receipt.backups[0]!.ref)).toBe(false);
      expect(readdirSync(dirname(receipt.backups[0]!.ref)).some(name => name.endsWith(".lock"))).toBe(false);
    }
    expect(attempted).toBe(3);
  });

  it("isolates one database failure and never serializes its connection string", async () => {
    const input = fixture();
    const secret = new URL("postgresql://localhost/project");
    secret.password = randomUUID();
    const receipt = await runScheduledBackup({ ...input,
      environments: [{ name: "offline", databaseUrl: secret.href }, { name: "no-db", databaseUrl: null }],
    }, { ...nodeBackupPorts(), database: async (_url, path) => {
      writeFileSync(path, "partial dump"); throw new Error(secret.href);
    } });
    expect(receipt.backups.map(b => b.status)).toEqual(["VERIFIED", "FAILED"]);
    expect(receipt.backups[1]).toMatchObject({ failure, stage: "WRITE" });
    expect(existsSync(receipt.backups[1]!.ref)).toBe(false);
    expect(JSON.stringify(receipt).includes(secret.href)).toBe(false);
    expect(JSON.stringify(receipt).includes(secret.password)).toBe(false);
  });

  it("refuses path traversal and symlinked backup subtrees without touching another owner's files", async () => {
    const input = fixture();
    const invalid = await runScheduledBackup({ ...input,
      environments: [{ name: "../pre-migration", databaseUrl: "not used" }],
    });
    expect(invalid.backups[1]).toMatchObject({ environment: "INVALID_ENVIRONMENT", status: "FAILED", failure, stage: "WRITE" });
    const other = fixture();
    const base = join(other.projectRoot, ".moe-next", "backups");
    const protectedDirectory = join(base, "pre-migration");
    mkdirSync(protectedDirectory, { recursive: true });
    writeFileSync(join(protectedDirectory, "precious.sql"), "untouched");
    symlinkSync(protectedDirectory, join(base, "scheduled"), "junction");
    const blocked = await runScheduledBackup(other);
    expect(blocked.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "WRITE" });
    expect(readdirSync(protectedDirectory)).toEqual(["precious.sql"]);
  });

  it("records an empty successful writer as a failed restore, not a verified empty artifact", async () => {
    const input = fixture();
    const receipt = await runScheduledBackup(input, { ...nodeBackupPorts(),
      store: async (_source, destination) => { writeFileSync(destination, ""); },
    });
    expect(receipt.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "RESTORE", proof: null });
    expect(existsSync(receipt.backups[0]!.ref)).toBe(false);
  });

  it("retains newest N, records the exact removed refs, and never prunes pre-migration", async () => {
    const input = fixture();
    const kept = join(input.projectRoot, ".moe-next", "backups", "pre-migration", "store", "20260101000000000.sql");
    mkdirSync(dirname(kept), { recursive: true }); writeFileSync(kept, "migration safety net");
    for (let i = 1; i <= BACKUP_RETENTION + 1; i++) {
      writeFileSync(join(dirname(kept), `${String(i).padStart(17, "0")}.sql`), "migration safety net");
    }
    const migrationBefore = readdirSync(dirname(kept)).sort();
    const refs: string[] = [];
    for (let i = 0; i < BACKUP_RETENTION + 2; i++) {
      const before = refs.filter(ref => existsSync(ref));
      const receipt = await runScheduledBackup({ ...input, now: new Date(clock.getTime() + i) });
      const backup = receipt.backups[0]!;
      expect(backup.status).toBe("VERIFIED"); refs.push(backup.ref);
      expect([...receipt.prunedRefs].sort()).toEqual(before.filter(ref => !existsSync(ref)).sort());
    }
    const remaining = readdirSync(dirname(refs[0]!)).sort();
    expect(remaining).toEqual(refs.slice(-BACKUP_RETENTION).map(ref => basename(ref)).sort());
    expect(refs.slice(0, 2).every(ref => !existsSync(ref))).toBe(true);
    expect(readFileSync(kept, "utf8")).toBe("migration safety net");
    expect(readdirSync(dirname(kept)).sort()).toEqual(migrationBefore);
    const backwards = await runScheduledBackup({ ...input, now: new Date(clock.getTime() - 1) });
    expect(backwards.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "WRITE" });
    expect(readdirSync(dirname(refs[0]!)).sort()).toEqual(remaining);
  });

  it("reports a prune failure after a verified backup, preserving the artifact", async () => {
    const input = fixture();
    const fs = nodeActivationReceiptPorts().fs;
    const receipt = await runScheduledBackup(input, nodeBackupPorts(), {
      ...fs, list: () => { throw new Error("denied"); },
    });
    expect(receipt.backups[0]).toMatchObject({ status: "FAILED", failure, stage: "PRUNE" });
    expect(existsSync(receipt.backups[0]!.ref)).toBe(true);
    expect(receipt.pruneFailedRefs).toEqual([dirname(receipt.backups[0]!.ref)]);
  });
});

describe.runIf(RUN_POSTGRES_RESTORE)("real PostgreSQL backup restore", () => {
  it("restores the seeded row, rejects corruption, and tears down on both exits", async () => {
    const before = containers();
    const name = `moe-backup-fixture-${randomUUID()}`;
    const temporaryBefore = readdirSync(tmpdir()).filter(name => name.startsWith("moe-backup-restore-")).sort();
    try {
      docker(["run", "--rm", "-d", "--name", name, "--network", "none", "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try { docker(["exec", name, "pg_isready", "-U", "postgres"]); ready = true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      expect(ready).toBe(true);
      docker(["exec", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
        "CREATE TABLE proof(note text); INSERT INTO proof VALUES ('restored-row');"]);
      const input = fixture();
      const connection = new URL("postgresql://127.0.0.1/postgres"); connection.username = "postgres";
      const ports = nodeBackupPorts({ network: `container:${name}` });
      const environments = [{ name: "production", databaseUrl: connection.href }];
      const good = await runScheduledBackup({ ...input, environments }, ports);
      const backup = good.backups[1]!;
      expect(backup).toMatchObject({ status: "VERIFIED", failure: null });
      expect(backup.sha256).toBe(fileHash(backup.ref));
      expect(backup.proof).toEqual({ sha256: backup.sha256, restoredSha256: backup.sha256 });
      expect(readFileSync(backup.ref, "utf8")).toContain("restored-row");
      const broken = await runScheduledBackup({ ...input, environments, now: new Date(clock.getTime() + 1) }, {
        ...ports, database: async (url, path) => {
          await ports.database(url, path); appendFileSync(path, "\nSELECT * FROM missing_backup_table;\n");
        },
      });
      expect(broken.backups[1]).toMatchObject({ status: "FAILED", failure, stage: "RESTORE", proof: null });
      expect(existsSync(broken.backups[1]!.ref)).toBe(false);
    } finally {
      docker(["rm", "-f", name]);
      expect(containers()).toEqual(before);
      expect(readdirSync(tmpdir()).filter(name => name.startsWith("moe-backup-restore-")).sort()).toEqual(temporaryBefore);
    }
  }, 120_000);
});

/**
 * THE WRITE EDGE (DoD 1). `runScheduledBackup` returned a receipt to its caller and nothing
 * persisted it - a fact computed and reaching nothing. Every arm below reads the persisted state
 * back through the RECORD MODULE'S OWN READER rather than through the writer's return value, so
 * what is asserted is what a later read route would actually serve.
 *
 * The `proofs` parameter is ADDITIVE and optional: the arms above this block call
 * `runScheduledBackup` without it and are untouched, which is the property that keeps
 * `ScheduledBackupResult` and `ScheduledBackupReceipt` the delivered contract they already were.
 */
describe("the scheduled run persists a durable restore-proof record", () => {
  const proofStore = (input: ReturnType<typeof fixture>) =>
    createBackupRestoreProofStore(
      `${input.storePath}${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`, "proj-0001",
    );
  const lockDirectory = (input: ReturnType<typeof fixture>, environment: string) =>
    join(input.projectRoot, BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, environment);
  const readAll = (store: ReturnType<typeof proofStore>) => {
    const read = store.read();
    if (!read.ok) throw new Error(`restore-proof read refused: ${read.code}`);
    return read.value;
  };

  it("records PROVEN with the run's own sha256 when the restore check verified", async () => {
    const input = fixture();
    const store = proofStore(input);
    const receipt = await runScheduledBackup(input, nodeBackupPorts(),
      nodeActivationReceiptPorts().fs, store);
    const backup = receipt.backups[0]!;
    expect(backup.status).toBe("VERIFIED");

    const records = readAll(store);
    expect(records).toHaveLength(1);
    // BY VALUE, and read back through the reader - not the writer's answer.
    expect(records[0]).toEqual({
      checkedAt: clock.toISOString(), environment: "store", kind: "STORE",
      ref: basename(backup.ref), restoreProof: "PROVEN", sha256: backup.sha256,
      version: "moe-backup-restore-proof/1",
    });
    // The digest is the RUN's, not a second hash taken here, and it is a real one.
    expect(records[0]?.sha256).toBe(fileHash(backup.ref));
    expect(records[0]?.restoreProof).not.toBe("NOT_CHECKED");
  });

  it("records FAILED - never PROVEN - when the backup write itself failed", async () => {
    const input = fixture();
    const store = proofStore(input);
    const real = nodeBackupPorts();
    const ports = { ...real, store: async () => { throw new Error("BACKUP_FAILED"); } };
    const receipt = await runScheduledBackup(input, ports, nodeActivationReceiptPorts().fs, store);
    expect(receipt.backups[0]).toMatchObject({ status: "FAILED", stage: "WRITE" });

    const records = readAll(store);
    expect(records).toHaveLength(1);
    expect(records[0]?.restoreProof).toBe("FAILED");
    expect(records[0]?.restoreProof).not.toBe("PROVEN");
    // No proof, so no digest - null rather than an empty string.
    expect(records[0]?.sha256).toBeNull();
    expect(records[0]?.checkedAt).toBe(clock.toISOString());

    // THE FAILURE PATH OWNS ITS TEARDOWN (epic rail 4): the environment lock is released and no
    // half-written artifact survives, with the persistence write sitting after both.
    expect(readdirSync(lockDirectory(input, "store"))).toEqual([]);
    expect(existsSync(receipt.backups[0]!.ref)).toBe(false);
  });

  it("persists NOTHING for an environment skipped as DATABASE_ABSENT", async () => {
    const input = fixture();
    const store = proofStore(input);
    const receipt = await runScheduledBackup(
      { ...input, environments: [{ databaseUrl: null, name: "production" }] },
      nodeBackupPorts(), nodeActivationReceiptPorts().fs, store,
    );
    expect(receipt.skipped).toEqual([{ environment: "production", reason: "DATABASE_ABSENT" }]);

    // Exactly the store's own row and no row for `production`. A NOT_CHECKED row here would
    // later read as a backup somebody took and nobody verified, which is a worse lie than
    // the absence: no artifact was ever written for it.
    const records = readAll(store);
    expect(records.map((record) => record.environment)).toEqual(["store"]);
    expect(records.some((record) => record.environment === "production")).toBe(false);
  });

  it("behaves identically when no proof writer is supplied", async () => {
    const input = fixture();
    const store = proofStore(input);
    const receipt = await runScheduledBackup(input);
    expect(receipt.backups[0]?.status).toBe("VERIFIED");
    // The sidecar was never created, so the reader answers EMPTY rather than refusing.
    expect(store.read()).toEqual({ ok: true, value: [] });
  });

  it("does not abort the run when the record refuses the write", async () => {
    const input = fixture();
    const store = proofStore(input);
    // `Uppercase_Env` satisfies the filesystem guard and NOT the served surface's environment
    // vocabulary, so the record refuses. The backup itself must still complete and report.
    const environments = [{ databaseUrl: "postgresql://127.0.0.1/absent", name: "Uppercase_Env" }];
    const receipt = await runScheduledBackup({ ...input, environments }, nodeBackupPorts(),
      nodeActivationReceiptPorts().fs, store);
    expect(receipt.backups).toHaveLength(2);
    expect(receipt.backups[0]?.status).toBe("VERIFIED");

    const records = readAll(store);
    expect(records.map((record) => record.environment)).toEqual(["store"]);
  });
});
