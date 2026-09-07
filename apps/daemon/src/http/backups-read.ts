/**
 * BACKUPS, OVER HTTP: POST `/backups/read` answers the one question an operator asks about a
 * backup before they need it - has this artifact been PROVEN restorable, was the proof FAILED,
 * or has NOBODY CHECKED IT YET.
 *
 * THREE VALUES, NEVER TWO. `NOT_CHECKED` is a real and common state: writing a backup is cheap
 * and restore-checking one is not, so a backup routinely exists with no proof behind it. A
 * surface that rendered that as "proven" would be believed at exactly the moment it must not be,
 * so `restoreProof` travels VERBATIM off the durable record and this module derives nothing.
 * There is no default, no `??` and no fallback anywhere below - the value a caller sees is the
 * value the record holds, or a refusal.
 *
 * THE PROJECTION IS DELIBERATELY NARROW (epic rail 3). Per backup it carries the artifact's
 * BASENAME, the state, the digest and when the state was last determined. It never carries the
 * directory that basename lives in, a database url, or anything a credential could hide in; the
 * record module already refuses to store a ref outside the `<17 digits>.<sqlite|sql>` shape, so
 * a connection string cannot reach this frame even by way of a corrupted row. `environment` is
 * carried because a cross-environment list is unreadable without it, and it is the same
 * environment name `/deployments/health/read` and `/environments/read` already serve.
 *
 * NO NEW LAYER LITERAL (task rail 4): the one refusal this module mints reuses the rostered
 * `CONTROL_ROOM_LISTENER_LAYER`. The store's own refusals travel verbatim with their own code
 * and their own `DAEMON_INGRESS` layer, so a client can tell which layer answered.
 *
 * ADMIN, not GOAL. Backups are infrastructure rather than the product a goal produced, and the
 * closest sibling on this listener - `/environments/read`, whose answer is also secret-adjacent
 * - fences on the same capability. The stricter fence is the fail-closed direction.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { admitBackupRef } from "../backups/backup-restore-proof.js";
import type {
  BackupRestoreProofRecord, BackupRestoreProofResult, BackupRestoreProofState,
} from "../backups/backup-restore-proof.js";
import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener-guards.js";

export const BACKUPS_READ_PATH = "/backups/read" as const;

export const BACKUPS_READ_CODES = Object.freeze([
  "BACKUPS_READ_CAPABILITY_DENIED",
  "BACKUPS_READ_RECORD_INVALID",
] as const);

export interface BackupsReadRefused {
  readonly code: (typeof BACKUPS_READ_CODES)[number];
  readonly layer: typeof CONTROL_ROOM_LISTENER_LAYER;
  readonly outcome: "REFUSED";
}

/**
 * One backup, as an operator reads it. `restoreProof` is REQUIRED and copied from the record;
 * `sha256` and `checkedAt` are null EXACTLY when the record holds no digest and no instant -
 * never "" and never 0, so a consumer cannot mistake "absent" for "empty".
 */
export interface BackupsReadEntry {
  readonly checkedAt: string | null;
  readonly environment: string;
  /** The artifact's basename only. Never the directory it lives in. */
  readonly ref: string;
  readonly restoreProof: BackupRestoreProofState;
  readonly sha256: string | null;
}

export interface BackupsReadView {
  /** Newest artifact first within each environment, in the order the record store returns. */
  readonly backups: readonly BackupsReadEntry[];
  readonly ok: true;
}

/**
 * The DURABLE MATERIAL this route projects. Closed over one sidecar and one project by the
 * composition sibling; this module opens nothing and knows no path. A port that answered a
 * summary would move the "is it proven" decision out of the served path.
 */
export interface BackupsReadPort {
  read(): BackupRestoreProofResult<readonly BackupRestoreProofRecord[]>;
}

const refused = (
  code: (typeof BACKUPS_READ_CODES)[number],
): BackupsReadRefused => Object.freeze({
  code, layer: CONTROL_ROOM_LISTENER_LAYER, outcome: "REFUSED" as const,
});

/**
 * Two request codes rather than one. A caller that named a key this route does not serve made a
 * different mistake from one that sent bytes this route cannot decode, and a single generic
 * code would leave them indistinguishable.
 */
export type BackupsReadBodyCode =
  | "LISTENER_BACKUPS_REQUEST_INVALID"
  | "LISTENER_BACKUPS_UNKNOWN_KEY";

export type BackupsReadBody =
  | Readonly<{ readonly ok: true }>
  | Readonly<{ readonly code: BackupsReadBodyCode; readonly ok: false }>;

const badBody = (code: BackupsReadBodyCode): BackupsReadBody =>
  Object.freeze({ code, ok: false as const });

/**
 * Own enumerable keys are EXACTLY NONE. The project is the AUTHENTICATED PRINCIPAL'S, bound at
 * the composition root, so a payload naming `projectId` - or an `environment` filter this route
 * does not honour - is an unknown key rather than a silently ignored one. A silently ignored
 * filter is how a caller comes to believe it is looking at one environment's backups while it
 * is looking at every environment's.
 */
export function backupsReadBodyOf(body: unknown): BackupsReadBody {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return badBody("LISTENER_BACKUPS_REQUEST_INVALID");
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return badBody("LISTENER_BACKUPS_REQUEST_INVALID");
  }
  if (Object.keys(value as Record<string, unknown>).length !== 0) {
    return badBody("LISTENER_BACKUPS_UNKNOWN_KEY");
  }
  return Object.freeze({ ok: true as const });
}

/**
 * DEFENCE IN DEPTH AT THE SERVED SEAM (epic rail 3). The record store already refuses to WRITE
 * a ref outside the `<17 digits>.<sqlite|sql>` basename shape and refuses to READ a row that
 * does not decode, so a directory or a connection string cannot reach here through it. This
 * guard makes that hold for ANY port wired to this route, not only that one: a record whose ref
 * or environment is not admissible refuses the whole read rather than serving it. Refusing the
 * WHOLE read rather than filtering the row out is deliberate - a silently shorter list reads as
 * "these are all the backups", which is the same class of lie as a false PROVEN.
 */
export function admissibleBackups(records: readonly BackupRestoreProofRecord[]): boolean {
  return records.every((record) =>
    admitBackupRef(record.ref) !== null && admitEnvironmentName(record.environment) !== null);
}

/**
 * Projection only. Every member below is read straight off a durable record - in particular
 * `restoreProof`, which is copied and never mapped, defaulted or re-derived. `kind` and the
 * record's schema version are dropped: neither is something an operator acts on, and a frame
 * carries what it is read for.
 */
export function projectBackups(
  records: readonly BackupRestoreProofRecord[],
): BackupsReadView {
  return Object.freeze({
    backups: Object.freeze(records.map((record) => Object.freeze({
      checkedAt: record.checkedAt,
      environment: record.environment,
      ref: record.ref,
      restoreProof: record.restoreProof,
      sha256: record.sha256,
    }))),
    ok: true as const,
  });
}

export type BackupsReadDispatch =
  | {
    readonly body: BackupsReadView | BackupsReadRefused | HttpPortRefused | HttpRefused
      | Extract<BackupRestoreProofResult<never>, { readonly ok: false }>;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: BackupsReadBodyCode | "LISTENER_BACKUPS_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handleBackupsReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly backupReads?: BackupsReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): BackupsReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.ADMIN)) {
    return Object.freeze({
      body: refused("BACKUPS_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.backupReads;
  // ABSENT PORT REFUSES, and never answers a default. A daemon composed without this port has
  // seen no backup at all; an empty list would read as "no backups exist" and a proven-looking
  // frame would be worse still, so the one honest answer is that the surface is unavailable.
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_BACKUPS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = backupsReadBodyOf(request.body);
  if (!decoded.ok) return Object.freeze({ code: decoded.code, kind: "LISTENER_REFUSAL" });
  const records = port.read();
  // The store's own refusal travels VERBATIM with its code and its DAEMON_INGRESS layer.
  // Reshaping it here is where a backup list nobody could read would turn into an empty one.
  if (!records.ok) return Object.freeze({ body: records, httpStatus: 200, kind: "REPLY" });
  if (!admissibleBackups(records.value)) {
    return Object.freeze({
      body: refused("BACKUPS_READ_RECORD_INVALID"), httpStatus: 200, kind: "REPLY",
    });
  }
  return Object.freeze({ body: projectBackups(records.value), httpStatus: 200, kind: "REPLY" });
}
