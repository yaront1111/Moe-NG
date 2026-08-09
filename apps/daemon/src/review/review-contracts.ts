import { decodeBoundedJsonBytes } from "@moe/contracts";
import type {
  BoundedJsonDecodeError,
  JsonObject,
  JsonValue,
  RuntimeCommandKind,
} from "@moe/contracts";

/**
 * Byte ingress for the review-flow command surface (design 15.2, journey J4).
 *
 * This module is a trust boundary and nothing more: it decides only whether an input is a
 * well-formed envelope naming a command this surface owns. Every review question — repeat
 * detection, append-only lineage, escalation, acceptance eligibility — belongs to `@moe/review`,
 * and every delta question to `@moe/core`, so refusals raised here carry
 * `refusedBy: "DAEMON_INGRESS"` to keep the layers distinguishable in evidence.
 *
 * WHY THIS SURFACE OWNS ITS OWN KIND LIST RATHER THAN EXTENDING `BOOTSTRAP_COMMAND_KINDS`:
 * `bootstrap-sequence.ts`'s `COMMAND_PREREQUISITES` is a TOTAL `Record<BootstrapCommandKind, ...>`
 * and two bootstrap suites assert that list's exact length, so appending there is a typecheck
 * failure plus two red assertions in files this task does not own. A domain-scoped vocabulary is
 * already the house shape — `recovery/doctor-commands.ts` and `work/work-ingress.ts` both carry
 * one — and the envelope, refusal taxonomy and decode order are copied from
 * `bootstrap-contracts.ts` exactly so the two READ the same.
 */

export const REVIEW_SCHEMA_VERSION = "moe-review-command/1" as const;

/**
 * The four kinds this surface owns. `satisfies readonly RuntimeCommandKind[]` makes a typo a build
 * failure and proves every member already exists in the runtime vocabulary; that containment is
 * also asserted by test rather than derived, so widening cannot pass silently. `goal.close` is
 * deliberately absent: J1's final acceptance belongs to the goal surface.
 */
export const REVIEW_COMMAND_KINDS = Object.freeze([
  "escalation.decide",
  "integration.accept_output",
  "qualification.replan",
  "review.submit",
] as const satisfies readonly RuntimeCommandKind[]);

export type ReviewCommandKind = (typeof REVIEW_COMMAND_KINDS)[number];

export const REVIEW_REQUEST_KEYS = Object.freeze([
  "commandId",
  "correlationId",
  "decidedAt",
  "expectedVersion",
  "kind",
  "payload",
  "principalId",
  "projectId",
  "schemaVersion",
] as const);

export const REVIEW_INGRESS_REFUSAL_CODES = Object.freeze([
  "REVIEW_INPUT_REJECTED",
  "REVIEW_REQUEST_INVALID",
  "REVIEW_COMMAND_UNKNOWN",
  "REVIEW_PAYLOAD_INVALID",
  "REVIEW_DELTA_NODES_EMPTY",
  "REVIEW_DELTA_NODE_DUPLICATED",
] as const);

export type ReviewIngressRefusalCode = (typeof REVIEW_INGRESS_REFUSAL_CODES)[number];

/**
 * Refusals owned by the daemon's durable gate. No `@moe/review` or `@moe/core` code is ever
 * restated here; those surface under their own layer carrying their own code. Emitting a
 * daemon-layer code absent from this list is a BUILD failure — see `refuse` in review-ledger.ts.
 *
 * `REVIEW_LINEAGE_UNREADABLE` is the fail-closed arm for stored bytes that do not parse as a
 * lineage: falling back to the empty lineage would silently reset the escalation counter, which
 * is precisely the attack `@moe/review`'s digest attestation exists to stop.
 */
export const REVIEW_PREREQUISITE_REFUSAL_CODES = Object.freeze([
  "REVIEW_COMMAND_ID_REUSED",
  "REVIEW_EXPECTED_VERSION_STALE",
  "REVIEW_LINEAGE_UNREADABLE",
  "REVIEW_ESCALATION_NOT_REACHED",
  "REVIEW_REPLAN_WITHOUT_ROUND",
  "REVIEW_ESCALATION_REQUIRED",
] as const);

export type ReviewPrerequisiteRefusalCode = (typeof REVIEW_PREREQUISITE_REFUSAL_CODES)[number];

/** The layer that answered. Four can refuse, so evidence must name which one did. */
export const REVIEW_REFUSED_BY = Object.freeze([
  "DAEMON_INGRESS",
  "DAEMON_PREREQUISITE",
  "REVIEW_KERNEL",
  "CORE_POLICY",
  "DURABLE_STORE",
] as const);

export type ReviewRefusedBy = (typeof REVIEW_REFUSED_BY)[number];

/**
 * Delta-approval outcomes (design line 1101). They live here rather than beside the handler so the
 * read model can validate stored bytes without importing it — that import would close a cycle, and
 * a cycle yields TDZ-undefined bindings that load cleanly and only fail at first use. There is no
 * third arm on purpose: `@moe/core`'s `evaluateCarryForward` verdict is boolean-valued, so an
 * unclassified node is not expressible.
 */
export const DELTA_CLASSIFICATIONS = Object.freeze(["CARRY_FORWARD", "INVALIDATED"] as const);

export type DeltaClassification = (typeof DELTA_CLASSIFICATIONS)[number];

export interface DeltaNodeClassification {
  readonly classification: DeltaClassification;
  readonly nodeRef: string;
  readonly reasonCodes: readonly string[];
  readonly sourceHash: string;
  readonly targetHash: string;
}

export interface ReviewRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: ReviewCommandKind;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: typeof REVIEW_SCHEMA_VERSION;
}

export interface ReviewInputRejected {
  readonly code: "REVIEW_INPUT_REJECTED";
  readonly decodeError: BoundedJsonDecodeError;
  readonly ok: false;
  readonly refusedBy: "DAEMON_INGRESS";
}

export interface ReviewRequestRefused {
  readonly code: "REVIEW_REQUEST_INVALID" | "REVIEW_COMMAND_UNKNOWN";
  readonly ok: false;
  readonly refusedBy: "DAEMON_INGRESS";
}

export interface ReviewRequestAccepted {
  readonly ok: true;
  readonly request: ReviewRequest;
}

export type ReviewDecodeRefusal = ReviewInputRejected | ReviewRequestRefused;

export type ReviewDecodeResult = ReviewRequestAccepted | ReviewDecodeRefusal;

const REQUEST_INVALID: ReviewRequestRefused = Object.freeze({
  code: "REVIEW_REQUEST_INVALID",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const COMMAND_UNKNOWN: ReviewRequestRefused = Object.freeze({
  code: "REVIEW_COMMAND_UNKNOWN",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const KIND_SET: ReadonlySet<string> = new Set<string>(REVIEW_COMMAND_KINDS);
const KEY_SET: ReadonlySet<string> = new Set<string>(REVIEW_REQUEST_KEYS);

/**
 * `decodeBoundedJsonBytes` yields null-prototype objects, so any other prototype means the value
 * did not come from the bounded decoder and is not trusted here.
 */
export function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null
    && value !== undefined
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === null
  );
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(request: JsonObject): boolean {
  const keys = Object.keys(request);
  if (keys.length !== REVIEW_REQUEST_KEYS.length) return false;
  return keys.every((key) => KEY_SET.has(key));
}

function isReviewKind(value: JsonValue | undefined): value is ReviewCommandKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Envelope-shape agreement, excluding the kind, which refuses under its own code. */
function isExactEnvelope(request: JsonObject): boolean {
  return (
    hasExactKeys(request)
    && request["schemaVersion"] === REVIEW_SCHEMA_VERSION
    && isRef(request["commandId"])
    && isRef(request["correlationId"])
    && isRef(request["decidedAt"])
    && isRef(request["principalId"])
    && isRef(request["projectId"])
    && typeof request["expectedVersion"] === "number"
    && Number.isSafeInteger(request["expectedVersion"])
    && request["expectedVersion"] >= 0
    && isPlainJsonObject(request["payload"])
  );
}

function accepted(request: JsonObject, kind: ReviewCommandKind): ReviewRequestAccepted {
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      commandId: request["commandId"] as string,
      correlationId: request["correlationId"] as string,
      decidedAt: request["decidedAt"] as string,
      expectedVersion: request["expectedVersion"] as number,
      kind,
      payload: request["payload"] as JsonObject,
      principalId: request["principalId"] as string,
      projectId: request["projectId"] as string,
      schemaVersion: REVIEW_SCHEMA_VERSION,
    }),
  });
}

/**
 * Decodes request bytes into an owned review command envelope. Decode failures surface the
 * bounded decoder's own error unchanged; translating it would erase which resource bound was
 * exceeded and which layer refused.
 */
export function decodeReviewRequestBytes(input: unknown): ReviewDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      code: "REVIEW_INPUT_REJECTED" as const,
      decodeError: decoded,
      ok: false as const,
      refusedBy: "DAEMON_INGRESS" as const,
    });
  }
  if (!isPlainJsonObject(decoded.value)) return REQUEST_INVALID;

  const request = decoded.value;
  if (!isExactEnvelope(request)) return REQUEST_INVALID;

  const kind = request["kind"];
  if (typeof kind !== "string") return REQUEST_INVALID;
  if (!isReviewKind(kind)) return COMMAND_UNKNOWN;

  return accepted(request, kind);
}
