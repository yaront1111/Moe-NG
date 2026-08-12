import { createHash } from "node:crypto";

import type { RuntimeError } from "@moe/contracts";
import type { ProjectEvent, ProjectState } from "@moe/core";
import type { RecoveryBindingSlot } from "@moe/store";

export const RESTORE_CONTROLLER_LAYER = "DAEMON_RESTORE_CONTROLLER" as const;
export const RESTORE_CONTROLLER_SCHEMA_VERSION = "moe-restore-controller/1" as const;
export const RESTORE_BINDING_SLOT: RecoveryBindingSlot = "ACTIVE";

export const RESTORE_REFUSAL_LAYERS = Object.freeze([
  "BACKUP_GENERATION",
  "DAEMON_RESTORE_CONTROLLER",
  "DURABLE_STORE",
  "PROJECT_REDUCER",
  "RECOVERY_BINDING_CODEC",
  "RECOVERY_INSTALL_TRANSACTION",
  "RECOVERY_SUCCESSION",
] as const);
export type RestoreRefusalLayer = (typeof RESTORE_REFUSAL_LAYERS)[number];

export const RESTORE_CONTROLLER_REASON_CODES = Object.freeze([
  "RESTORE_ALREADY_SETTLED",
  "RESTORE_COMMAND_NOT_BOUND",
  "RESTORE_FENCE_REPLAYED",
  "RESTORE_GENERATION_NOT_BOUND",
  "RESTORE_INCARNATION_UNANCHORED",
  "RESTORE_INTERRUPTED",
  "RESTORE_KEY_EPOCH_MISMATCH",
  "RESTORE_RECORD_UNREADABLE",
  "RESTORE_REQUEST_SHAPE_INVALID",
] as const);
export type RestoreControllerReasonCode = (typeof RESTORE_CONTROLLER_REASON_CODES)[number];

export const RESTORE_CONTROLLER_FAULT_POINTS = Object.freeze([
  "AFTER_REDUCER_BEFORE_COMMIT",
  "INSIDE_COMMIT_APPLY",
] as const);
export type RestoreControllerFaultPoint = (typeof RESTORE_CONTROLLER_FAULT_POINTS)[number];

export interface RestoreControllerRequest {
  readonly container: unknown;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly faults?: readonly RestoreControllerFaultPoint[];
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly logicalPaths: readonly string[];
  readonly principalId: string;
  readonly projectId: string;
  readonly restoreCommandId: string;
  readonly trust: unknown;
}

export interface InstalledRestoreRecord {
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly preparedIdentity: string;
  readonly restoreCommandId: string;
  readonly schemaVersion: typeof RESTORE_CONTROLLER_SCHEMA_VERSION;
}

export interface RestoreRefused {
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly layer: RestoreRefusalLayer;
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly truth: "UNKNOWN";
}

export interface RestoreQuiesced {
  readonly authority: "DURABLE_DECISION";
  readonly bindingDigest: string;
  readonly disposition: "QUIESCED";
  readonly event: ProjectEvent;
  readonly ok: true;
  readonly preparedIdentity: string;
  readonly state: ProjectState;
}

export interface RestoreAlreadySettled {
  readonly authority: "DURABLE_DECISION";
  readonly bindingDigest: string;
  readonly disposition: "ALREADY_QUIESCED";
  readonly ok: true;
  readonly preparedIdentity: string;
  readonly record: InstalledRestoreRecord;
}

export type RestoreResult = RestoreAlreadySettled | RestoreQuiesced | RestoreRefused;
export type RestoreInspection =
  | { readonly ok: true; readonly outcome: "ABSENT" }
  | {
      readonly bindingDigest: string;
      readonly ok: true;
      readonly outcome: "INSTALLED";
      readonly record: InstalledRestoreRecord;
    }
  | RestoreRefused;
export type RestoreDiscardResult =
  | { readonly ok: true; readonly outcome: "DISCARDED"; readonly preparedIdentity: string }
  | RestoreRefused;

export function restoreRefusal(
  layer: RestoreRefusalLayer,
  code: string,
  error: RuntimeError | null = null,
): RestoreRefused {
  return Object.freeze({
    authority: "NONE" as const,
    code,
    error,
    layer,
    ok: false as const,
    outcome: "REFUSED" as const,
    truth: "UNKNOWN" as const,
  });
}

export function controllerRefusal(code: RestoreControllerReasonCode): RestoreRefused {
  return restoreRefusal(RESTORE_CONTROLLER_LAYER, code);
}

export interface PreparedRestoreParts {
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly restoreCommandId: string;
}

const FRAME = "\0";

/** Deterministic and epoch-bound: retries reuse identity; a new epoch cannot. */
export function preparedRestoreIdentity(parts: PreparedRestoreParts): string {
  return createHash("sha256")
    .update([
      RESTORE_CONTROLLER_SCHEMA_VERSION,
      parts.restoreCommandId,
      parts.generationDigest,
      parts.incarnationRef,
      parts.keyEpochRef,
    ].join(FRAME))
    .digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze([
  "container", "correlationId", "decidedAt", "faults", "incarnationRef", "keyEpochRef",
  "logicalPaths", "principalId", "projectId", "restoreCommandId", "trust",
]);
const RECORD_KEYS = Object.freeze([
  "generationDigest", "incarnationRef", "keyEpochRef", "preparedIdentity",
  "restoreCommandId", "schemaVersion",
]);
const isRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

function hasExactStringKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key));
}

function validFaults(value: unknown): value is readonly RestoreControllerFaultPoint[] | undefined {
  return value === undefined || (
    Array.isArray(value) &&
    value.every((point) => RESTORE_CONTROLLER_FAULT_POINTS.includes(point))
  );
}

/** Bounded exact-shape snapshot; unknown keys and fault names fail closed. */
export function snapshotRestoreRequest(value: unknown): RestoreControllerRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (!hasExactStringKeys(value, REQUEST_KEYS)) return null;
    const raw = value as Record<string, unknown>;
    if (![raw.restoreCommandId, raw.projectId, raw.correlationId, raw.principalId, raw.decidedAt]
      .every(isRef)) return null;
    if (!HEX64.test(String(raw.incarnationRef)) || !HEX64.test(String(raw.keyEpochRef))) return null;
    if (!Array.isArray(raw.logicalPaths) || raw.logicalPaths.some((entry) => typeof entry !== "string")) {
      return null;
    }
    if (!validFaults(raw.faults)) return null;
    return Object.freeze({
      container: raw.container,
      correlationId: raw.correlationId as string,
      decidedAt: raw.decidedAt as string,
      ...(raw.faults === undefined ? {} : { faults: Object.freeze([...raw.faults]) }),
      incarnationRef: raw.incarnationRef as string,
      keyEpochRef: raw.keyEpochRef as string,
      logicalPaths: Object.freeze([...raw.logicalPaths]),
      principalId: raw.principalId as string,
      projectId: raw.projectId as string,
      restoreCommandId: raw.restoreCommandId as string,
      trust: raw.trust,
    });
  } catch {
    return null;
  }
}

export function encodeRestoreRecord(record: InstalledRestoreRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/** Exact-shape decode: malformed, extended, or truncated payloads are unreadable. */
export function decodeRestoreRecord(bytes: Uint8Array): InstalledRestoreRecord | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!hasExactStringKeys(parsed, RECORD_KEYS) || Object.keys(parsed).length !== RECORD_KEYS.length) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== RESTORE_CONTROLLER_SCHEMA_VERSION || !isRef(record.restoreCommandId)) {
      return null;
    }
    for (const key of ["generationDigest", "incarnationRef", "keyEpochRef", "preparedIdentity"]) {
      if (typeof record[key] !== "string" || !HEX64.test(record[key])) return null;
    }
    const decoded: InstalledRestoreRecord = {
      generationDigest: record.generationDigest as string,
      incarnationRef: record.incarnationRef as string,
      keyEpochRef: record.keyEpochRef as string,
      preparedIdentity: record.preparedIdentity as string,
      restoreCommandId: record.restoreCommandId,
      schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
    };
    if (preparedRestoreIdentity(decoded) !== decoded.preparedIdentity) return null;
    return Object.freeze(decoded);
  } catch {
    return null;
  }
}
