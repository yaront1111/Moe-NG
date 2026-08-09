import { isCount, isPlainArray, readList, readOwnDataProperty } from "../supervisor/effect-shape.js";

/**
 * Closed vocabulary for predecessor input materialization.
 *
 * A `NodeInputManifest` is the immutable sealed result over the graph base and
 * the exact accepted predecessor artifact closure. It is content-addressed, so
 * the version literal below is pinned: a digest is only comparable across time
 * if the field set it covers is named by a version that changes when the field
 * set does.
 *
 * Every refusal in this area is constructed here. No sibling module declares a
 * code of its own, which is what makes the vocabulary closed and lets a sweep
 * prove that the declared set and the reachable set are the same set.
 */
export const NODE_INPUT_MANIFEST_VERSION = "moe-node-input-manifest/1" as const;

/**
 * Ceilings are applied to a declared length BEFORE any element is read, so an
 * oversized closure costs one comparison rather than a full traversal.
 */
export const MAX_PREDECESSOR_CANDIDATES = 512;
export const MAX_ARTIFACTS_PER_PREDECESSOR = 256;
export const MAX_SELECTED_INPUTS = 4096;
export const MAX_MATERIALIZATION_WITNESSES = 128;
export const MAX_MATERIALIZATION_CONTRACTS = 128;
export const MAX_ENVIRONMENT_REQUIREMENTS = 128;
export const MAX_MATERIALIZATION_TEXT_CHARS = 400;

/**
 * Which gate refused. Recorded on every failure because more than one layer can
 * refuse the same call: without this, a selection gate answering first would
 * leave a staleness test green while it no longer exercises staleness at all.
 */
export const MATERIALIZATION_REFUSAL_LAYERS = Object.freeze([
  "SELECTION",
  "WITNESS",
  "SEAL",
  "STALENESS",
] as const);

export type MaterializationRefusalLayer = (typeof MATERIALIZATION_REFUSAL_LAYERS)[number];

/**
 * Closed rejection vocabulary. A deduplicated identity, an ambiguous producer,
 * and an unqualified milestone are different facts about a closure; collapsing
 * them would let a genuine producer conflict pass as a harmless duplicate, so
 * each keeps its own code.
 */
export const RUNNER_MATERIALIZATION_ERROR_CODES = Object.freeze([
  "RUNNER_MATERIALIZATION_CLOSURE_MALFORMED",
  "RUNNER_MATERIALIZATION_CLOSURE_LIMIT",
  "RUNNER_MATERIALIZATION_CANDIDATE_MALFORMED",
  "RUNNER_MATERIALIZATION_ARTIFACT_LIMIT",
  "RUNNER_MATERIALIZATION_BASE_INVALID",
  "RUNNER_MATERIALIZATION_MILESTONE_UNQUALIFIED",
  "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
  "RUNNER_MATERIALIZATION_SELECTION_LIMIT",
  "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
  "RUNNER_MATERIALIZATION_CONTRACT_LIMIT",
  "RUNNER_MATERIALIZATION_REGISTRY_MALFORMED",
  "RUNNER_MATERIALIZATION_MONOTONIC_OPERATION_MISMATCH",
  "RUNNER_MATERIALIZATION_WITNESS_FACTS_MALFORMED",
  "RUNNER_MATERIALIZATION_WITNESS_MISSING",
  "RUNNER_MATERIALIZATION_WITNESS_VERSION_CHANGED",
  "RUNNER_MATERIALIZATION_WITNESS_DIGEST_CHANGED",
  "RUNNER_MATERIALIZATION_SELECTION_INVALID",
  "RUNNER_MATERIALIZATION_AUTHORITY_INVALID",
  "RUNNER_MATERIALIZATION_ENVIRONMENT_INVALID",
  "RUNNER_MATERIALIZATION_EPOCH_INVALID",
  "RUNNER_MATERIALIZATION_PROVIDER_RUNTIME_INVALID",
  "RUNNER_MATERIALIZATION_MANIFEST_TAMPERED",
  "RUNNER_MATERIALIZATION_WITNESS_STALE",
  "RUNNER_MATERIALIZATION_PREDECESSOR_STALE",
  "RUNNER_MATERIALIZATION_EPOCH_STALE",
] as const);

export type RunnerMaterializationErrorCode = (typeof RUNNER_MATERIALIZATION_ERROR_CODES)[number];

/**
 * Mirrored verbatim from `@moe/scheduler` `DependencyContractBase`'s
 * `minimumQualifyingMilestone`. Declared in rank order, low to high, so
 * qualification is an index comparison rather than a hand-maintained table that
 * could disagree with the list beside it.
 */
export const QUALIFYING_MILESTONES = Object.freeze([
  "CANDIDATE_SEALED",
  "RESULT_SEALED",
  "EVIDENCE_SEALED",
  "INTEGRATION_SEALED",
  "REVIEW_QUALIFIED",
  "ACCEPTED",
] as const);

export type QualifyingMilestone = (typeof QUALIFYING_MILESTONES)[number];

export function milestoneRank(milestone: QualifyingMilestone): number {
  return QUALIFYING_MILESTONES.indexOf(milestone);
}

/**
 * `detail` names the exact element that refused — an artifact identity, a
 * witness ref, a node key. It is never a free-form explanation: a consumer
 * branches on `code` and quarantines by `detail`.
 */
export interface MaterializationFailure {
  readonly ok: false;
  readonly code: RunnerMaterializationErrorCode;
  readonly layer: MaterializationRefusalLayer;
  readonly message: string;
  readonly detail: string | null;
}

export function materializationFailure(
  code: RunnerMaterializationErrorCode,
  layer: MaterializationRefusalLayer,
  message: string,
  detail: string | null = null,
): MaterializationFailure {
  return Object.freeze({ ok: false as const, code, layer, message, detail });
}

export function isMaterializationFailure(value: object): value is MaterializationFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

/**
 * A declared length is compared to the ceiling BEFORE any element is read, so an
 * oversized list cannot be walked at all, and a ceiling breach is reported
 * separately from a malformed shape: they are different facts and a caller
 * retries only one of them.
 */
export type BoundedListRead =
  | { readonly kind: "OK"; readonly items: readonly unknown[] }
  | { readonly kind: "LIMIT" }
  | { readonly kind: "MALFORMED" };

export function readBoundedList(value: unknown, maximum: number): BoundedListRead {
  if (!isPlainArray(value)) {
    return { kind: "MALFORMED" };
  }
  const length = readOwnDataProperty(value, "length");
  if (!length.ok || !length.present || !isCount(length.value)) {
    return { kind: "MALFORMED" };
  }
  if (length.value > maximum) {
    return { kind: "LIMIT" };
  }
  const items = readList(value, maximum);
  return items === null ? { kind: "MALFORMED" } : { kind: "OK", items };
}

/**
 * Machine graph identifiers are ASCII-only. Mirrored from `@moe/scheduler`
 * `isGraphKey` and its `MAX_GRAPH_KEY_CODE_UNITS` ceiling: a mirror that
 * accepted a key the authority rejects would admit records the graph itself
 * cannot name.
 */
export const MAX_GRAPH_KEY_CODE_UNITS = 128;

const SAFE_GRAPH_KEY = /^[A-Za-z0-9_][A-Za-z0-9._:@/+~-]*$/u;

export function isMirroredGraphKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_GRAPH_KEY_CODE_UNITS &&
    SAFE_GRAPH_KEY.test(value)
  );
}
