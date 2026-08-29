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

import { Buffer } from "node:buffer";

import type { ClaudeLaunchRequest } from "@moe/runner";
import { validateGraphSnapshot } from "@moe/scheduler";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { isRecord, textOf } from "./foundation-attempt-codec.js";
import type { FoundationContextSealed } from "./foundation-context-record.js";
export {
  decodeFoundationAttemptRequest, decodeFoundationPayload, deriveDispatchAggregateId,
  encodeFoundationPayload, exactKeys, identifyFoundationDispatch, isRecord,
  sameBytes, sha256Hex, textOf,
} from "./foundation-attempt-codec.js";
export type {
  FoundationAttemptDecodeResult, FoundationCodecResult, FoundationDecodedPayload,
} from "./foundation-attempt-codec.js";

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
 * Closed, and every member has a producer in this package. A refusal raised by
 * the activation ingress, the scheduler, the runner or the store keeps ITS OWN
 * code and layer verbatim — flattening them here would make a graph fault
 * indistinguishable from a consumed grant. That is also why there is no daemon
 * code for a refused result manifest: `buildResultManifest` answers that under
 * the runner's own code at `RUNNER_WORKSPACE_LAYER`, and a second vocabulary for
 * one condition would only make the two indistinguishable again.
 */
export const FOUNDATION_ATTEMPT_CODES = Object.freeze([
  "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", "FOUNDATION_ATTEMPT_RECORD_ABSENT",
  "FOUNDATION_ATTEMPT_MULTI_NODE_UNSUPPORTED", "FOUNDATION_ATTEMPT_NODE_UNKNOWN",
  "FOUNDATION_ATTEMPT_BINDING_MISMATCH", "FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID",
  "FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE", "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE",
  "FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS", "FOUNDATION_ATTEMPT_DISPATCH_SUSPECT",
  "FOUNDATION_ATTEMPT_REPLAY_MISMATCH",
  "FOUNDATION_ATTEMPT_CONTEXT_BYTES_UNDELIVERABLE",
  "FOUNDATION_ATTEMPT_CONTEXT_TEMPLATE_UNBOUND",
  "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN", "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN",
  "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", "FOUNDATION_ATTEMPT_RECORD_DRIFT",
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
export const FOUNDATION_ATTEMPT_RUNTIME_KEYS = Object.freeze([
  "installedRoot", "pinRoot", "quotedObservation",
] as const);
export interface FoundationAttemptBinding {
  readonly attemptAggregateId: string; readonly nodeKey: string; readonly sessionId: string;
}
export interface FoundationAttemptLaunchTemplate {
  readonly argv: readonly string[]; readonly bootstrapCredentialDigest: string;
  readonly cwd: string; readonly environment: Readonly<Record<string, string>>;
  readonly launchSelection: unknown; readonly limits: unknown;
  readonly runtime: { readonly installedRoot: string; readonly pinRoot: string;
    readonly quotedObservation: Record<string, unknown> };
}
export interface FoundationAttemptDispatchRequest {
  readonly activationRequestBytes: Uint8Array;
  readonly binding: FoundationAttemptBinding;
  readonly graphSnapshot: unknown;
  readonly inputManifest: { readonly baseIdentity: string; readonly entries: readonly unknown[] };
  readonly launchTemplate: FoundationAttemptLaunchTemplate;
}

export function preActivationBindingMatches(
  request: FoundationAttemptDispatchRequest, payload: Record<string, unknown>,
): boolean | null {
  const activation = isRecord(payload["activation"]) ? payload["activation"] : null;
  const attempt = isRecord(activation?.["attempt"]) ? activation["attempt"] : null;
  const effect = isRecord(payload["effect"]) ? payload["effect"] : null;
  const intent = isRecord(effect?.["intent"]) ? effect["intent"] : null;
  const lease = isRecord(payload["lease"]) ? payload["lease"] : null;
  const record = isRecord(lease?.["record"]) ? lease["record"] : null;
  const aggregateId = textOf(intent, "aggregateId"), key = textOf(intent, "idempotencyKey");
  const attemptId = textOf(attempt, "aggregateId"), sessionId = textOf(record, "ownerSessionRef");
  if (aggregateId === null || key === null || attemptId === null || sessionId === null) return null;
  return attemptId === aggregateId && request.binding.sessionId === sessionId
    && request.binding.attemptAggregateId === deriveActivationAggregateId(aggregateId, key);
}

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
  "completedAt", "consumedGrantDigest", "contextManifestDigest", "deliveredByteLength",
  "freshRuntimeDigest", "observationDigest", "pinnedClosureDigest", "quotedRuntimeDigest",
  "registrationDigest", "runtimeBindingDigest", "startedAt",
] as const);
const REGISTRATION_KEYS = Object.freeze([
  "bootstrapCredentialDigest", "lockIdentity", "processIdentity", "registeredAt",
  "wrapperIdentity",
] as const);
const pick = (source: unknown, keys: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(keys.map((key) => [key, textOf(source, key)]));
const numberOf = (source: unknown, key: string): number | null => {
  try {
    const value = isRecord(source) ? source[key] : null;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
};
const projectObservation = (source: unknown): Record<string, string | number | null> =>
  Object.fromEntries(OBSERVED_KEYS.map((key) =>
    [key, key === "deliveredByteLength" ? numberOf(source, key) : textOf(source, key)]));

export function attemptRecordBody(
  bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  input: Record<string, unknown>, parts: FoundationAttemptRecordParts,
): Record<string, unknown> {
  const streams = isRecord(parts.observation) ? parts.observation : {};
  return {
    activationDigest: record.activationDigest, advisoryOnly: true,
    attemptAggregateId: bound.aggregateId, attemptId: record.attempt.attemptId,
    effectId: record.effectIntent.intentId, grantId: record.grant.grantId, inputManifest: input,
    nodeKey: bound.nodeKey, observation: projectObservation(parts.observation),
    reasonCode: parts.reasonCode, reasonLayer: parts.reasonLayer,
    recordVersion: FOUNDATION_ATTEMPT_RECORD_VERSION,
    registration: pick(parts.registration, REGISTRATION_KEYS), resultManifest: parts.resultManifest,
    sessionId: bound.sessionId, stderrSha256: textOf(streams["stderr"], "sha256"),
    stdoutSha256: textOf(streams["stdout"], "sha256"), truthClass: parts.truthClass,
    wrapperIdentity: record.grant.wrapperIdentity,
  };
}

/** Every launch authority field comes from the durable seal. Only the prepared
 *  assignment cwd and recorded bootstrap digest remain caller-record fields. */
export function launchRequestBody(
  record: ActivationLedgerRecord, bound: FoundationAttemptBound,
  context: FoundationContextSealed,
  caller: Pick<FoundationAttemptLaunchTemplate, "bootstrapCredentialDigest" | "cwd">,
  runtime: ClaudeLaunchRequest["runtime"],
): ClaudeLaunchRequest | FoundationAttemptRefused {
  const { template } = context;
  if (!Buffer.from(template.renderedContext.bytes).equals(Buffer.from(context.bytes))
    || template.renderedContext.manifest.digest !== context.contextManifestDigest) {
    return refuseLocal("FOUNDATION_ATTEMPT_CONTEXT_TEMPLATE_UNBOUND");
  }
  let renderedContext: string;
  try {
    renderedContext = new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(context.bytes));
  } catch {
    return refuseLocal("FOUNDATION_ATTEMPT_CONTEXT_BYTES_UNDELIVERABLE");
  }
  if (!Buffer.from(renderedContext, "utf8").equals(Buffer.from(context.bytes))) {
    return refuseLocal("FOUNDATION_ATTEMPT_CONTEXT_BYTES_UNDELIVERABLE");
  }
  return {
    argv: template.argv, attempt: record.attempt,
    bootstrapCredentialDigest: caller.bootstrapCredentialDigest, claim: bound.claim,
    contextManifestDigest: context.contextManifestDigest, cwd: caller.cwd,
    duplicateDelivery: null, effect: record.effectIntent,
    environment: template.environment, grant: record.grant,
    launchSelection: template.launchSelection, limits: template.limits, priorRegistration: null,
    reconciliation: null, renderedContext, runtime,
    wrapperIdentity: record.grant.wrapperIdentity,
  } satisfies ClaudeLaunchRequest;
}
