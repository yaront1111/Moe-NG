import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { installTestRecoveryBinding } from "../../identity/session-test-fixtures.js";
import {
  decodeMigrationReceiptBytes, migrationReceiptId, migrationRefusal,
  readMigrationReceipt, recordMigrationReceipt,
} from "./migration-receipt.js";
import { migrateWithBackup } from "./migration-service.js";
import { MigrationExecutionError, type MigrationPorts } from "./migration-ports.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const failure = { code: "MIGRATION_BACKUP_FAILED", layer: "DAEMON_INGRESS", detail: "backup failed" };
function receipt() {
  return { version: "moe-migration-receipt/1" as const, projectId: "project", requestId: "request",
    receiptId: migrationReceiptId("project", "request"), environment: "production", sha: "a".repeat(40),
    decidedAt: "2026-09-06T10:00:00.000Z", applied: ["1700000000000-initial.js"],
    backupRef: "backup.sql@sha256:" + "b".repeat(64), outcome: "APPLIED" as const, refusal: null };
}

describe("migration receipt", () => {
  it("pins both outcome/refusal directions and every refused schema", () => {
    const applied = receipt();
    const refused = { ...applied, outcome: "REFUSED", applied: [], backupRef: null, refusal: failure };
    expect(decodeMigrationReceiptBytes(bytes(applied))).toEqual({ ok: true, receipt: applied });
    expect(decodeMigrationReceiptBytes(bytes(refused))).toEqual({ ok: true, receipt: refused });
    const invalid = [null, { ...applied, refusal: failure }, { ...applied, backupRef: null },
      { ...refused, refusal: null }, { ...refused, applied: ["not-applied.js"] },
      { ...refused, refusal: { ...failure, layer: "LEDGER" } }, { ...applied, extra: true },
      { ...applied, receiptId: "c".repeat(64) }, { ...applied, applied: ["../escape.js"] }];
    expect(invalid).toHaveLength(9);
    for (const value of invalid) expect(decodeMigrationReceiptBytes(bytes(value)))
      .toEqual({ ok: false, code: "MIGRATION_RECEIPT_INVALID", layer: "DAEMON_INGRESS" });
    expect(decodeMigrationReceiptBytes(new Uint8Array([0xff])))
      .toEqual({ ok: false, code: "MIGRATION_RECEIPT_INVALID", layer: "DAEMON_INGRESS" });
    expect(migrationRefusal("MIGRATION_BACKUP_FAILED", "backup failed")).toEqual(failure);
  });

  it("accepts the migration CLI's underscore timestamp separator", () => {
    const value = { ...receipt(), applied: ["20260906100100000_added_by_cli.js"] };
    expect(decodeMigrationReceiptBytes(bytes(value))).toEqual({ ok: true, receipt: value });
  });

  it("round trips every member from a real store and refuses mismatched replay", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-migration-test-"))); roots.push(root);
    const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project");
    installTestRecoveryBinding(store);
    try {
      const value = receipt();
      expect(recordMigrationReceipt(store, value)).toEqual(value);
      expect(readMigrationReceipt(store, "project", "request")).toEqual(value);
      expect(recordMigrationReceipt(store, value)).toEqual(value);
      expect(() => recordMigrationReceipt(store, { ...value, environment: "other" }))
        .toThrowError("MIGRATION_RECEIPT_CONFLICT@DAEMON_INGRESS");
      expect(readMigrationReceipt(store, "project", "absent")).toBeNull();
      expect(value.receiptId).toBe(createHash("sha256")
        .update(JSON.stringify(["moe-migration-receipt/1", "project", "request"])).digest("hex"));
    } finally { store.close(); }
  });
});

function world() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-migration-test-"))); roots.push(projectRoot);
  const store = SqliteEventStore.openForProject(join(projectRoot, "events.sqlite"), "project");
  installTestRecoveryBinding(store);
  const database = new DatabaseSync(join(projectRoot, "schema.sqlite"));
  database.exec("CREATE TABLE before_migration(note TEXT)");
  const schema = () => database.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
  const calls: string[] = [];
  const ports: MigrationPorts = {
    dump: async (_url, path) => { calls.push("dump-start"); await Promise.resolve();
      writeFileSync(path, JSON.stringify(schema())); calls.push("dump-completed"); },
    apply: async () => { calls.push("migrate"); database.exec("CREATE TABLE after_migration(id INTEGER)");
      return ["1700000000000-initial.js"]; },
  };
  const input = { projectRoot, workspace: projectRoot, projectId: "project", requestId: "request",
    environment: "production", sha: "a".repeat(40), databaseUrl: "postgresql://localhost/project",
    now: new Date("2026-09-06T10:00:00.000Z") };
  return { input, store, database, schema, ports, calls, close: () => { database.close(); store.close(); } };
}

describe("backup before migration", () => {
  it("waits for completed dump before apply, persists actual hash, and replays without effects", async () => {
    const w = world();
    try {
      const result = await migrateWithBackup(w.store, w.input, w.ports);
      expect(w.calls).toEqual(["dump-start", "dump-completed", "migrate"]);
      const path = join(w.input.projectRoot, ".moe-next", "backups", "pre-migration", "production", "20260906100000000.sql");
      const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(result).toEqual({ ...receipt(), backupRef: `${path}@sha256:${sha256}` });
      expect(readMigrationReceipt(w.store, "project", "request")).toEqual(result);
      expect(await migrateWithBackup(w.store, w.input, w.ports)).toEqual(result);
      expect(w.calls).toHaveLength(3);
      await expect(migrateWithBackup(w.store, { ...w.input, sha: "c".repeat(40) }, w.ports))
        .rejects.toThrowError("MIGRATION_RECEIPT_CONFLICT@DAEMON_INGRESS");
    } finally { w.close(); }
  });

  it("leaves the actual schema unchanged when the backup fails", async () => {
    const w = world();
    try {
      const before = w.schema();
      const result = await migrateWithBackup(w.store, w.input, { ...w.ports, dump: async () => {
        throw new Error("unavailable");
      } });
      expect(w.schema()).toEqual(before);
      expect(w.calls).toEqual([]);
      expect(result).toMatchObject({ outcome: "REFUSED", applied: [], backupRef: null,
        refusal: { code: "MIGRATION_BACKUP_FAILED", layer: "DAEMON_INGRESS" } });
      expect(readMigrationReceipt(w.store, "project", "request")).toEqual(result);
    } finally { w.close(); }
  });

  it("names a failing migration while retaining the actual backup", async () => {
    const w = world();
    try {
      const result = await migrateWithBackup(w.store, w.input, { ...w.ports, apply: async () => {
        throw new MigrationExecutionError("1700000000001-broken.js");
      } });
      expect(result).toMatchObject({ outcome: "REFUSED", applied: [], refusal: {
        code: "MIGRATION_FAILED", layer: "DAEMON_INGRESS", detail: "1700000000001-broken.js",
      } });
      expect(existsSync(result.backupRef!.split("@sha256:")[0]!)).toBe(true);
      expect(readMigrationReceipt(w.store, "project", "request")).toEqual(result);
    } finally { w.close(); }
  });

  it("refuses an empty dump and a repeated destination without applying", async () => {
    const w = world();
    try {
      const empty = await migrateWithBackup(w.store, w.input, { ...w.ports,
        dump: async (_url, path) => { writeFileSync(path, ""); } });
      expect(empty.refusal).toMatchObject({ code: "MIGRATION_BACKUP_FAILED", layer: "DAEMON_INGRESS" });
      expect(w.calls).toEqual([]);
      const good = await migrateWithBackup(w.store, { ...w.input, requestId: "second" }, w.ports);
      const repeated = await migrateWithBackup(w.store, { ...w.input, requestId: "third" }, w.ports);
      expect(repeated.refusal).toMatchObject({ code: "MIGRATION_BACKUP_FAILED", layer: "DAEMON_INGRESS" });
      expect(w.calls).toEqual(["dump-start", "dump-completed", "migrate"]);
      expect(existsSync(good.backupRef!.split("@sha256:")[0]!)).toBe(true);
    } finally { w.close(); }
  });

  it("does not let an overlapping refusal overwrite the in-flight successful receipt", async () => {
    const w = world();
    let unblock: () => void = () => undefined;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    const first = migrateWithBackup(w.store, w.input, { ...w.ports, dump: async (url, path) => {
      await held; await w.ports.dump(url, path);
    } });
    try {
      const second = migrateWithBackup(w.store, w.input, w.ports);
      await expect(second).rejects.toThrowError("MIGRATION_IN_PROGRESS@DAEMON_INGRESS");
      expect(readMigrationReceipt(w.store, "project", "request")).toBeNull();
      unblock();
      expect((await first).outcome).toBe("APPLIED");
      expect(readMigrationReceipt(w.store, "project", "request")?.outcome).toBe("APPLIED");
    } finally { unblock(); await Promise.allSettled([first]); w.close(); }
  });

  it("refuses invalid paths, dates and identifiers before database effects", async () => {
    const w = world();
    try {
      const invalid = [{ environment: "../escape" }, { now: new Date(NaN) }, { requestId: "x".repeat(5000) }];
      expect(invalid).toHaveLength(3);
      for (const patch of invalid) await expect(migrateWithBackup(w.store, { ...w.input, ...patch }, w.ports))
        .rejects.toThrowError("MIGRATION_RECEIPT_INVALID@DAEMON_INGRESS");
      expect(w.calls).toEqual([]);
    } finally { w.close(); }
  });
});
