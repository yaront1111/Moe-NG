import { spawnSync } from "node:child_process";
import {
  existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_APPLICATION_ID } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, nodeActivationReceiptPorts,
} from "../bootstrap/activation-receipts-measure.js";
import { nodeBackupPorts } from "./backup-ports.js";
import { createBackupRestoreProofStore } from "./backup-restore-proof.js";
import { BACKUP_LOCK_STALE_AFTER_MS, runScheduledBackup } from "./scheduled-backup.js";

const roots: string[] = [];
const now = new Date("2026-09-11T10:00:00.000Z");
const failure = { code: "BACKUP_FAILED", layer: "DAEMON_ACTIVATION_RECEIPTS" };

function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-backup-lock-")));
  roots.push(projectRoot);
  const storePath = join(projectRoot, "store.sqlite");
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}; CREATE TABLE proof (note TEXT);`);
    db.exec("INSERT INTO proof VALUES ('durable-row');");
  } finally { db.close(); }
  const proofs = createBackupRestoreProofStore(`${storePath}.backups.sqlite`, "lock-staleness");
  const lock = join(projectRoot, BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, "store", ".backup.lock");
  mkdirSync(join(lock, ".."), { recursive: true });
  return { input: { environments: [], now, projectRoot, storePath }, lock, proofs };
}

/** A pid that certainly WAS a process and certainly is one no longer. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  if (child.pid === undefined || child.status !== 0) throw new Error("fixture child did not run");
  return child.pid;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A LOCK LEFT BY A CRASH MUST NOT STOP EVERY LATER BACKUP OF THAT ENVIRONMENT. `finally` never
 * runs after a SIGKILL or a power loss, so the directory survives, and without an owner check
 * every later run refused at WRITE for ever with nothing in the receipt but BACKUP_FAILED. The
 * arms below reap exactly the corpse shapes - a dead owner, or any lock older than a run can be,
 * because a pid is recycled and a live one only vouches for a holder inside that bound - and
 * refuse everything else, because evicting a live writer is the double write the lock exists to
 * prevent.
 */
describe("scheduled backup lock staleness", () => {
  it("reaps a lock whose owner process is gone, names itself while held, and records the proof", async () => {
    const { input, lock, proofs } = fixture();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(exitedPid()));
    const ports = nodeBackupPorts();
    let ownerWhileHeld: string | null = null;

    const receipt = await runScheduledBackup(input, { ...ports, store: async (source, destination) => {
      ownerWhileHeld = readFileSync(join(lock, "owner"), "utf8");
      await ports.store(source, destination);
    } }, nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure: null, stage: "PRUNE", status: "VERIFIED" });
    expect(ownerWhileHeld).toBe(String(process.pid));
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(lock, ".."))).toEqual(["20260911100000000.sqlite"]);
    expect(proofs.read()).toMatchObject({ ok: true, value: [{ restoreProof: "PROVEN" }] });
  });

  it("reaps an ownerless lock older than any run can be", async () => {
    const { input, lock, proofs } = fixture();
    mkdirSync(lock);
    const stale = new Date(Date.now() - BACKUP_LOCK_STALE_AFTER_MS - 1_000);
    utimesSync(lock, stale, stale);

    const receipt = await runScheduledBackup(input, nodeBackupPorts(), nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure: null, status: "VERIFIED" });
    expect(existsSync(lock)).toBe(false);
    expect(proofs.read()).toMatchObject({ ok: true, value: [{ restoreProof: "PROVEN" }] });
  });

  it("keeps refusing a lock whose owner is alive while the lock is younger than the bound", async () => {
    const { input, lock, proofs } = fixture();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(process.pid));
    const inside = new Date(Date.now() - BACKUP_LOCK_STALE_AFTER_MS + 60 * 60 * 1_000);
    utimesSync(lock, inside, inside);
    let writes = 0;

    const receipt = await runScheduledBackup(input, {
      ...nodeBackupPorts(), store: async () => { writes++; },
    }, nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure, stage: "WRITE", status: "FAILED" });
    expect(writes).toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(String(process.pid));
    expect(proofs.read()).toEqual({ ok: true, value: [] });
  });

  /** After a crash and a reboot the dead daemon's pid names whatever process got it next. */
  it("reaps a lock older than the bound although a live process wears its owner's pid", async () => {
    const { input, lock, proofs } = fixture();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(process.pid));
    const stale = new Date(Date.now() - BACKUP_LOCK_STALE_AFTER_MS - 1_000);
    utimesSync(lock, stale, stale);

    const receipt = await runScheduledBackup(input, nodeBackupPorts(), nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure: null, status: "VERIFIED" });
    expect(existsSync(lock)).toBe(false);
    expect(proofs.read()).toMatchObject({ ok: true, value: [{ restoreProof: "PROVEN" }] });
  });

  it("sweeps a stranded corpse beside the lock under the same judge and keeps every other strand", async () => {
    const { input, lock, proofs } = fixture();
    const dead = `${lock}.11111111-1111-4111-8111-111111111111`;
    const live = `${lock}.22222222-2222-4222-8222-222222222222`;
    // A pid `process.kill` rejects outright: the judge throws, and a strand it cannot read stays.
    const unprobeable = `${lock}.33333333-3333-4333-8333-333333333333`;
    for (const [path, pid] of [[dead, exitedPid()], [live, process.pid], [unprobeable, 9_999_999_999]] as const) {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), String(pid));
    }

    const receipt = await runScheduledBackup(input, nodeBackupPorts(), nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure: null, stage: "PRUNE", status: "VERIFIED" });
    expect(existsSync(dead)).toBe(false);
    expect(readFileSync(join(live, "owner"), "utf8")).toBe(String(process.pid));
    expect(readdirSync(join(lock, "..")).sort()).toEqual([
      ".backup.lock.22222222-2222-4222-8222-222222222222",
      ".backup.lock.33333333-3333-4333-8333-333333333333", "20260911100000000.sqlite",
    ]);
    expect(proofs.read()).toMatchObject({ ok: true, value: [{ restoreProof: "PROVEN" }] });
  });

  it("never follows or removes a symlink standing at the lock's path", async () => {
    const { input, lock, proofs } = fixture();
    const elsewhere = join(input.projectRoot, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "precious"), "untouched");
    symlinkSync(elsewhere, lock, "junction");
    const stale = new Date(Date.now() - BACKUP_LOCK_STALE_AFTER_MS - 1_000);
    lutimesSync(lock, stale, stale);

    const receipt = await runScheduledBackup(input, nodeBackupPorts(), nodeActivationReceiptPorts().fs, proofs);

    expect(receipt.backups[0]).toMatchObject({ failure, stage: "WRITE", status: "FAILED" });
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual(["precious"]);
    expect(proofs.read()).toEqual({ ok: true, value: [] });
  });
});
