import { isProxy } from "node:util/types";

import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import type {
  AcceptanceContract,
  AcceptanceContractRefusal,
  PlanRevision,
  PlanRevisionHashes,
  PlanRevisionRefusal,
} from "@moe/core";

/**
 * Shape half of the daemon-owned planning-authority envelope: the closed versioned record, its
 * refusal vocabulary, and the descriptor-safe readers for the shell members this module owns
 * (bindings, sealed submission, sealed hashes). The cross-binding decisions and the core codec
 * composition live in `planning-authority-envelope.ts`; the two halves are split only for the
 * per-file line cap and share one test file.
 *
 * The layer constant stays module-private on purpose. `tests/security/boundary-roster.security.ts`
 * scans production sources for `export const *_LAYER`, and an exported one owes the roster a
 * BEFORE/AFTER/RACE trio. The closed TYPE is exported instead, which is what callers need.
 */
const LAYER = "PLANNING_AUTHORITY_ENVELOPE" as const;

export type PlanningAuthorityEnvelopeLayer = typeof LAYER;
export const PLANNING_AUTHORITY_ENVELOPE_VERSION = "moe-planning-authority-envelope/1" as const;
export const PLANNING_AUTHORITY_ENVELOPE_LIMITS = Object.freeze({
  maxBytes: MAX_JSON_BODY_BYTES, maxCriterionIds: 512, maxIdBytes: 512,
});
export const PLANNING_AUTHORITY_ENVELOPE_CODES = Object.freeze([
  "PLANNING_AUTHORITY_ENVELOPE_MALFORMED", "PLANNING_AUTHORITY_ENVELOPE_VERSION_UNSUPPORTED",
  "PLANNING_AUTHORITY_ENVELOPE_LIMIT_EXCEEDED", "PLANNING_AUTHORITY_ENVELOPE_BYTES_INVALID",
  "PLANNING_AUTHORITY_ENVELOPE_DUPLICATE_KEY", "PLANNING_AUTHORITY_ENVELOPE_NONCANONICAL",
  "PLANNING_AUTHORITY_ENVELOPE_GATE_UNSATISFIED", "PLANNING_AUTHORITY_PROJECT_MISMATCH",
  "PLANNING_AUTHORITY_GOAL_MISMATCH", "PLANNING_AUTHORITY_RUN_MISMATCH",
  "PLANNING_AUTHORITY_REVISION_MISMATCH", "PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH",
  "PLANNING_AUTHORITY_APPLICABILITY_MISMATCH", "PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH",
  "PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", "PLANNING_AUTHORITY_CRITERIA_DIGEST_MISMATCH",
  "PLANNING_AUTHORITY_CRITERIA_BINDING_MISMATCH",
] as const);

export type PlanningAuthorityEnvelopeCode = (typeof PLANNING_AUTHORITY_ENVELOPE_CODES)[number];

export interface PlanningAuthorityBindings {
  readonly goalRef: string; readonly projectId: string;
  readonly revisionId: string; readonly runId: string;
}
export interface PlanningAuthoritySubmission {
  readonly criteriaDigest: string; readonly goalRef: string; readonly graphRevisionRef: string;
  readonly lifecycle: "PLAN_REVIEW"; readonly projectId: string; readonly runId: string;
  readonly sealedHashes: PlanRevisionHashes; readonly submissionHash: string;
}
export interface PlanningAuthorityEnvelope {
  readonly acceptanceContract: AcceptanceContract;
  readonly bindings: PlanningAuthorityBindings;
  readonly planRevision: PlanRevision;
  readonly submission: PlanningAuthoritySubmission;
  readonly version: typeof PLANNING_AUTHORITY_ENVELOPE_VERSION;
}
export interface PlanningAuthorityEnvelopeRefusal {
  readonly code: PlanningAuthorityEnvelopeCode;
  readonly layer: PlanningAuthorityEnvelopeLayer;
  readonly ok: false;
}
/** Three vocabularies can answer; the `layer` field is what tells a caller which one did. */
export type PlanningAuthorityRefusal =
  | AcceptanceContractRefusal | PlanRevisionRefusal | PlanningAuthorityEnvelopeRefusal;
export type PlanningAuthorityAdmitResult =
  | Readonly<{ envelope: PlanningAuthorityEnvelope; ok: true }> | PlanningAuthorityRefusal;
export type PlanningAuthorityEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }> | PlanningAuthorityRefusal;

export const ENVELOPE_KEYS = Object.freeze([
  "acceptanceContract", "bindings", "planRevision", "submission", "version",
]);
const BINDING_KEYS = Object.freeze(["goalRef", "projectId", "revisionId", "runId"]);
const SUBMISSION_KEYS = Object.freeze(["criteriaDigest", "goalRef", "graphRevisionRef",
  "lifecycle", "projectId", "runId", "sealedHashes", "submissionHash"]);
const SUBMISSION_TEXT_KEYS = Object.freeze(["goalRef", "graphRevisionRef", "projectId", "runId"]);
const HASH_KEYS = Object.freeze([
  "dependencyHash", "graphContentHash", "planHash", "qualityHash",
]);
const HEX64 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export function refuse(code: PlanningAuthorityEnvelopeCode): PlanningAuthorityEnvelopeRefusal {
  return Object.freeze({ code, layer: LAYER, ok: false as const });
}
export const malformed = (): PlanningAuthorityEnvelopeRefusal =>
  refuse("PLANNING_AUTHORITY_ENVELOPE_MALFORMED");
export const exceeded = (): PlanningAuthorityEnvelopeRefusal =>
  refuse("PLANNING_AUTHORITY_ENVELOPE_LIMIT_EXCEEDED");
export const refused = (value: object): value is PlanningAuthorityEnvelopeRefusal => "ok" in value;
const hex64 = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);

/**
 * Descriptor-safe and exact: an accessor, a symbol key, an extra key, a missing key or a hostile
 * prototype all fail here, and no getter is ever invoked.
 *
 * The return value is a fresh null-prototype SNAPSHOT of the descriptor values, never the caller's
 * object. Every member is therefore read exactly once, at validation time: a later read cannot
 * observe a different value than the one that was bounds-checked. Proxies are refused outright
 * (mirroring `plan-revision-contract.ts`), because a `getOwnPropertyDescriptor` trap can report a
 * data descriptor the matching `get` trap then contradicts.
 */
export function exactRecord(
  value: unknown, keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Reflect.ownKeys(value).length !== keys.length) return undefined;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function boundedTexts(
  record: Readonly<Record<string, unknown>>, keys: readonly string[],
): PlanningAuthorityEnvelopeRefusal | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) return malformed();
    if (encoder.encode(value).byteLength > PLANNING_AUTHORITY_ENVELOPE_LIMITS.maxIdBytes) {
      return exceeded();
    }
  }
  return undefined;
}

export function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("planning authority canonicalization received an unadmitted value");
}

export function readBindings(
  value: unknown,
): PlanningAuthorityBindings | PlanningAuthorityEnvelopeRefusal {
  const record = exactRecord(value, BINDING_KEYS);
  if (record === undefined) return malformed();
  const bounded = boundedTexts(record, BINDING_KEYS);
  return bounded ?? Object.freeze({
    goalRef: record["goalRef"] as string, projectId: record["projectId"] as string,
    revisionId: record["revisionId"] as string, runId: record["runId"] as string,
  });
}

function readHashes(value: unknown): PlanRevisionHashes | PlanningAuthorityEnvelopeRefusal {
  const record = exactRecord(value, HASH_KEYS);
  if (record === undefined || !HASH_KEYS.every((key) => hex64(record[key]))) return malformed();
  return Object.freeze({
    dependencyHash: record["dependencyHash"] as string,
    graphContentHash: record["graphContentHash"] as string,
    planHash: record["planHash"] as string, qualityHash: record["qualityHash"] as string,
  });
}

/**
 * The gate: an unsealed run has no authority to carry, so a non-PLAN_REVIEW lifecycle is refused
 * here rather than normalized into one.
 */
export function readSubmission(
  value: unknown,
): PlanningAuthoritySubmission | PlanningAuthorityEnvelopeRefusal {
  const record = exactRecord(value, SUBMISSION_KEYS);
  if (record === undefined) return malformed();
  if (record["lifecycle"] !== "PLAN_REVIEW") {
    return refuse("PLANNING_AUTHORITY_ENVELOPE_GATE_UNSATISFIED");
  }
  const bounded = boundedTexts(record, SUBMISSION_TEXT_KEYS);
  if (bounded !== undefined) return bounded;
  if (!hex64(record["criteriaDigest"]) || !hex64(record["submissionHash"])) return malformed();
  const sealedHashes = readHashes(record["sealedHashes"]);
  if (refused(sealedHashes)) return sealedHashes;
  return Object.freeze({
    criteriaDigest: record["criteriaDigest"], goalRef: record["goalRef"] as string,
    graphRevisionRef: record["graphRevisionRef"] as string, lifecycle: "PLAN_REVIEW" as const,
    projectId: record["projectId"] as string, runId: record["runId"] as string,
    sealedHashes, submissionHash: record["submissionHash"],
  });
}
