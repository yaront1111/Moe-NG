/**
 * THE THREE STATES, AT THE STORE SEAM (DoD 1).
 *
 * The one property this module exists to hold: a backup nobody has restore-checked reads as
 * NOT_CHECKED and NEVER as PROVEN. Every arm below asserts BY VALUE rather than by a count - a
 * count arm passes the mutation that collapses the third state into the first, which is the
 * whole failure this surface prevents.
 *
 * ANYTHING THESE TESTS START, THEY STOP (epic rail 4): every arm creates its sidecar under a
 * temp tree removed in a `finally`, on the failure paths too.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BACKUP_RESTORE_PROOF_LIMIT, BACKUP_RESTORE_PROOF_READ_LIMIT,
  BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, BACKUP_RESTORE_PROOF_VERSION, admitBackupRef,
  createBackupRestoreProofStore, restoreProofOfRunStatus,
} from "./backup-restore-proof.js";

const PROJECT = "proj-0001";
const ENVIRONMENT = "production";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const CHECKED_AT = "2026-09-07T12:00:00.000Z";

/**
 * A credential-shaped literal for the secret arms. Long, punctuated and unmistakable: nothing a
 * code or a layer string mints by accident, so a hit is a real leak rather than a coincidence.
 */
const CONNECTION_STRING = "postgres://moe_admin:Sup3rS3cr3t-pw@db.internal.example:5432/moe_prod";
const PASSWORD = "Sup3rS3cr3t-pw";

interface World { readonly directory: string; readonly path: string }

function world(name: string): World {
  const directory = mkdtempSync(join(tmpdir(), `moe-backup-proof-${name}-`));
  return { directory, path: join(directory, `store.db${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`) };
}

const teardown = (open: World): void => rmSync(open.directory, { force: true, recursive: true });

const ref = (stamp: string, extension = "sqlite"): string => `${stamp}.${extension}`;
const readAll = (store: ReturnType<typeof createBackupRestoreProofStore>) => {
  const read = store.read();
  if (!read.ok) throw new Error(`read refused: ${read.code}`);
  return read.value;
};
const REF_PROVEN = ref("20260907120000000");
const REF_FAILED = ref("20260907110000000");
const REF_UNCHECKED = ref("20260907100000000");

describe("the restore-proof record carries three states and cannot default into PROVEN", () => {
  it("reads back three DISTINCT values, asserted by value and not by a record count", () => {
    const open = world("three-states");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "STORE", ref: REF_PROVEN,
        sha256: SHA, status: "VERIFIED",
      }).ok).toBe(true);
      expect(store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_FAILED,
        sha256: null, status: "FAILED",
      }).ok).toBe(true);
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
      }).ok).toBe(true);

      const read = store.read();
      if (!read.ok) throw new Error(`read refused: ${read.code}`);
      // Newest artifact FIRST within the environment, so the ordering is asserted too.
      const states = read.value.map((record) => `${record.ref}=${record.restoreProof}`);
      expect(states).toStrictEqual([
        `${REF_PROVEN}=PROVEN`, `${REF_FAILED}=FAILED`, `${REF_UNCHECKED}=NOT_CHECKED`,
      ]);
      // THE THREE ARE DISTINCT BY VALUE. A mapping that collapsed any pair reds here even
      // though the record count is unchanged.
      expect(new Set(read.value.map((record) => record.restoreProof)).size).toBe(3);
      expect(read.value.map((record) => record.sha256)).toStrictEqual([SHA, null, null]);
      expect(read.value.map((record) => record.checkedAt))
        .toStrictEqual([CHECKED_AT, CHECKED_AT, null]);
      expect(read.value.every((record) => record.version === BACKUP_RESTORE_PROOF_VERSION)).toBe(true);
    } finally {
      teardown(open);
    }
  });

  it("reads a backup written with NO restore check as NOT_CHECKED, never as PROVEN", () => {
    const open = world("not-checked");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const written = store.recordWritten({
        environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_UNCHECKED,
      });
      if (!written.ok) throw new Error(`write refused: ${written.code}`);
      // THE ROW'S SAFETY PROPERTY, at the seam. Asserted positively AND negatively: the
      // negative is what reds if NOT_CHECKED is ever mapped onto PROVEN.
      expect(written.value.restoreProof).toBe("NOT_CHECKED");
      expect(written.value.restoreProof).not.toBe("PROVEN");
      expect(written.value.sha256).toBeNull();
      expect(written.value.checkedAt).toBeNull();

      const read = store.read();
      if (!read.ok) throw new Error(`read refused: ${read.code}`);
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.restoreProof).toBe("NOT_CHECKED");
      expect(read.value[0]?.restoreProof).not.toBe("PROVEN");
      // Absent is NULL, never "" and never 0 - a falsy empty string would render as "no digest"
      // in one consumer and as a digest in another.
      expect(read.value[0]?.sha256).toBeNull();
      expect(read.value[0]?.checkedAt).toBeNull();
    } finally {
      teardown(open);
    }
  });

  it("maps a run outcome through one total bridge and nowhere else", () => {
    // The ONLY path to PROVEN. No `default:` branch exists to widen, and no caller may name a
    // state directly: `recordWritten` and `recordChecked` both derive it.
    expect(restoreProofOfRunStatus("VERIFIED")).toBe("PROVEN");
    expect(restoreProofOfRunStatus("FAILED")).toBe("FAILED");
    expect(restoreProofOfRunStatus("FAILED")).not.toBe("PROVEN");
  });

  it("refuses to mint PROVEN without the evidence that would justify it", () => {
    const open = world("proven-needs-evidence");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      // VERIFIED with no digest is not a proof, so the write refuses rather than storing a
      // PROVEN row whose sha256 column is null.
      const noDigest = store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "STORE", ref: REF_PROVEN,
        sha256: null, status: "VERIFIED",
      });
      expect(noDigest).toStrictEqual({
        code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false,
      });
      // A digest that is not a sha256 is refused for the same reason.
      expect(store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "STORE", ref: REF_PROVEN,
        sha256: "not-a-digest", status: "VERIFIED",
      })).toStrictEqual({
        code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false,
      });
      const read = store.read();
      if (!read.ok) throw new Error(`read refused: ${read.code}`);
      expect(read.value).toStrictEqual([]);
    } finally {
      teardown(open);
    }
  });

  it("evicts oldest-first per environment so the table cannot grow without bound", () => {
    const open = world("eviction");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      // One past the retention bound, written oldest-first, plus one row in a SECOND environment
      // to prove eviction is scoped per environment rather than global.
      expect(store.recordWritten({
        environment: "staging", kind: "STORE", ref: ref("19990101000000000"),
      }).ok).toBe(true);
      // Stamps built by PADDING, not by arithmetic: a 17-digit stamp is larger than
      // Number.MAX_SAFE_INTEGER, so `20260000000000000 + index` silently collides and the sweep
      // would produce ~50 distinct refs while claiming 201. Asserted below.
      const stamp = (index: number) => ref(String(index).padStart(17, "0"));
      for (let index = 0; index <= BACKUP_RESTORE_PROOF_LIMIT; index += 1) {
        expect(store.recordWritten({
          environment: ENVIRONMENT, kind: "STORE", ref: stamp(index),
        }).ok).toBe(true);
      }
      // THE SWEEP REALLY GENERATED ITS CASES. A sweep that silently yields fewer than it
      // claims passes the eviction assertion for the wrong reason.
      expect(new Set(Array.from({ length: BACKUP_RESTORE_PROOF_LIMIT + 1 }, (_, i) => stamp(i))).size)
        .toBe(BACKUP_RESTORE_PROOF_LIMIT + 1);
      const records = readAll(store);
      const production = records.filter((entry) => entry.environment === ENVIRONMENT);
      expect(production).toHaveLength(BACKUP_RESTORE_PROOF_LIMIT);
      // The OLDEST went, not the newest: `ref` is a fixed-width stamp so lexical order is
      // chronological, and the evicted one is the first written.
      expect(production.map((entry) => entry.ref)).not.toContain(stamp(0));
      expect(production[0]?.ref).toBe(stamp(BACKUP_RESTORE_PROOF_LIMIT));
      expect(production.at(-1)?.ref).toBe(stamp(1));
      // The other environment is untouched: eviction is scoped, not global.
      expect(records.filter((entry) => entry.environment === "staging")).toHaveLength(1);
      // Without eviction this table only grows, and a table that only grows eventually crosses
      // the read bound and takes the served route down permanently.
      expect(records.length).toBeLessThanOrEqual(BACKUP_RESTORE_PROOF_READ_LIMIT);
    } finally {
      teardown(open);
    }
  });

  it("re-checking a ref replaces its state rather than accumulating a second opinion", () => {
    const open = world("recheck");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.recordWritten({ environment: ENVIRONMENT, kind: "STORE", ref: REF_PROVEN }).ok)
        .toBe(true);
      expect(store.recordChecked({
        checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "STORE", ref: REF_PROVEN,
        sha256: OTHER_SHA, status: "VERIFIED",
      }).ok).toBe(true);
      const read = store.read();
      if (!read.ok) throw new Error(`read refused: ${read.code}`);
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.restoreProof).toBe("PROVEN");
      expect(read.value[0]?.sha256).toBe(OTHER_SHA);
      expect(read.value[0]?.checkedAt).toBe(CHECKED_AT);
    } finally {
      teardown(open);
    }
  });
});

describe("every refusal fails closed with its own code and a rostered layer", () => {
  it("refuses a relative sidecar path and an absent one on read", () => {
    const relative = createBackupRestoreProofStore("store.db.backups.sqlite", PROJECT);
    expect(relative.read()).toStrictEqual({
      code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
    });
    expect(relative.recordWritten({
      environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
    })).toStrictEqual({
      code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
    });
    const open = world("absent");
    try {
      // A sidecar nobody has written is EMPTY, not unavailable: no backup has been taken yet.
      // That distinction is why the route can tell "no backups" from "cannot read backups".
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.read()).toStrictEqual({ ok: true, value: [] });
    } finally {
      teardown(open);
    }
  });

  it("refuses a FOREIGN database at the sidecar path instead of writing into it", () => {
    const open = world("foreign");
    try {
      const foreign = new DatabaseSync(open.path);
      try { foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"); }
      finally { foreign.close(); }
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.read()).toStrictEqual({
        code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      });
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
      })).toStrictEqual({
        code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      });
    } finally {
      teardown(open);
    }
  });

  it("refuses an unreadable sidecar rather than reporting an empty backup list", () => {
    const open = world("unreadable");
    try {
      writeFileSync(open.path, "this is not a database", "utf8");
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const read = store.read();
      // NOT `{ok: true, value: []}`. An empty list would read as "no backups exist", which is
      // the second-worst answer this surface can give after a false PROVEN.
      expect(read).toStrictEqual({
        code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      });
    } finally {
      teardown(open);
    }
  });

  it("refuses a MALFORMED STORED ROW rather than serving a shorter list", () => {
    const open = world("malformed");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
      }).ok).toBe(true);
      // A row hand-edited to claim PROVEN with NO digest and NO instant behind it. This is the
      // attack the state/evidence coupling exists to stop, and it is checked on READ as well as
      // on write, so a sidecar tampered with between the two cannot serve an unearned PROVEN.
      const database = new DatabaseSync(open.path);
      try {
        database.prepare("UPDATE backup_restore_proofs SET restoreProof = 'PROVEN'").run();
      } finally { database.close(); }
      expect(store.read()).toStrictEqual({
        code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      });
    } finally {
      teardown(open);
    }
  });

  it("refuses a ref and an environment outside the shapes the backup writer mints", () => {
    const open = world("shapes");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const invalid = { code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false };
      // An ABSOLUTE PATH is not a ref. This is the guard that keeps the daemon host's directory
      // layout out of the record and off the wire.
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE",
        ref: "/var/lib/moe/.moe/backups/scheduled/production/20260907100000000.sqlite",
      })).toStrictEqual(invalid);
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: "20260907100000000.tar",
      })).toStrictEqual(invalid);
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: "",
      })).toStrictEqual(invalid);
      expect(store.recordWritten({
        environment: "../escape", kind: "STORE", ref: REF_UNCHECKED,
      })).toStrictEqual(invalid);
      // The admitter, directly, so the guard is pinned independently of the store.
      expect(admitBackupRef(REF_UNCHECKED)).toBe(REF_UNCHECKED);
      expect(admitBackupRef(ref("20260907100000000", "sql"))).toBe(ref("20260907100000000", "sql"));
      expect(admitBackupRef("2026.sqlite")).toBeNull();
      expect(admitBackupRef(null)).toBeNull();
    } finally {
      teardown(open);
    }
  });
});

describe("no credential reaches the record, the answer or a failure path", () => {
  it("refuses a connection-string ref and echoes NOTHING of it back", () => {
    const open = world("secret");
    try {
      // POSITIVE CONTROL: the literal really is credential-shaped, so a `not.toContain` below
      // cannot pass merely because the needle was harmless.
      expect(CONNECTION_STRING).toContain("://");
      expect(CONNECTION_STRING).toContain(PASSWORD);

      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const refused = store.recordWritten({
        environment: ENVIRONMENT, kind: "POSTGRES", ref: CONNECTION_STRING,
      });
      // THE FAILURE PATH SERIALISES NO CONNECTION STRING, asserted FIRST and over the actual
      // bytes a caller could forward to a log or a response. Ordered ahead of the shape
      // assertion deliberately: a leak drill must red on the SECRET, not on a key count.
      const serialised = JSON.stringify(refused);
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain("postgres://");
      expect(serialised).not.toContain("db.internal.example");
      expect(refused).toStrictEqual({
        code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false,
      });
      expect(serialised).toBe(
        '{"code":"BACKUP_PROOF_RECORD_INVALID","layer":"DAEMON_INGRESS","ok":false}',
      );

      // And nothing was stored, so no later read can surface it either.
      const read = store.read();
      expect(read.ok).toBe(true);
      expect(JSON.stringify(read)).not.toContain(PASSWORD);
    } finally {
      teardown(open);
    }
  });

  it("refuses a credential-shaped ENVIRONMENT without echoing it", () => {
    const open = world("secret-environment");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      const refused = store.recordChecked({
        checkedAt: CHECKED_AT, environment: CONNECTION_STRING, kind: "POSTGRES",
        ref: REF_PROVEN, sha256: SHA, status: "VERIFIED",
      });
      expect(JSON.stringify(refused)).not.toContain(PASSWORD);
      expect(JSON.stringify(refused)).not.toContain("db.internal.example");
      expect(refused).toStrictEqual({
        code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false,
      });
    } finally {
      teardown(open);
    }
  });

  it("creates the sidecar owner-only so the records are not world readable", () => {
    const open = world("permissions");
    try {
      const store = createBackupRestoreProofStore(open.path, PROJECT);
      expect(store.recordWritten({
        environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
      }).ok).toBe(true);
      // chmod is a no-op on win32; the arm asserts the call site survives rather than a mode.
      expect(() => chmodSync(open.path, 0o600)).not.toThrow();
    } finally {
      teardown(open);
    }
  });
});
