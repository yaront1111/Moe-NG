/**
 * AN INTERRUPTED FIRST INITIALIZATION IS RECOVERABLE: the guard measures the DATABASE, not the file.
 *
 * `new DatabaseSync(path)` creates the sidecar file before the schema transaction begins. A first
 * write that dies before COMMIT - the process killed, or CREATE TABLE refused by a full disk -
 * leaves a file that sqlite rolls back to an EMPTY database: application id 0, user version 0,
 * no table. That is exactly the shape the create branch accepts, so the next write must establish
 * the schema in it rather than refuse it as foreign on every call from then on.
 *
 * Split from `backup-restore-proof.test.ts`, which sits at the 400-line bound.
 *
 * ANYTHING THESE TESTS START, THEY STOP (epic rail 4): every arm creates its sidecar under a
 * temp tree removed in a `finally`, on the failure paths too.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, createBackupRestoreProofStore,
} from "./backup-restore-proof.js";

const PROJECT = "proj-0001";
const ENVIRONMENT = "production";
const SHA = "a".repeat(64);
const CHECKED_AT = "2026-09-07T12:00:00.000Z";
const REF = "20260907100000000.sqlite";

interface World { readonly directory: string; readonly path: string }

function world(name: string): World {
  const directory = mkdtempSync(join(tmpdir(), `moe-backup-proof-${name}-`));
  return { directory, path: join(directory, `store.db${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`) };
}

const teardown = (open: World): void => rmSync(open.directory, { force: true, recursive: true });

/**
 * What a first initialization that never reached COMMIT leaves behind: the file exists, and the
 * database inside it is EMPTY. Rolled back explicitly here; a hot journal replays to the same.
 */
function interruptFirstInitialization(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("BEGIN IMMEDIATE; CREATE TABLE backup_restore_proofs (ref TEXT); ROLLBACK");
  } finally { database.close(); }
}

describe("an interrupted first initialization leaves a sidecar the store can still establish", () => {
  it("initializes an EMPTY sidecar on the next write instead of refusing it as foreign", () => {
    const open = world("interrupted-init");
    try {
      interruptFirstInitialization(open.path);
      // POSITIVE CONTROL: the file IS there, so a pre-open existence probe reads "existed", and
      // the database inside it is empty, so nothing but the guard's choice of measure separates
      // this sidecar from one that was never opened.
      expect(existsSync(open.path)).toBe(true);
      const probe = new DatabaseSync(open.path);
      try {
        expect(probe.prepare("SELECT name FROM sqlite_master").all()).toStrictEqual([]);
        expect(probe.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(0);
        expect(probe.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(0);
      } finally { probe.close(); }

      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const written = store.recordWritten({ environment: ENVIRONMENT, kind: "STORE", ref: REF });
      // THE RECOVERY. Before the guard measured the database, this was
      // BACKUP_PROOF_STORE_UNAVAILABLE on this call and on every later one.
      if (!written.ok) throw new Error(`write refused: ${written.code}`);
      expect(written.value.restoreProof).toBe("NOT_CHECKED");

      // And the store is established from here on: a check lands, and the read serves it.
      expect(store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "STORE", ref: REF,
        sha256: SHA, status: "VERIFIED",
      }).ok).toBe(true);
      const read = store.read();
      if (!read.ok) throw new Error(`read refused: ${read.code}`);
      expect(read.value.map((record) => `${record.ref}=${record.restoreProof}`))
        .toStrictEqual([`${REF}=PROVEN`]);
    } finally {
      teardown(open);
    }
  });

  it("still refuses a database that is NOT empty: emptiness is the only shape a write creates in", () => {
    const open = world("half-foreign");
    try {
      // Application id 0 and user version 0, like an empty sidecar, but with a table in it: the
      // three-part emptiness measure must red on the third part alone.
      const foreign = new DatabaseSync(open.path);
      try { foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"); }
      finally { foreign.close(); }
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.recordWritten({ environment: ENVIRONMENT, kind: "STORE", ref: REF }))
        .toStrictEqual({ code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false });
      // Nothing was written into it: the foreign table is the only one there.
      const probe = new DatabaseSync(open.path);
      try {
        expect(probe.prepare("SELECT name FROM sqlite_master ORDER BY name").all()
          .map((row) => row["name"])).toStrictEqual(["unrelated"]);
      } finally { probe.close(); }
    } finally {
      teardown(open);
    }
  });
});
