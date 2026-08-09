import type { BoundedJsonDecodeError, JsonObject, JsonValue, RuntimeCommandKind } from "@moe/contracts";
import { RECOVERY_OUTCOME_KINDS } from "@moe/runner";
import type { RecoveryFailure, RecoveryOutcomeKind } from "@moe/runner";

/**
 * The continuation vocabulary and byte ingress, held apart from the service that
 * composes it.
 *
 * Everything here decides only whether an input is a well-formed continuation
 * request and how a refusal is shaped. No recovery rule lives in this file: the
 * successor-overlap and resume admissions are `@moe/runner`'s, and their codes
 * and layers are carried out verbatim by `boundaryRefusal` rather than restated.
 */
/**
 * `/2` REMOVED `predecessorRelease` and `safeHandoff` from the request. A caller
 * that can assert its own predecessor release can manufacture the boundary it is
 * asking permission to cross, so those facts now come only from the durable
 * reconciliation record. The version bump is what makes a `/1` envelope — the
 * shape that carried them — a rejection rather than a silently-ignored extra.
 */
export const CONTINUATION_SCHEMA_VERSION = "moe-recovery-continuation-request/2" as const;
export const CONTINUATION_BINDING_SCHEMA_VERSION = "moe-recovery-continuation-binding/1" as const;

/**
 * Exactly ONE kind, typed against the runtime vocabulary so a typo is a build
 * failure. One kind is the surface form of design 1099's "one safe action":
 * there is no second command a caller could be left owing after a crash.
 *
 * `work.resume` is the same operation `doctor-commands.ts` PROPOSES for
 * `doctor.propose_resume`, so the proposal and the action name one thing.
 */
export const CONTINUATION_COMMAND_KINDS = Object.freeze([
  "work.resume",
] as const satisfies readonly RuntimeCommandKind[]);
export type ContinuationCommandKind = (typeof CONTINUATION_COMMAND_KINDS)[number];

/**
 * This module's OWN refusals, all raised at the CONTINUATION layer. Boundary
 * refusals keep `@moe/runner`'s codes instead and never appear in this list — a
 * locally minted copy would erase which layer answered.
 */
export const CONTINUATION_ERROR_CODES = Object.freeze([
  "CONTINUATION_REQUEST_SHAPE_INVALID",
  "CONTINUATION_ATTEMPT_UNRECONCILED",
  "CONTINUATION_ATTEMPT_UNCLASSIFIED",
  "CONTINUATION_BINDING_CONFLICT",
] as const);
export type ContinuationErrorCode = (typeof CONTINUATION_ERROR_CODES)[number];

export interface ContinuationBinding {
  readonly attemptRef: string;
  readonly bindingRef: string;
  readonly classification: RecoveryOutcomeKind;
  readonly safeHandoff: string;
  readonly schemaVersion: typeof CONTINUATION_BINDING_SCHEMA_VERSION;
  readonly successorRef: string;
}

/**
 * What a caller may say. Note what is ABSENT: no release, no handoff. Those are
 * read from the predecessor's stored record, so this shape cannot express the
 * assertion that would bypass the boundary.
 */
export interface ContinuationRequest {
  readonly attemptRef: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly successorRef: string;
}

export interface ContinuationInputRejected {
  readonly code: BoundedJsonDecodeError["code"];
  readonly layer: "BOUNDED_JSON";
  readonly message: string;
  readonly ok: false;
  readonly outcome: "INPUT_REJECTED";
}

export interface ContinuationGateRefused {
  readonly code: ContinuationErrorCode;
  readonly layer: "CONTINUATION";
  readonly message: string;
  readonly ok: false;
  readonly outcome: "REQUEST_INVALID" | "UNRECONCILED" | "UNCLASSIFIED" | "CONFLICT";
}

export interface ContinuationBoundaryRefused {
  readonly code: RecoveryFailure["code"];
  readonly layer: RecoveryFailure["layer"];
  readonly message: string;
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export interface ContinuationBound {
  readonly appendsOnly: true;
  readonly binding: ContinuationBinding;
  readonly ok: true;
  readonly outcome: "BOUND";
}

export type ContinuationResult =
  | ContinuationInputRejected
  | ContinuationGateRefused
  | ContinuationBoundaryRefused
  | ContinuationBound;

const MAX_REF_CHARS = 400;
const REQUEST_KEYS = Object.freeze([
  "attemptRef",
  "correlationId",
  "decidedAt",
  "kind",
  "principalId",
  "projectId",
  "schemaVersion",
  "successorRef",
]);
const REF_KEYS = Object.freeze([
  "attemptRef",
  "correlationId",
  "decidedAt",
  "principalId",
  "projectId",
  "successorRef",
]);
const decoder = new TextDecoder();

function gateRefusal(
  outcome: ContinuationGateRefused["outcome"],
  code: ContinuationErrorCode,
  message: string,
): ContinuationGateRefused {
  return Object.freeze({ code, layer: "CONTINUATION" as const, message, ok: false as const, outcome });
}

export const SHAPE_INVALID = gateRefusal(
  "REQUEST_INVALID",
  "CONTINUATION_REQUEST_SHAPE_INVALID",
  `A continuation request must match ${CONTINUATION_SCHEMA_VERSION} exactly.`,
);

export const UNRECONCILED = gateRefusal(
  "UNRECONCILED",
  "CONTINUATION_ATTEMPT_UNRECONCILED",
  "An attempt restart reconciliation never classified cannot be continued.",
);

export const UNCLASSIFIED = gateRefusal(
  "UNCLASSIFIED",
  "CONTINUATION_ATTEMPT_UNCLASSIFIED",
  "An attempt whose classification was refused carries no truth to continue from.",
);

export const BINDING_CONFLICT = gateRefusal(
  "CONFLICT",
  "CONTINUATION_BINDING_CONFLICT",
  "The continuation binding was not appended; a binding for this successor already exists.",
);

/** Carries the runner's refusal out unchanged: its code, its layer, its message. */
export function boundaryRefusal(failure: RecoveryFailure): ContinuationBoundaryRefused {
  return Object.freeze({
    code: failure.code,
    layer: failure.layer,
    message: failure.message,
    ok: false as const,
    outcome: "REFUSED" as const,
  });
}

export function inputRejected(error: BoundedJsonDecodeError): ContinuationInputRejected {
  return Object.freeze({
    code: error.code,
    layer: "BOUNDED_JSON" as const,
    message: error.message,
    ok: false as const,
    outcome: "INPUT_REJECTED" as const,
  });
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REF_CHARS;
}

function isPlainJsonObject(value: JsonValue): value is JsonObject {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === null
  );
}

/**
 * Exact shape: a decoder-created null-prototype record carrying exactly the
 * declared keys, nothing more and nothing less.
 *
 * The exactness is what enforces the migration. `predecessorRelease` and
 * `safeHandoff` are not merely unread — they are UNDECLARED, so a request still
 * carrying them has a key count this gate rejects. An implementation that only
 * stopped reading them would leave a caller able to send them and be told the
 * continuation succeeded, which is a different and worse answer than a refusal.
 */
export function parseContinuationRequest(value: JsonValue): ContinuationRequest | null {
  if (!isPlainJsonObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== REQUEST_KEYS.length || keys.some((key) => !REQUEST_KEYS.includes(key))) return null;
  if (value["schemaVersion"] !== CONTINUATION_SCHEMA_VERSION) return null;
  if (!(CONTINUATION_COMMAND_KINDS as readonly unknown[]).includes(value["kind"])) return null;
  if (REF_KEYS.some((key) => !isRef(value[key]))) return null;
  return Object.freeze({
    attemptRef: value["attemptRef"] as string,
    correlationId: value["correlationId"] as string,
    decidedAt: value["decidedAt"] as string,
    principalId: value["principalId"] as string,
    projectId: value["projectId"] as string,
    successorRef: value["successorRef"] as string,
  });
}

export function decodeContinuationBinding(bytes: Uint8Array): ContinuationBinding | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Readonly<Record<string, unknown>>;
  if (item["schemaVersion"] !== CONTINUATION_BINDING_SCHEMA_VERSION) return null;
  for (const key of ["attemptRef", "bindingRef", "safeHandoff", "successorRef"] as const) {
    if (typeof item[key] !== "string") return null;
  }
  // Narrowed to the runner's vocabulary rather than any string: a binding is a
  // record that some classification admitted a resume, and REFUSED — which the
  // reconciliation vocabulary does contain — never admitted anything.
  if (!(RECOVERY_OUTCOME_KINDS as readonly unknown[]).includes(item["classification"])) return null;
  return Object.freeze({ ...item }) as unknown as ContinuationBinding;
}
