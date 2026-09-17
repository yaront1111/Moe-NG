import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_APPLICATION_ID } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_DIRECTORY, BACKUP_LEAF, BACKUP_RETENTION, SCHEDULED_BACKUP_LEAF, nodeActivationReceiptPorts,
} from "../bootstrap/activation-receipts-measure.js";
import type { ActivationReceiptFs } from "../bootstrap/activation-receipts-ports.js";
import { nodeBackupPorts } from "./backup-ports.js";
import type { BackupPorts } from "./backup-ports.js";
import { createBackupRestoreProofStore } from "./backup-restore-proof.js";
import { runScheduledBackup } from "./scheduled-backup.js";

const roots: string[] = [];
const now = new Date("2026-09-11T10:00:00.000Z");
const failure = { code: "BACKUP_FAILED", layer: "DAEMON_ACTIVATION_RECEIPTS" };
const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-backup-proof-ownership-")));
  roots.push(projectRoot);
  const storePath = join(projectRoot, "store.sqlite");
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}; CREATE TABLE proof (note TEXT);`);
    db.exec("INSERT INTO proof VALUES ('durable-row');");
  } finally { db.close(); }
  const proofs = createBackupRestoreProofStore(`${storePath}.backups.sqlite`, "proof-ownership");
  const input = { projectRoot, storePath, environments: [], now };
  return { input, proofs };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled backup restore-proof ownership", () => {
  it.each(["EXISTING_ARTIFACT", "LOCK_HELD"])(
    "preserves a verified artifact's proof when another attempt refuses at %s", async (reason) => {
      const { input, proofs } = fixture();
      const ports = nodeBackupPorts();
      const fs = nodeActivationReceiptPorts().fs;
      const first = await runScheduledBackup(input, ports, fs, proofs);
      const backup = first.backups[0]!;
      expect(backup.status).toBe("VERIFIED");
      const originalProof = proofs.read();
      expect(originalProof).toMatchObject({ ok: true, value: [{ restoreProof: "PROVEN" }] });
      const lock = join(dirname(backup.ref), ".backup.lock");
      if (reason === "LOCK_HELD") mkdirSync(lock);
      let writes = 0;

      const retried = await runScheduledBackup(input, {
        ...ports,
        store: async (source, destination) => { writes++; await ports.store(source, destination); },
      }, fs, proofs);

      expect(retried.backups[0]).toMatchObject({
        failure, ref: backup.ref, stage: "WRITE", status: "FAILED",
      });
      expect(writes).toBe(0);
      expect(fileHash(backup.ref)).toBe(backup.sha256);
      expect(existsSync(lock)).toBe(reason === "LOCK_HELD");
      expect(proofs.read()).toEqual(originalProof);
    },
  );

  it("does not record an artifact when the backwards-clock check refused before its write", async () => {
    const { input, proofs } = fixture();
    const ports = nodeBackupPorts();
    const fs = nodeActivationReceiptPorts().fs;
    expect((await runScheduledBackup(input, ports, fs, proofs)).backups[0]?.status).toBe("VERIFIED");
    const originalProof = proofs.read();
    const refused = await runScheduledBackup({ ...input, now: new Date(now.getTime() - 1) }, ports, fs, proofs);

    expect(refused.backups[0]).toMatchObject({ failure, stage: "WRITE", status: "FAILED" });
    expect(existsSync(refused.backups[0]!.ref)).toBe(false);
    expect(proofs.read()).toEqual(originalProof);
  });

  it("records failed restore verification for an archive this attempt actually wrote", async () => {
    const { input, proofs } = fixture();
    const ports = nodeBackupPorts();
    let writtenHash: string | undefined;
    const receipt = await runScheduledBackup(input, {
      ...ports,
      restoreStore: async (path) => {
        writtenHash = fileHash(path);
        throw new Error("restore verification failed");
      },
    }, nodeActivationReceiptPorts().fs, proofs);

    expect(writtenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.backups[0]).toMatchObject({
      failure, proof: null, sha256: writtenHash, stage: "RESTORE", status: "FAILED",
    });
    expect(existsSync(receipt.backups[0]!.ref)).toBe(false);
    expect(proofs.read()).toMatchObject({
      ok: true, value: [{ checkedAt: now.toISOString(), restoreProof: "FAILED", sha256: writtenHash }],
    });
  });
});

/**
 * THE RUN'S OUTCOME IS NOT THE RESTORE CHECK'S VERDICT. Retention and the lock release both run
 * AFTER the restore check has proved the artifact, and either failing turns the run's `status`
 * FAILED - the run did not finish clean - while the artifact on disk is exactly the one proven.
 * The record answers only the second question, so it must read PROVEN: an operator reaching for
 * the newest backup during an incident skips a "proven NOT restorable" row, and this is the good
 * one. Each arm below is a real post-check failure, not a stubbed status.
 */
describe("a failure after the restore check keeps the artifact's proof", () => {
  type Seams = { readonly fs: ActivationReceiptFs; readonly ports: BackupPorts };
  type Arrange = (input: ReturnType<typeof fixture>["input"], seams: Seams) => Seams;
  const storeDirectory = (input: { readonly projectRoot: string }): string =>
    join(input.projectRoot, BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, "store");
  const retentionCannotUnlink: Arrange = (input, seams) => {
    // More dumps than retention keeps, and the oldest cannot be unlinked: the EPERM another
    // process holding a file open produces on Windows.
    mkdirSync(storeDirectory(input), { recursive: true });
    for (let i = 1; i <= BACKUP_RETENTION + 1; i++) {
      writeFileSync(join(storeDirectory(input), `${String(i).padStart(17, "0")}.sqlite`), "old dump");
    }
    const remove = (): never => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    return { fs: { ...seams.fs, remove }, ports: seams.ports };
  };
  const lockCannotRelease: Arrange = (input, seams) => ({
    fs: seams.fs, ports: { ...seams.ports, restoreStore: async (path) => {
      const proof = await seams.ports.restoreStore(path);
      // Something lands inside the lock between the check and its release, so the release fails.
      writeFileSync(join(storeDirectory(input), ".backup.lock", "junk"), "");
      return proof;
    } },
  });

  it.each([["PRUNE", retentionCannotUnlink], ["CLEANUP", lockCannotRelease]] as const)(
    "records PROVEN when the run fails at %s after the artifact was proven", async (stage, arrange) => {
      const { input, proofs } = fixture();
      const seams = arrange(input, { fs: nodeActivationReceiptPorts().fs, ports: nodeBackupPorts() });
      const receipt = await runScheduledBackup(input, seams.ports, seams.fs, proofs);
      const backup = receipt.backups[0]!;
      // The RUN did not finish clean, and the receipt says so at the stage that failed...
      expect(backup).toMatchObject({ failure, stage, status: "FAILED" });
      // ...while the artifact is the one the restore check proved, untouched and still on disk.
      expect(backup.proof).toEqual({ restoredSha256: backup.sha256, sha256: backup.sha256 });
      expect(fileHash(backup.ref)).toBe(backup.sha256);
      expect(proofs.read()).toMatchObject({ ok: true, value: [{
        checkedAt: now.toISOString(), ref: basename(backup.ref), restoreProof: "PROVEN", sha256: backup.sha256,
      }] });
    },
  );
});
