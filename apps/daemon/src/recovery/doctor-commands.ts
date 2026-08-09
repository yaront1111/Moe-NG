import { decodeBoundedJsonBytes } from "@moe/contracts";
import type {
  BoundedJsonDecodeError,
  JsonObject,
  JsonValue,
  RuntimeCommandKind,
} from "@moe/contracts";
import { DOCTOR_VERSION_ERROR_CODES, versionsReported } from "./doctor-version-contract.js";
import type { DoctorVersionReport, DoctorVersionsReported } from "./doctor-version-contract.js";

/**
 * Doctor recovery commands: the daemon-side half of "nothing silently resumes".
 *
 * Every command here REPORTS a recovery state or PROPOSES an exact runtime
 * command for confirmation. None of them applies a repair, and the surface is
 * shaped so none of them CAN: the only success shapes are `REPORTED` and
 * `PROPOSED`, both carry `appliesChange: false`, and every proposal carries
 * `confirmationRequired: true`. A repair-without-confirmation command would have
 * to add a new outcome to the union rather than slip through an existing one.
 *
 * Ingress follows the daemon's established pattern: bounded decode first, then
 * an EXACT-shape check against a frozen key list and a pinned schemaVersion
 * literal, then compose. Each stage refuses under its own layer, so a reader can
 * tell the decoder's answer from the doctor's.
 */
export const DOCTOR_RECOVERY_SCHEMA_VERSION = "moe-doctor-recovery-request/1" as const;

export const DOCTOR_COMMAND_KINDS = Object.freeze([
  "doctor.report_recovery_state",
  "doctor.propose_effect_reconciliation",
  "doctor.propose_resource_release",
  "doctor.propose_quarantine_export",
  "doctor.propose_resume",
  "doctor.report_versions",
] as const);
export type DoctorCommandKind = (typeof DOCTOR_COMMAND_KINDS)[number];

export const DOCTOR_ERROR_CODES = Object.freeze([
  "DOCTOR_REQUEST_SHAPE_INVALID",
  "DOCTOR_AUTHORITY_STALE",
  ...DOCTOR_VERSION_ERROR_CODES,
] as const);
export type DoctorErrorCode = (typeof DOCTOR_ERROR_CODES)[number];

/**
 * Every proposal names an operation the runtime command vocabulary already
 * declares, typed so a typo is a build failure rather than an instruction no
 * operator can carry out. A kind absent from this map cannot be proposed.
 */
const PROPOSED_COMMANDS: Readonly<Record<string, RuntimeCommandKind>> = Object.freeze({
  "doctor.propose_effect_reconciliation": "recovery.reconcile_external",
  "doctor.propose_resource_release": "resource.confirm_released",
  "doctor.propose_quarantine_export": "quarantine.export_forensic",
  "doctor.propose_resume": "work.resume",
});

const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "subjectRef",
  "recordEpoch",
  "observedEpoch",
]);

export interface DoctorInputRejected {
  readonly ok: false;
  readonly outcome: "INPUT_REJECTED";
  readonly layer: "BOUNDED_JSON";
  readonly error: BoundedJsonDecodeError;
}

export interface DoctorRequestInvalid {
  readonly ok: false;
  readonly outcome: "REQUEST_INVALID";
  readonly layer: "DOCTOR";
  readonly code: "DOCTOR_REQUEST_SHAPE_INVALID";
  readonly message: string;
}

export interface DoctorAuthorityStale {
  readonly ok: false;
  readonly outcome: "AUTHORITY_STALE";
  readonly layer: "DOCTOR";
  readonly code: "DOCTOR_AUTHORITY_STALE";
  readonly message: string;
}

export interface DoctorReported {
  readonly ok: true;
  readonly outcome: "REPORTED";
  readonly kind: DoctorCommandKind;
  readonly subjectRef: string;
  readonly appliesChange: false;
}

export interface DoctorProposed {
  readonly ok: true;
  readonly outcome: "PROPOSED";
  readonly kind: DoctorCommandKind;
  readonly subjectRef: string;
  readonly command: RuntimeCommandKind;
  readonly confirmationRequired: true;
  readonly appliesChange: false;
}

export type DoctorCommandResult =
  | DoctorInputRejected
  | DoctorRequestInvalid
  | DoctorAuthorityStale
  | DoctorReported
  | DoctorProposed
  | DoctorVersionsReported
  | DoctorVersionReportAbsent;

interface DoctorRequest {
  readonly kind: DoctorCommandKind;
  readonly subjectRef: string;
  readonly recordEpoch: number;
  readonly observedEpoch: number;
}

const SHAPE_INVALID: DoctorRequestInvalid = Object.freeze({
  ok: false,
  outcome: "REQUEST_INVALID",
  layer: "DOCTOR",
  code: "DOCTOR_REQUEST_SHAPE_INVALID",
  message: `Doctor recovery request must match ${DOCTOR_RECOVERY_SCHEMA_VERSION} exactly.`,
});

/** The doctor reads no host state: the report is built at the daemon edge and passed in. */
const VERSION_REPORT_ABSENT = Object.freeze({
  ok: false as const,
  outcome: "VERSION_REPORT_ABSENT" as const,
  layer: "DOCTOR" as const,
  code: "DOCTOR_VERSION_REPORT_ABSENT" as const,
  message: "A doctor version report must be supplied by the daemon edge, never read here.",
});
export type DoctorVersionReportAbsent = typeof VERSION_REPORT_ABSENT;

const AUTHORITY_STALE: DoctorAuthorityStale = Object.freeze({
  ok: false,
  outcome: "AUTHORITY_STALE",
  layer: "DOCTOR",
  code: "DOCTOR_AUTHORITY_STALE",
  message: "A doctor command may not act on a record whose authority has moved past it.",
});

/**
 * The validators take `unknown` so an absent key is refused by the SAME guard
 * that refuses a wrong-typed one. A separate `=== undefined` check would be a
 * second guard for the same fact, and a mutation drill showed such a check
 * cannot be reddened by any input — a line no test can pin is a line that will
 * quietly stop meaning anything.
 */

/** Safe non-negative integers only; `-0` is excluded so it cannot alias `0`. */
function isEpoch(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

/** Matches the runner's bound on an opaque reference; the daemon cannot import it. */
const MAX_SUBJECT_REF_CHARS = 400;

function isSubjectRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SUBJECT_REF_CHARS;
}

function isDoctorKind(value: unknown): value is DoctorCommandKind {
  return typeof value === "string" && (DOCTOR_COMMAND_KINDS as readonly string[]).includes(value);
}

/**
 * Exact shape: a decoder-created null-prototype record carrying exactly the
 * declared keys, nothing more and nothing less. An extra key is a refusal, not
 * a field to ignore — a request nobody fully understood is not a request the
 * daemon should act on. A missing key is refused by its own field guard, since
 * a key that is absent is a key whose value is not the declared type.
 */
function parseRequest(value: JsonValue): DoctorRequest | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  if (Object.getPrototypeOf(value) !== null) return null;

  const request = value as JsonObject;
  if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) return null;
  if (request["schemaVersion"] !== DOCTOR_RECOVERY_SCHEMA_VERSION) return null;

  const kind = request["kind"];
  const subjectRef = request["subjectRef"];
  const recordEpoch = request["recordEpoch"];
  const observedEpoch = request["observedEpoch"];
  if (!isDoctorKind(kind) || !isSubjectRef(subjectRef)) return null;
  if (!isEpoch(recordEpoch) || !isEpoch(observedEpoch)) return null;

  return { kind, subjectRef, recordEpoch, observedEpoch };
}

/**
 * Composes the doctor answer. A proposal is looked up in the frozen map rather
 * than derived from the kind's name, so a command with no declared runtime
 * operation reports instead of inventing one to propose.
 */
function compose(request: DoctorRequest): DoctorCommandResult {
  const command = Object.hasOwn(PROPOSED_COMMANDS, request.kind)
    ? PROPOSED_COMMANDS[request.kind]
    : undefined;
  if (command === undefined) {
    return Object.freeze({
      ok: true as const,
      outcome: "REPORTED" as const,
      kind: request.kind,
      subjectRef: request.subjectRef,
      appliesChange: false as const,
    });
  }
  return Object.freeze({
    ok: true as const,
    outcome: "PROPOSED" as const,
    kind: request.kind,
    subjectRef: request.subjectRef,
    command,
    confirmationRequired: true as const,
    appliesChange: false as const,
  });
}

export function evaluateDoctorCommandBytes(
  input: unknown, versionReport?: DoctorVersionReport,
): DoctorCommandResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      ok: false as const,
      outcome: "INPUT_REJECTED" as const,
      layer: "BOUNDED_JSON" as const,
      error: decoded,
    });
  }
  const request = parseRequest(decoded.value);
  if (request === null) return SHAPE_INVALID;
  if (request.observedEpoch < request.recordEpoch) return AUTHORITY_STALE;
  if (request.kind === "doctor.report_versions") {
    return versionReport === undefined ? VERSION_REPORT_ABSENT : versionsReported(versionReport);
  }
  return compose(request);
}
