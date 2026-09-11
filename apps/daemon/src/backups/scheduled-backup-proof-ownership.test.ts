import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_APPLICATION_ID } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { nodeActivationReceiptPorts } from "../bootstrap/activation-receipts-measure.js";
import { nodeBackupPorts } from "./backup-ports.js";
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
