/**
 * THE RESTORE-PROOF RECORD: a durable, per-backup answer to "has this backup been PROVEN
 * restorable", in THREE states, keyed by (project, environment, ref).
 *
 * WHY A NEW VOCABULARY RATHER THAN A WIDENED `ScheduledBackupResult.status`. That field is the
 * backup RUN's own outcome (`VERIFIED | FAILED`) and belongs to the row that landed it; it
 * answers "did this run finish", which is a different question from "is this artifact known to
 * restore". One field answering two questions is exactly how the two collapse. So the record
 * carries its own `restoreProof`, and `restoreProofOfRunStatus` is the ONLY bridge between them.
 *
 * NOT_CHECKED MUST NEVER READ AS PROVEN. A backup that was WRITTEN but whose restore check has
 * not run is a real and common state - the write is cheap, the check is not - and an operator
 * leans on the difference at the worst possible moment. Three mechanisms keep the collapse
 * unreachable rather than merely discouraged:
 *   1. `restoreProof` is REQUIRED on the type. An optional field is one `?? "PROVEN"` away.
 *   2. `restoreProofOfRunStatus` is an EXHAUSTIVE SWITCH with no `default:` and no `??`/`||`.
 *      A widened run status becomes a TYPE ERROR at the call site, never a silent PROVEN.
 *   3. `proofShapeOf` enforces the state/evidence coupling in BOTH directions on write AND on
 *      read: PROVEN without a sha256 and a checkedAt is not a record, it is a refusal. A row
 *      hand-edited into the sidecar cannot claim PROVEN with no evidence behind it.
 *
 * NO SECRET AND NO HOST PATH REACHES THIS RECORD (epic rail 3). `ref` is admitted to the EXACT
 * `<17 digits>.<sqlite|sql>` basename that the backup writer mints - never the absolute path it
 * joins that onto. A connection string, a credential or a directory cannot satisfy that shape,
 * so they cannot be stored, cannot be served, and cannot be echoed: the refusal carries a code
 * and a rostered layer and nothing of the input.
 *
 * The sidecar is the SAME shape as the health-probe ring's: per-operation connections owning no
 * shutdown handle, an application id and a user version, and a `sqlite_master` name check, so a
 * foreign database at this path refuses instead of being written into.
 */
import { chmodSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";

export const BACKUP_RESTORE_PROOF_VERSION = "moe-backup-restore-proof/1" as const;
/** Appended to the event store's own database path, so the writer and the reader cannot come to
 * disagree about which file the records live in. Same discipline as the probe ring's sidecar. */
export const BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX = ".backups.sqlite" as const;
/**
 * How many records are RETAINED PER ENVIRONMENT. The rows are evicted oldest-first on write,
 * mirroring the artifact retention the backup writer already applies to the files themselves -
 * without it the table only ever grows, and a table that only grows eventually crosses the read
 * bound below and takes the route down permanently. 200 daily backups is over six months of
 * history, which is longer than any artifact survives on disk.
 */
export const BACKUP_RESTORE_PROOF_LIMIT = 200;

/**
 * An absolute bound on one read. Eviction keeps a healthy sidecar far below it (it would take a
 * hundred environments to reach), so this is a CORRUPTION guard rather than an operational one:
 * a sidecar carrying more rows than eviction can produce is not one to serve from. Exceeding it
 * REFUSES rather than truncating - a silently short list reads as "these are all the backups".
 */
export const BACKUP_RESTORE_PROOF_READ_LIMIT = 20_000;

/** Proven restorable / proven NOT restorable / nobody has checked. Never two values. */
export type BackupRestoreProofState = "PROVEN" | "FAILED" | "NOT_CHECKED";

/** The backup RUN's outcome, declared HERE rather than imported from `scheduled-backup.ts`, so
 * this module stays a leaf and the widening becomes an error at the CALL SITE where it belongs. */
export type BackupRunStatus = "VERIFIED" | "FAILED";

export type BackupRestoreProofCode =
  | "BACKUP_PROOF_RECORD_INVALID"
  | "BACKUP_PROOF_STORE_UNAVAILABLE";

/** Reuses the rostered `DAEMON_INGRESS` layer; this module mints no new layer literal. */
export interface BackupRestoreProofRefusal {
  readonly ok: false;
  readonly code: BackupRestoreProofCode;
  readonly layer: "DAEMON_INGRESS";
}

export type BackupRestoreProofResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | BackupRestoreProofRefusal;

export interface BackupRestoreProofRecord {
  readonly version: typeof BACKUP_RESTORE_PROOF_VERSION;
  readonly environment: string;
  readonly kind: "STORE" | "POSTGRES";
  /** The artifact's basename ONLY - never the directory it lives in. */
  readonly ref: string;
  readonly restoreProof: BackupRestoreProofState;
  /** The verified digest, or null. Null EXACTLY when there is no proof - never "" and never 0. */
  readonly sha256: string | null;
  /** When the restore check last ran, or null when it has not. */
  readonly checkedAt: string | null;
}

const APPLICATION_ID = 0x4d425031;
const BACKUP_REF = /^\d{17}\.(?:sqlite|sql)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TABLES = ["backup_restore_proof_scope", "backup_restore_proofs"] as const;

const refusal = (code: BackupRestoreProofCode): BackupRestoreProofRefusal =>
  Object.freeze({ code, layer: "DAEMON_INGRESS" as const, ok: false as const });

/**
 * The artifact basename, admitted to the exact shape the backup writer mints. This is the guard
 * that keeps an absolute host path - and anything credential-shaped, which can never match 17
 * digits and a known extension - out of the record, the frame and every log line downstream.
 */
export function admitBackupRef(value: unknown): string | null {
  return typeof value === "string" && BACKUP_REF.test(value) ? value : null;
}

/**
 * THE ONLY BRIDGE from a run outcome to a proof state, and the reason a fourth run status can
 * never arrive here silently: an exhaustive switch with NO `default:` branch and no `??`/`||`
 * fallback. Widening `BackupRunStatus` makes this function fail to compile.
 */
export function restoreProofOfRunStatus(status: BackupRunStatus): BackupRestoreProofState {
  switch (status) {
    case "VERIFIED": return "PROVEN";
    case "FAILED": return "FAILED";
  }
}

/**
 * The state/evidence coupling, enforced in BOTH directions so neither half can drift:
 * PROVEN needs a digest AND an instant, NOT_CHECKED needs NEITHER, and FAILED needs the instant
 * the check ran but may have no digest (the write itself can be what failed). Applied on write
 * and again on read, so a row edited into the sidecar by hand cannot claim an unearned PROVEN.
 */
function proofShapeOf(
  restoreProof: BackupRestoreProofState, sha256: string | null, checkedAt: string | null,
): boolean {
  if (sha256 !== null && !SHA256.test(sha256)) return false;
  if (checkedAt !== null && !Number.isFinite(Date.parse(checkedAt))) return false;
  if (restoreProof === "PROVEN") return sha256 !== null && checkedAt !== null;
  if (restoreProof === "NOT_CHECKED") return sha256 === null && checkedAt === null;
  return checkedAt !== null;
}

function recordOf(value: unknown): BackupRestoreProofRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const environment = admitEnvironmentName(row["environment"]);
  const ref = admitBackupRef(row["ref"]);
  const { kind, restoreProof, sha256, checkedAt, version } = row;
  if (version !== BACKUP_RESTORE_PROOF_VERSION || environment === null || ref === null) return null;
  if (kind !== "STORE" && kind !== "POSTGRES") return null;
  if (restoreProof !== "PROVEN" && restoreProof !== "FAILED" && restoreProof !== "NOT_CHECKED") return null;
  if (sha256 !== null && typeof sha256 !== "string") return null;
  if (checkedAt !== null && typeof checkedAt !== "string") return null;
  if (!proofShapeOf(restoreProof, sha256, checkedAt)) return null;
  return Object.freeze({
    checkedAt, environment, kind, ref, restoreProof, sha256, version: BACKUP_RESTORE_PROOF_VERSION,
  });
}

function initialize(database: DatabaseSync, create: boolean): void {
  const app = database.prepare("PRAGMA application_id").get()?.["application_id"];
  const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
  const empty = database.prepare("SELECT name FROM sqlite_master").all().length === 0;
  if (create && app === 0 && version === 0 && empty) {
    // Identity is a NAMED UNIQUE INDEX rather than a table-level composite PRIMARY KEY: sqlite
    // materialises the latter as an `sqlite_autoindex_...` entry, and the name check below
    // compares the whole of `sqlite_master`, so an implicit name would make the guard depend on
    // an sqlite implementation detail rather than on this schema.
    database.exec(`CREATE TABLE backup_restore_proofs (
      project_id TEXT NOT NULL, environment TEXT NOT NULL, ref TEXT NOT NULL,
      version TEXT NOT NULL, kind TEXT NOT NULL, restoreProof TEXT NOT NULL,
      sha256 TEXT, checkedAt TEXT
    ); CREATE UNIQUE INDEX backup_restore_proof_scope
      ON backup_restore_proofs(project_id, environment, ref);
    PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
  } else if (app !== APPLICATION_ID || version !== 1) throw new Error("BACKUP_PROOF_STORE_UNAVAILABLE");
  const names = database.prepare("SELECT name FROM sqlite_master ORDER BY name").all()
    .map((row) => row["name"]);
  if (names.join("\n") !== TABLES.join("\n")) throw new Error("BACKUP_PROOF_STORE_UNAVAILABLE");
}

function access<T>(
  path: string, operation: (database: DatabaseSync) => T, create = false,
): BackupRestoreProofResult<T> {
  let database: DatabaseSync | null = null;
  let transaction = false;
  try {
    if (!isAbsolute(path)) return refusal("BACKUP_PROOF_STORE_UNAVAILABLE");
    const existed = existsSync(path);
    if (!existed && !create) return refusal("BACKUP_PROOF_STORE_UNAVAILABLE");
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    transaction = true;
    initialize(database, create && !existed);
    if (!existed) chmodSync(path, 0o600);
    const value = operation(database);
    database.exec("COMMIT"); transaction = false;
    return Object.freeze({ ok: true as const, value });
  } catch { return refusal("BACKUP_PROOF_STORE_UNAVAILABLE"); }
  finally {
    if (database !== null) {
      if (transaction) { try { database.exec("ROLLBACK"); } catch { /* No success is returned. */ } }
      database.close();
    }
  }
}

/** The material a caller hands in. `restoreProof` is DERIVED here, never supplied, so no caller
 * can name PROVEN directly - the only way to reach it is a run that actually VERIFIED. */
export interface BackupProofWrite {
  readonly environment: string;
  readonly kind: "STORE" | "POSTGRES";
  readonly ref: string;
}

export interface BackupCheckedWrite extends BackupProofWrite {
  readonly checkedAt: string;
  readonly sha256: string | null;
  readonly status: BackupRunStatus;
}

export interface BackupRestoreProofStore {
  /** A backup that was WRITTEN and NOT yet restore-checked. Always NOT_CHECKED, never PROVEN. */
  recordWritten(input: BackupProofWrite): BackupRestoreProofResult<BackupRestoreProofRecord>;
  /** A backup whose restore check HAS run, mapped through the exhaustive bridge above. */
  recordChecked(input: BackupCheckedWrite): BackupRestoreProofResult<BackupRestoreProofRecord>;
  /** Every record for this project, newest artifact first within each environment. */
  read(): BackupRestoreProofResult<readonly BackupRestoreProofRecord[]>;
}

function upsert(
  path: string, projectId: string, candidate: BackupRestoreProofRecord,
): BackupRestoreProofResult<BackupRestoreProofRecord> {
  return access(path, (database) => {
    database.prepare(`INSERT INTO backup_restore_proofs
      (project_id, environment, ref, version, kind, restoreProof, sha256, checkedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, environment, ref) DO UPDATE SET
      version = excluded.version, kind = excluded.kind, restoreProof = excluded.restoreProof,
      sha256 = excluded.sha256, checkedAt = excluded.checkedAt`)
      .run(projectId, candidate.environment, candidate.ref, candidate.version, candidate.kind,
        candidate.restoreProof, candidate.sha256, candidate.checkedAt);
    // EVICT OLDEST-FIRST, in the same transaction as the insert. `ref` is a fixed-width
    // timestamp basename, so lexical DESC IS newest-first and needs no clock.
    database.prepare(`DELETE FROM backup_restore_proofs WHERE project_id = ? AND environment = ?
      AND ref NOT IN (SELECT ref FROM backup_restore_proofs WHERE project_id = ? AND environment = ?
      ORDER BY ref DESC LIMIT ?)`)
      .run(projectId, candidate.environment, projectId, candidate.environment,
        BACKUP_RESTORE_PROOF_LIMIT);
    return candidate;
  }, true);
}

/** Bound to ONE sidecar and ONE project by the composition root; never to request input. */
export function createBackupRestoreProofStore(
  path: string, projectId: string,
): BackupRestoreProofStore {
  const build = (
    input: BackupProofWrite, restoreProof: BackupRestoreProofState,
    sha256: string | null, checkedAt: string | null,
  ): BackupRestoreProofResult<BackupRestoreProofRecord> => {
    const candidate = recordOf({
      checkedAt, environment: input.environment, kind: input.kind, ref: input.ref, restoreProof,
      sha256, version: BACKUP_RESTORE_PROOF_VERSION,
    });
    if (candidate === null) return refusal("BACKUP_PROOF_RECORD_INVALID");
    return upsert(path, projectId, candidate);
  };
  return Object.freeze({
    read(): BackupRestoreProofResult<readonly BackupRestoreProofRecord[]> {
      if (!isAbsolute(path)) return refusal("BACKUP_PROOF_STORE_UNAVAILABLE");
      // A sidecar nobody has written yet is EMPTY, not unavailable: no backup has been taken.
      if (!existsSync(path)) return Object.freeze({ ok: true as const, value: Object.freeze([]) });
      return access(path, (database) => {
        const rows = database.prepare(`SELECT environment, ref, version, kind, restoreProof,
          sha256, checkedAt FROM backup_restore_proofs WHERE project_id = ?
          ORDER BY environment ASC, ref DESC`).all(projectId);
        if (rows.length > BACKUP_RESTORE_PROOF_READ_LIMIT) {
          throw new Error("BACKUP_PROOF_STORE_UNAVAILABLE");
        }
        return Object.freeze(rows.map((row) => {
          const record = recordOf(row);
          // A stored row that does not decode REFUSES the whole read. Skipping it would serve a
          // shorter list that reads as "these are all the backups".
          if (record === null) throw new Error("BACKUP_PROOF_STORE_UNAVAILABLE");
          return record;
        }));
      });
    },
    recordChecked(input: BackupCheckedWrite) {
      return build(input, restoreProofOfRunStatus(input.status), input.sha256, input.checkedAt);
    },
    recordWritten(input: BackupProofWrite) {
      return build(input, "NOT_CHECKED", null, null);
    },
  });
}
