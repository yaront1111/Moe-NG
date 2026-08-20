/**
 * The closed, versioned NodeDefinition authority body of design lines 199/255:
 * its field roster, bounds, refusal vocabulary and shapes.
 *
 * It also owns the canonical form of that roster: the sorted-key serializer, the
 * domain-separated digest and the envelope spelling. Those are internal — a
 * consumer able to call {@link nodeBodyDigest} directly could mint an identity
 * for a body no admission ever accepted, so the codec stays the only route to
 * one. Nothing here judges input; the field reader and the codec do that.
 *
 * Split from the field reader, the composition step and the codec only to keep
 * each production source inside the per-file line cap, exactly as the
 * graph-content family in this package is split.
 *
 * Nothing in this slice grants execution authority: the body is inert content,
 * every accepted value is deeply frozen, and no field is callable. Design 255
 * excludes mutable status, attempts, revision IDs, presentation metadata,
 * predecessor result selection and outgoing consumers, so those names are
 * REFUSED rather than dropped silently, and no caller-stated digest is accepted
 * at all — the plan and criterion identities are derived through @moe/core.
 *
 * NO LAYER CONSTANT IS EXPORTED. The security lane rosters every column-0
 * `export const *_LAYER(S)` declaration against a pinned size, so the layer
 * vocabulary stays module-private behind {@link NodeAuthorityLayer} and each
 * refusal states its layer as a value the caller compares.
 */
import { createHash } from "node:crypto";

import type {
  DependencyContract, MonotonicPredicateRegistryEntry,
} from "../dependencies/dependency-contract.js";
import type { AdmissionAmount, AdmissionGate } from "../budget/budget-reservation.js";

/** The wire tag; separate from the digest domain so the two rotate apart. */
export const NODE_AUTHORITY_SCHEMA_TAG = "MOE-NODE-AUTHORITY/2";
export const NODE_AUTHORITY_DIGEST_DOMAIN = "MOE-NODE-AUTHORITY-BODY-HASH/2";
export const NODE_AUTHORITY_SCHEMA_VERSION = 2 as const;
export const NODE_JOIN_ROLES = Object.freeze(["COMPLETION", "JOIN", "NONE"] as const);
export type NodeJoinRole = (typeof NODE_JOIN_ROLES)[number];
/** Closed only at the NodeDefinition authority boundary. The budget ledger keeps
 * its bounded string meter so an explicit future version can admit a new durable meter. */
export const NODE_ADMISSION_METERS = Object.freeze([
  "attempt.count", // Budget design 11.2 and the durable settlement reducer.
  "provider.cache_creation_input_tokens", // Provider-run normalized usage measurement.
  "provider.cache_read_input_tokens", // Provider-run normalized usage measurement.
  "provider.input_tokens", // Provider-run normalized usage measurement.
  "provider.output_tokens", // Provider-run normalized usage measurement.
  "runner.authorized_ms", // Budget design 11.2 and runnerAuthorizedMsPerAttempt.
  "verification.authorized_ms", // Budget design 11.2 verification reserve measurement.
] as const);
export type NodeAdmissionMeter = (typeof NODE_ADMISSION_METERS)[number];
/** The landed AdmissionAmount shape, narrowed only at this versioned authority boundary. */
export type NodeAdmissionAmount = AdmissionAmount & { readonly meter: NodeAdmissionMeter };
/** Policy only: the corresponding AdmissionGate witness is resolved later from durable facts. */
export const NODE_ADMISSION_GATE_POLICIES = Object.freeze([
  "HUMAN_APPROVAL", "POLICY_ALLOWANCE",
] as const);
export type NodeAdmissionGatePolicy = (typeof NODE_ADMISSION_GATE_POLICIES)[number];
export const NODE_ADMISSION_GATE_POLICY_WITNESS: Readonly<
  Record<NodeAdmissionGatePolicy, keyof AdmissionGate>
> = Object.freeze({ HUMAN_APPROVAL: "approval", POLICY_ALLOWANCE: "allowance" });

/** The closed field roster, alphabetical — the one canonical serialization order. */
export const NODE_DEFINITION_KEYS = Object.freeze([
  "admissionAmounts", "admissionGatePolicy", "capability", "completionLinkage", "constraints", "criterionBindings",
  "directHardDependencies", "joinRole", "monotonicPredicateProofs", "nodeKey", "objective",
  "planExecutionContentDigest", "policySliceHash", "readScopes", "repositoryBaseTree",
  "resources", "schemaVersion", "verificationRecipeRevisions", "writeScopes",
] as const);
export type NodeDefinitionKey = (typeof NODE_DEFINITION_KEYS)[number];
const DERIVED_KEYS: readonly string[] = ["criterionBindings", "monotonicPredicateProofs",
  "planExecutionContentDigest", "schemaVersion"];
/** The caller-stated subset; the four derived fields are never accepted as input. */
export const NODE_AUTHORITY_DRAFT_KEYS = Object.freeze(
  NODE_DEFINITION_KEYS.filter((key) => !DERIVED_KEYS.includes(key)),
);
/** Identity a caller may never state: derived here, or owned by another record. */
export const NODE_AUTHORITY_FORBIDDEN_IDENTITY_KEYS = Object.freeze([
  "criteriaDigest", "graphContentHash", "graphHash", "graphRevisionRef", "nodeAuthorityHash",
  "planHash", "predecessorAuthorityHash", "predecessorHash", "revisionId",
]);
/** State design 255 excludes from the execution contract outright. */
export const NODE_AUTHORITY_EXCLUDED_STATE_KEYS = Object.freeze([
  "attempt", "attemptState", "inputBinding", "inputBindingHash", "lease", "lifecycle",
  "outgoingConsumers", "result", "selectedWitnesses", "status", "workspace",
]);
export const NODE_AUTHORITY_CODES = Object.freeze([
  "NODE_AUTHORITY_APPLICABILITY_MISMATCH",
  "NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET_DUPLICATE_PAIR",
  "NODE_AUTHORITY_BUDGET_GATE_POLICY_INVALID", "NODE_AUTHORITY_BUDGET_GATE_WITNESS_FORBIDDEN",
  "NODE_AUTHORITY_BUDGET_LEGACY_SCALAR", "NODE_AUTHORITY_BUDGET_METER_UNKNOWN",
  "NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN",
  "NODE_AUTHORITY_DIGEST_MISMATCH", "NODE_AUTHORITY_DUPLICATE_EDGE", "NODE_AUTHORITY_EDGE_ORDER",
  "NODE_AUTHORITY_EXCLUDED_FIELD", "NODE_AUTHORITY_FIELD_INVALID",
  "NODE_AUTHORITY_JOIN_LINKAGE_INVALID", "NODE_AUTHORITY_LIMIT_EXCEEDED",
  "NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_MONOTONIC_PROOF_MISSING",
  "NODE_AUTHORITY_NONCANONICAL", "NODE_AUTHORITY_NOT_BYTES", "NODE_AUTHORITY_SCOPE_INVALID",
  "NODE_AUTHORITY_TOO_LARGE", "NODE_AUTHORITY_UNREADABLE", "NODE_AUTHORITY_UNSUPPORTED_SCHEMA",
] as const);
export type NodeAuthorityCode = (typeof NODE_AUTHORITY_CODES)[number];
const LAYER_NAMES = Object.freeze([
  "NODE_AUTHORITY_ADMISSION", "NODE_AUTHORITY_BUDGET", "NODE_AUTHORITY_CODEC", "NODE_AUTHORITY_DEPENDENCIES",
  "NODE_AUTHORITY_IDENTITY", "NODE_AUTHORITY_LIMITS", "NODE_AUTHORITY_PROOFS",
  "NODE_AUTHORITY_SCHEMA", "NODE_AUTHORITY_SCOPES", "DEPENDENCY_CONTRACT", "PLANNING_SOURCE",
] as const);
/**
 * Which layer refused. `DEPENDENCY_CONTRACT` and `PLANNING_SOURCE` name the two
 * foreign authorities whose OWN codes travel out unchanged under that layer, so a
 * caller can tell a validator's verdict from this slice's own.
 */
export type NodeAuthorityLayer = (typeof LAYER_NAMES)[number];
export const NODE_AUTHORITY_LIMITS = Object.freeze({
  maxAdmissionAmounts: 35, maxBytes: 1_048_576, maxCriterionBindings: 512,
  maxDependencyEntries: 128, maxIdBytes: 512,
  maxListEntries: 64, maxObjectiveBytes: 4096, maxProofEntries: 128, maxRationaleBytes: 1024,
  maxScopeBytes: 1024, maxScopeEntries: 128,
});

export interface NodeAuthorityIssue {
  readonly code: NodeAuthorityCode | string;
  readonly layer: NodeAuthorityLayer;
  readonly message: string;
}
export interface NodeAuthorityRefusal {
  readonly ok: false; readonly issues: readonly NodeAuthorityIssue[];
}
export interface NodeCriterionBinding {
  readonly contentDigest: string; readonly criterionId: string;
}
export interface NodeDependencyEntry {
  readonly contract: DependencyContract; readonly edgeKey: string;
}
export interface NodeAuthorityEdgeInput {
  readonly edgeKey: string; readonly requirement: unknown;
}
/**
 * The caller-stated half, normalized. `requirement` stays UNJUDGED here: only the
 * production dependency validator may rule on a dependency contract.
 */
export interface NodeAuthorityDraft {
  readonly admissionAmounts: readonly NodeAdmissionAmount[];
  readonly admissionGatePolicy: NodeAdmissionGatePolicy;
  readonly capability: string;
  readonly completionLinkage: string | null;
  readonly constraints: readonly string[];
  readonly directHardDependencies: readonly NodeAuthorityEdgeInput[];
  readonly joinRole: NodeJoinRole;
  readonly nodeKey: string;
  readonly objective: string;
  readonly policySliceHash: string;
  readonly readScopes: readonly string[];
  readonly repositoryBaseTree: string;
  readonly resources: readonly string[];
  readonly verificationRecipeRevisions: readonly string[];
  readonly writeScopes: readonly string[];
}
/** Design 199/255's nonrecursive execution contract. Immutable, inert content. */
export interface NodeDefinition extends Omit<NodeAuthorityDraft, "directHardDependencies"> {
  readonly criterionBindings: readonly NodeCriterionBinding[];
  readonly directHardDependencies: readonly NodeDependencyEntry[];
  readonly monotonicPredicateProofs: readonly MonotonicPredicateRegistryEntry[];
  readonly planExecutionContentDigest: string;
  readonly schemaVersion: typeof NODE_AUTHORITY_SCHEMA_VERSION;
}
export type NodeAuthorityDraftResult =
  | { readonly draft: NodeAuthorityDraft; readonly ok: true } | NodeAuthorityRefusal;
export type Read<T> = { readonly ok: true; readonly value: T } | NodeAuthorityRefusal;

export const ok = <T>(value: T): Read<T> => ({ ok: true as const, value });

export function refuse(
  code: NodeAuthorityCode, layer: NodeAuthorityLayer, message: string,
): NodeAuthorityRefusal {
  return Object.freeze({
    ok: false as const, issues: Object.freeze([Object.freeze({ code, layer, message })]),
  });
}
/** Surface a foreign authority's verdict unchanged; only the layer is added. */
export function passthrough(
  layer: NodeAuthorityLayer,
  issues: readonly { readonly code: string; readonly message?: string }[],
): NodeAuthorityRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code, layer, message: issue.message ?? issue.code,
    }))),
  });
}
/** Code-unit comparison, never `localeCompare`: design 255 requires the canonical
 * order to be locale-independent, and collation is the locale-dependent operation. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/** Sorted-key JSON with no whitespace. Every leaf reaching this is already
 * admitted — bounded text, safe integers, plain arrays and records — so nothing
 * unrepresentable can vanish from the bytes the digest is meant to cover. */
export function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`).join(",")}}`;
  }
  throw new TypeError("node authority canonicalization received an unadmitted value");
}

/** Domain-separated and length-framed, so no payload can shift across the domain
 * boundary to forge a different body under the same digest. */
export function nodeBodyDigest(bodyJson: string): string {
  return createHash("sha256")
    .update(`${NODE_AUTHORITY_DIGEST_DOMAIN}\n${bodyJson.length}:`, "utf8")
    .update(bodyJson, "utf8").digest("hex");
}

export function canonicalEnvelopeJson(digest: string, bodyJson: string): string {
  return `{"body":${bodyJson},"digest":${JSON.stringify(digest)},`
    + `"schema":${JSON.stringify(NODE_AUTHORITY_SCHEMA_TAG)}}`;
}
