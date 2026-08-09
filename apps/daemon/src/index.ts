import { decodeBoundedJsonBytes } from "@moe/contracts";
import { previewGraphSnapshot } from "@moe/scheduler";
import type { BoundedJsonDecodeError, JsonObject, JsonValue } from "@moe/contracts";
import type { GraphPreviewOptions, GraphPreviewResult } from "@moe/scheduler";

export {
  BOOTSTRAP_COMMAND_KINDS,
  BOOTSTRAP_REFUSAL_CODES,
  BOOTSTRAP_REQUEST_KEYS,
  BOOTSTRAP_SCHEMA_VERSION,
  decodeBootstrapRequestBytes,
  type BootstrapCommandKind,
  type BootstrapDecodeRefusal,
  type BootstrapDecodeResult,
  type BootstrapInputRejected,
  type BootstrapRefusalCode,
  type BootstrapRefusedBy,
  type BootstrapRequest,
  type BootstrapRequestAccepted,
  type BootstrapRequestRefused,
} from "./bootstrap/bootstrap-contracts.js";
export {
  PREREQUISITE_REFUSAL_CODES,
  SERVICE_REFUSED_BY,
  type CommandHandler,
  type DurableAggregate,
  type DurableLedger,
  type HandlerContext,
  type HandlerTable,
  type PrerequisiteRefusalCode,
  type ServiceAccepted,
  type ServiceOutcome,
  type ServiceRefused,
  type ServiceRefusedBy,
} from "./bootstrap/bootstrap-ledger.js";
export {
  BOOTSTRAP_HANDLERS,
  runBootstrapCommand,
} from "./bootstrap/bootstrap-services.js";
export { GOAL_HANDLERS } from "./goals/goal-services.js";
export { PLANNING_HANDLERS } from "./planning/planning-services.js";
export {
  CLAIM_LEGS,
  SLOT_CEILING_LEG,
  WORK_AUTHORITY_LABELS,
  WORK_COMMANDS,
  WORK_ERROR_CODES,
  WORK_LAYERS,
  WORK_LEGS,
  WORK_SCHEMA_VERSION,
  type ClaimLeg,
  type ClaimSuccessors,
  type WorkApplied,
  type WorkAuthorityLabel,
  type WorkCommand,
  type WorkContextView,
  type WorkErrorCode,
  type WorkFailure,
  type WorkGranted,
  type WorkInputRejected,
  type WorkLayer,
  type WorkLeg,
  type WorkRefused,
  type WorkResult,
} from "./work/work-kernel.js";
export {
  parseWorkRequest,
  type WorkRequestEnvelope,
  type WorkRequestParse,
} from "./work/work-ingress.js";
export { claimWork } from "./work/work-claim.js";
export {
  EVENT_STREAM_LAYER,
  EVENT_STREAM_REFUSAL_CODES,
  MAX_EVENT_PAGE_SIZE,
  type EventGapFrame,
  type EventPageFrame,
  type EventReadFrame,
  type EventReadRequest,
  type EventRefusedFrame,
  type EventReseatedFrame,
  type EventResumeFrame,
  type EventResumeRequest,
  type EventStreamRefusalCode,
  type StreamCursor,
  type StreamEvent,
  type StreamGap,
  type StreamPage,
  type StreamPageRequest,
  type StreamReadResult,
  type StreamRefused,
  type StreamReseatRequest,
  type StreamSeatResult,
  type StreamSeated,
  type StreamSnapshot,
  type SubscriptionPort,
  type WireCursor,
  type WireEvent,
  type WireSnapshot,
} from "./http/event-stream-contract.js";
export { readEventPage, resumeFromSnapshot } from "./http/event-stream.js";
export * from "./daemon-entry.js";
export {
  DOCTOR_COMMAND_KINDS,
  DOCTOR_ERROR_CODES,
  DOCTOR_RECOVERY_SCHEMA_VERSION,
  evaluateDoctorCommandBytes,
  type DoctorAuthorityStale,
  type DoctorCommandKind,
  type DoctorCommandResult,
  type DoctorErrorCode,
  type DoctorInputRejected,
  type DoctorProposed,
  type DoctorReported,
  type DoctorRequestInvalid,
} from "./recovery/doctor-commands.js";
export { REVIEW_HANDLERS } from "./review/review-services.js";
export type {
  DeltaClassification,
  DeltaNodeClassification,
  ReviewCommandKind,
  ReviewDecodeRefusal,
  ReviewDecodeResult,
  ReviewIngressRefusalCode,
  ReviewInputRejected,
  ReviewPrerequisiteRefusalCode,
  ReviewRefusedBy,
  ReviewRequest,
  ReviewRequestAccepted,
  ReviewRequestRefused,
} from "./review/review-contracts.js";
export type {
  CommandHandler as ReviewCommandHandler,
  HandlerContext as ReviewHandlerContext,
  HandlerTable as ReviewHandlerTable,
  ReviewAccepted,
  ReviewDaemonLayer,
  ReviewDaemonRefusalCode,
  ReviewLedger,
  ReviewOutcome,
  ReviewRefused,
  ReviewRoundRecord,
} from "./review/review-ledger.js";
// Packed rather than one-name-per-line only to spend fewer physical lines here;
// see the recovery-incarnation module for the reviewed surface.
export {
  RECOVERY_INCARNATION_ERROR_CODES, RECOVERY_INCARNATION_SCHEMA_VERSION,
  createNodeRecoveryCryptoPort, createRecoveryIncarnationService,
  type RecoveryIncarnationBinding, type RecoveryIncarnationCryptoPort,
  type RecoveryIncarnationErrorCode, type RecoveryIncarnationKeyHandle,
  type RecoveryIncarnationKeyPair, type RecoveryIncarnationMinted,
  type RecoveryIncarnationProof, type RecoveryIncarnationRefused,
  type RecoveryIncarnationRequest, type RecoveryIncarnationResult,
  type RecoveryIncarnationService,
} from "./recovery/recovery-incarnation.js";

const SCHEMA_VERSION = "moe-graph-preview-request/1";
const REQUEST_KEYS = Object.freeze(["options", "schemaVersion", "snapshot"]);

export interface GraphPreviewRequestError {
  readonly code: "GRAPH_PREVIEW_REQUEST_INVALID";
  readonly message: "Graph preview request must match moe-graph-preview-request/1 exactly.";
}

interface AdvisoryEnvelope {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
}

export interface GraphPreviewInputRejected extends AdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "INPUT_REJECTED";
  readonly error: BoundedJsonDecodeError;
}

export interface GraphPreviewRequestInvalid extends AdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "REQUEST_INVALID";
  readonly error: GraphPreviewRequestError;
}

export interface GraphPreviewRequestEvaluated extends AdvisoryEnvelope {
  readonly ok: true;
  readonly outcome: "REQUEST_EVALUATED";
  readonly preview: GraphPreviewResult;
}

export type GraphPreviewRequestResult =
  | GraphPreviewInputRejected
  | GraphPreviewRequestInvalid
  | GraphPreviewRequestEvaluated;

const REQUEST_INVALID_ERROR: GraphPreviewRequestError = Object.freeze({
  code: "GRAPH_PREVIEW_REQUEST_INVALID",
  message: "Graph preview request must match moe-graph-preview-request/1 exactly.",
});

const REQUEST_INVALID_RESULT: GraphPreviewRequestInvalid = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  error: REQUEST_INVALID_ERROR,
  ok: false,
  outcome: "REQUEST_INVALID",
});

function isExactRequest(
  value: JsonValue,
): value is JsonObject & {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly snapshot: JsonValue;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  if (Object.getPrototypeOf(value) !== null) return false;

  const request = value as JsonObject;
  const keys = Object.keys(request);
  if (keys.length < 2 || keys.length > REQUEST_KEYS.length) return false;
  if (keys.some((key) => !REQUEST_KEYS.includes(key))) return false;

  return (
    Object.hasOwn(request, "schemaVersion") &&
    request.schemaVersion === SCHEMA_VERSION &&
    Object.hasOwn(request, "snapshot")
  );
}

/**
 * Composes bounded JSON decoding with a zero-authority graph preview.
 * This advisory operation is not a command or admission boundary.
 */
export function evaluateGraphPreviewRequestBytes(
  input: unknown,
): GraphPreviewRequestResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      advisoryOnly: true,
      authority: "NONE",
      error: decoded,
      ok: false,
      outcome: "INPUT_REJECTED",
    });
  }
  if (!isExactRequest(decoded.value)) return REQUEST_INVALID_RESULT;

  const options: unknown = Object.hasOwn(decoded.value, "options")
    ? decoded.value.options
    : undefined;
  const preview = previewGraphSnapshot(
    decoded.value.snapshot,
    options as GraphPreviewOptions | undefined,
  );
  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    ok: true,
    outcome: "REQUEST_EVALUATED",
    preview,
  });
}
