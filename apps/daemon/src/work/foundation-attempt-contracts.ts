/**
 * The vocabulary and durable codec for Foundation Claude attempt dispatch.
 *
 * THIS MODULE HOLDS NO AUTHORITY AND GRANTS NONE. It fences the exact shape a
 * caller may propose and frames the bytes the service persists. Every authority
 * record the launcher is handed — effect, attempt, one-use grant, admitted
 * claim — is read back out of the COMMITTED activation by the service; the
 * request cannot name one. The exact-key fences make that structural rather than
 * aspirational: a key the request cannot carry is a key nobody can forward.
 *
 * A DISPATCH RECORD IS ADVISORY. `advisoryOnly` is pinned `true`, so nothing
 * here terminalises the ACTIVE effect, releases its lease or re-decides its
 * grant, and no reader can mistake it for the activation it observes.
 */

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { validateGraphSnapshot } from "@moe/scheduler";
import { createHash } from "node:crypto";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";

export const FOUNDATION_ATTEMPT_SCHEMA_VERSION = "moe-foundation-attempt/1" as const;
export const FOUNDATION_ATTEMPT_RECORD_VERSION = "moe-foundation-attempt-record/1" as const;
export const FOUNDATION_RESERVATION_VERSION = "moe-foundation-dispatch-reservation/1" as const;

/** This service's own layer. A refusal from the scheduler's validator or the
 *  runner's workspace builder is reported under ITS layer, not this one. */
export const DAEMON_FOUNDATION_ATTEMPT = "DAEMON_FOUNDATION_ATTEMPT" as const;
export const SCHEDULER_GRAPH_LAYER = "SCHEDULER_GRAPH" as const;
export const RUNNER_WORKSPACE_LAYER = "RUNNER_WORKSPACE" as const;

export const FOUNDATION_DISPATCH_COMMAND_KIND = "foundation.dispatch" as const;
/** The exact records the two production seams below are handed. */
export const CLAIM_KEYS = Object.freeze([
  "claimId", "claimedAt", "intentId", "lockIdentity", "wrapperIdentity",
] as const);
export const CAPTURE_KEYS = Object.freeze([
  "authoredPaths", "declaredArtifactRefs", "resultTreeEntries", "scopeObservation",
] as const);
export const FOUNDATION_DISPATCH_EVENT_TYPES = Object.freeze({
  RECORDED: "FoundationAttemptRecorded", RESERVED: "FoundationDispatchReserved",
} as const);
/**
 * Closed. A refusal raised by the activation ingress, the scheduler, the runner
 * or the store keeps ITS OWN code and layer verbatim — flattening them here
 * would make a graph fault indistinguishable from a consumed grant.
 */
export const FOUNDATION_ATTEMPT_CODES = Object.freeze([
  "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", "FOUNDATION_ATTEMPT_RECORD_ABSENT",
  "FOUNDATION_ATTEMPT_MULTI_NODE_UNSUPPORTED", "FOUNDATION_ATTEMPT_NODE_UNKNOWN",
  "FOUNDATION_ATTEMPT_BINDING_MISMATCH", "FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID",
  "FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE", "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE",
  "FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS", "FOUNDATION_ATTEMPT_DISPATCH_SUSPECT",
  "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN", "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN",
  "FOUNDATION_ATTEMPT_RESULT_MANIFEST_INVALID", "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS",
  "FOUNDATION_ATTEMPT_RECORD_DRIFT",
] as const);
export type FoundationAttemptCode = (typeof FOUNDATION_ATTEMPT_CODES)[number];
export interface FoundationAttemptRefused {
  readonly advisoryOnly: true; readonly authority: "NONE"; readonly code: string;
  readonly ok: false; readonly refusedBy: string;
}
export function foundationAttemptRefusal(code: string, refusedBy: string): FoundationAttemptRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code, ok: false as const, refusedBy,
  });
}

export const refuseLocal = (code: FoundationAttemptCode): FoundationAttemptRefused =>
  foundationAttemptRefusal(code, DAEMON_FOUNDATION_ATTEMPT);

/** The exact request. `activationRequestBytes` is server-assembled elsewhere. */
export const FOUNDATION_ATTEMPT_REQUEST_KEYS = Object.freeze([
  "activationRequestBytes", "binding", "graphSnapshot", "inputManifest", "launchTemplate",
] as const);
export const FOUNDATION_ATTEMPT_BINDING_KEYS = Object.freeze([
  "attemptAggregateId", "nodeKey", "sessionId",
] as const);
export const FOUNDATION_ATTEMPT_INPUT_KEYS = Object.freeze(["baseIdentity", "entries"] as const);
/**
 * AUTHORITY-FREE BY CONSTRUCTION. `grant`, `effect`, `attempt`, `claim`,
 * `priorRegistration`, `duplicateDelivery`, `wrapperIdentity`, `reconciliation`
 * and any freshly observed runtime are ABSENT: the service reads each from the
 * committed activation, or the runner observes it for itself.
 */
export const FOUNDATION_ATTEMPT_TEMPLATE_KEYS = Object.freeze([
  "argv", "bootstrapCredentialDigest", "cwd", "environment", "launchSelection", "limits", "runtime",
] as const);
export interface FoundationAttemptBinding {
  readonly attemptAggregateId: string; readonly nodeKey: string; readonly sessionId: string;
}
export interface FoundationAttemptLaunchTemplate {
  readonly argv: readonly string[]; readonly bootstrapCredentialDigest: string;
  readonly cwd: string; readonly environment: Readonly<Record<string, string>>;
  readonly launchSelection: unknown; readonly limits: unknown; readonly runtime: unknown;
}
export interface FoundationAttemptDispatchRequest {
  readonly activationRequestBytes: Uint8Array;
  readonly binding: FoundationAttemptBinding;
  readonly graphSnapshot: unknown;
  readonly inputManifest: { readonly baseIdentity: string; readonly entries: readonly unknown[] };
  readonly launchTemplate: FoundationAttemptLaunchTemplate;
}
const MAX_DEPTH = 12, MAX_KEYS = 64, MAX_ITEMS = 512, MAX_TEXT = 8_192, MAX_BYTES = 1_048_576;
const HOSTILE = Symbol("hostile");
/** Own DATA properties only, bounded. No getter runs, no proxy re-answers, and
 *  every read below decides over THIS snapshot: what was validated is what is used. */
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return HOSTILE;
  if (value === null) return null;
  const type = typeof value;
  if (type === "boolean") return value;
  if (type === "string") return (value as string).length > MAX_TEXT ? HOSTILE : value;
  if (type === "number") return Number.isFinite(value) ? value : HOSTILE;
  if (type !== "object") return HOSTILE;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) return HOSTILE;
  const keys = array ? (value as unknown[]).map((_, index) => String(index))
    : Object.keys(value as object);
  if (keys.length > (array ? MAX_ITEMS : MAX_KEYS)) return HOSTILE;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return HOSTILE;
    const item = snapshot(descriptor.value, depth + 1);
    if (item === HOSTILE) return HOSTILE;
    out[key] = item;
  }
  return array ? keys.map((key) => out[key]) : out;
}
export function exactKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return null;
  const set = new Set(allowed);
  return keys.every((key) => set.has(key)) ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) return null;
  return entries.every(([, item]) => typeof item === "string")
    ? Object.freeze(Object.fromEntries(entries) as Record<string, string>) : null;
}
export type FoundationAttemptDecodeResult =
  | { readonly ok: true; readonly request: FoundationAttemptDispatchRequest }
  | FoundationAttemptRefused;
/**
 * Structural only. Every domain judgement belongs to its owner: the graph to the
 * scheduler's validator, the input tree to the runner's manifest builder, the
 * activation to the activation ingress — no code of theirs is restated here.
 */
export function decodeFoundationAttemptRequest(input: unknown): FoundationAttemptDecodeResult {
  const outer = exactKeys(input, FOUNDATION_ATTEMPT_REQUEST_KEYS);
  if (outer === null) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  // The TOP level is read by descriptor too. Reading `outer[key]` first would
  // invoke a hostile getter before the nested fence below could ever see it, so
  // the outermost slot is exactly where the snapshot has to begin.
  const slot: Record<string, unknown> = {};
  for (const key of FOUNDATION_ATTEMPT_REQUEST_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(outer, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    }
    slot[key] = descriptor.value;
  }
  const bytes = slot["activationRequestBytes"];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  const rest = snapshot({
    binding: slot["binding"], graphSnapshot: slot["graphSnapshot"],
    inputManifest: slot["inputManifest"], launchTemplate: slot["launchTemplate"],
  });
  if (rest === HOSTILE) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  const safe = rest as Record<string, unknown>;
  const binding = exactKeys(safe["binding"], FOUNDATION_ATTEMPT_BINDING_KEYS);
  const manifest = exactKeys(safe["inputManifest"], FOUNDATION_ATTEMPT_INPUT_KEYS);
  const template = exactKeys(safe["launchTemplate"], FOUNDATION_ATTEMPT_TEMPLATE_KEYS);
  if (binding === null || manifest === null || template === null) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  const environment = stringRecord(template["environment"]);
  const argv = template["argv"], entries = manifest["entries"];
  if (
    !text(binding["attemptAggregateId"]) || !text(binding["nodeKey"]) || !text(binding["sessionId"])
    || !text(manifest["baseIdentity"]) || !Array.isArray(entries) || !Array.isArray(argv)
    || !argv.every(text) || !text(template["cwd"]) || environment === null
    || !text(template["bootstrapCredentialDigest"])
  ) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      activationRequestBytes: bytes,
      binding: Object.freeze({
        attemptAggregateId: binding["attemptAggregateId"], nodeKey: binding["nodeKey"],
        sessionId: binding["sessionId"],
      }),
      graphSnapshot: safe["graphSnapshot"],
      inputManifest: Object.freeze({
        baseIdentity: manifest["baseIdentity"], entries: Object.freeze([...entries]),
      }),
      launchTemplate: Object.freeze({
        argv: Object.freeze([...argv]),
        bootstrapCredentialDigest: template["bootstrapCredentialDigest"], cwd: template["cwd"],
        environment, launchSelection: template["launchSelection"], limits: template["limits"],
        runtime: template["runtime"],
      }),
    }),
  });
}

const encoder = new TextEncoder();
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
/** Sorted-key JSON: the digest cannot depend on which branch built the object. */
function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError("canonical depth");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("canonical type");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
}
export type FoundationCodecResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly digest: string }
  | FoundationAttemptRefused;
/** One encoder for both durable payloads, so their bytes cannot drift apart. */
export function encodeFoundationPayload(value: unknown): FoundationCodecResult {
  let bytes: Uint8Array;
  try {
    bytes = encoder.encode(canonical(value));
  } catch {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  if (bytes.byteLength > MAX_BYTES) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  return Object.freeze({ bytes, digest: sha256Hex(bytes), ok: true as const });
}
export type FoundationDecodedPayload =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | FoundationAttemptRefused;
export function decodeFoundationPayload(bytes: unknown): FoundationDecodedPayload {
  if (!(bytes instanceof Uint8Array)) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  const value = decoded.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  return Object.freeze({ ok: true as const, value: value as Record<string, unknown> });
}
export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => right[index] === byte);
/**
 * DERIVED FROM, AND DISJOINT FROM, the activation aggregate: versions 1..3 there
 * belong to the launch-authority transitions, so a reservation written on that
 * aggregate would collide with the grant consumption it exists to fence.
 */
export function deriveDispatchAggregateId(attemptAggregateId: string): string {
  const framed = `${FOUNDATION_ATTEMPT_SCHEMA_VERSION}\n${attemptAggregateId.length}\n${attemptAggregateId}`;
  return `foundation-dispatch-${sha256Hex(encoder.encode(framed))}`;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const textOf = (value: unknown, key: string): string | null =>
  isRecord(value) && typeof value[key] === "string" ? (value[key] as string) : null;

/** The server-derived identities one dispatch is pinned to for its whole life. */
export interface FoundationAttemptBound {
  readonly aggregateId: string; readonly claim: Record<string, unknown>;
  readonly commandId: string; readonly correlationId: string; readonly nodeKey: string;
  readonly principalId: string; readonly projectId: string; readonly sessionId: string;
  readonly target: string;
}
export interface FoundationAttemptRecordParts {
  readonly observation: unknown; readonly reasonCode: string | null;
  readonly reasonLayer: string | null; readonly registration: unknown;
  readonly resultManifest: Record<string, unknown> | null; readonly truthClass: string;
}

/** Exactly one execution-bearing node, and it must be the node asked for. A graph
 *  fault keeps the SCHEDULER's own issue code: this layer did not decide it. */
export function admitSingleExecutionNode(
  request: FoundationAttemptDispatchRequest,
): string | FoundationAttemptRefused {
  const graph = validateGraphSnapshot(request.graphSnapshot);
  if (!graph.ok) {
    return foundationAttemptRefusal(
      graph.issues[0]?.code ?? "GRAPH_MALFORMED_SNAPSHOT", SCHEDULER_GRAPH_LAYER);
  }
  const bearing = graph.graph.nodes.filter((node) => node.executionBearing);
  if (bearing.length > 1) return refuseLocal("FOUNDATION_ATTEMPT_MULTI_NODE_UNSUPPORTED");
  const only = bearing[0];
  if (only === undefined) return refuseLocal("FOUNDATION_ATTEMPT_NODE_UNKNOWN");
  return only.nodeKey === request.binding.nodeKey ? only.nodeKey
    : refuseLocal("FOUNDATION_ATTEMPT_BINDING_MISMATCH");
}

/** Copied by allow-list, never by spread: an observation is the runner's record
 *  and may carry fields this daemon has no business persisting. */
const OBSERVED_KEYS = Object.freeze([
  "completedAt", "consumedGrantDigest", "freshRuntimeDigest", "observationDigest",
  "pinnedClosureDigest", "quotedRuntimeDigest", "registrationDigest", "runtimeBindingDigest",
  "startedAt",
] as const);
const REGISTRATION_KEYS = Object.freeze([
  "bootstrapCredentialDigest", "lockIdentity", "processIdentity", "registeredAt",
  "wrapperIdentity",
] as const);
const pick = (source: unknown, keys: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(keys.map((key) => [key, textOf(source, key)]));

export function attemptRecordBody(
  bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  input: Record<string, unknown>, parts: FoundationAttemptRecordParts,
): Record<string, unknown> {
  const streams = isRecord(parts.observation) ? parts.observation : {};
  return {
    activationDigest: record.activationDigest, advisoryOnly: true,
    attemptAggregateId: bound.aggregateId, attemptId: record.attempt.attemptId,
    effectId: record.effectIntent.intentId, grantId: record.grant.grantId, inputManifest: input,
    nodeKey: bound.nodeKey, observation: pick(parts.observation, OBSERVED_KEYS),
    reasonCode: parts.reasonCode, reasonLayer: parts.reasonLayer,
    recordVersion: FOUNDATION_ATTEMPT_RECORD_VERSION,
    registration: pick(parts.registration, REGISTRATION_KEYS), resultManifest: parts.resultManifest,
    sessionId: bound.sessionId, stderrSha256: textOf(streams["stderr"], "sha256"),
    stdoutSha256: textOf(streams["stdout"], "sha256"), truthClass: parts.truthClass,
    wrapperIdentity: record.grant.wrapperIdentity,
  };
}

/** Every authority field is the DURABLE one. `priorRegistration` and
 *  `duplicateDelivery` are pinned null: a reservation is not a prior process. */
export function launchRequestBody(
  record: ActivationLedgerRecord, bound: FoundationAttemptBound,
  template: FoundationAttemptLaunchTemplate,
): Record<string, unknown> {
  return {
    argv: template.argv, attempt: record.attempt,
    bootstrapCredentialDigest: template.bootstrapCredentialDigest, claim: bound.claim,
    cwd: template.cwd, duplicateDelivery: null, effect: record.effectIntent,
    environment: template.environment, grant: record.grant,
    launchSelection: template.launchSelection, limits: template.limits, priorRegistration: null,
    reconciliation: null, runtime: template.runtime,
    wrapperIdentity: record.grant.wrapperIdentity,
  };
}
