import type { GraphPolicy } from "./graph-model.js";
import {
  hasOnlyOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
} from "./runtime-shape.js";

const POLICY_KEYS = Object.freeze([
  "maxHardEdges",
  "maxNodes",
  "maxTotalEdges",
  "minGatedDescendantsForReview",
] as const);

/**
 * Provisional default structural limits from the design (§8.3, line ~405):
 * at most 24 nodes in one active graph and 64 hard dependency edges.
 * `MIN_GATED_DESCENDANTS_FOR_REVIEW` is the threshold at which a critical-path
 * HARD edge earns a review-only interface-first diagnostic; the default of 1
 * flags any critical-path edge that gates at least one descendant.
 *
 * These names are the single source of truth for the defaults. Explicit policy
 * input may change them only within the immutable parser ceilings below; this
 * pure kernel does not grant the external approval required for activation.
 */
export const DEFAULT_MAX_NODES = 24 as const;
export const DEFAULT_MAX_HARD_EDGES = 64 as const;
/**
 * Provisional conservative default cap on the TOTAL edge count (HARD +
 * ADVISORY). This bounds advisory/organizational relations as an input/resource
 * guard. It is intentionally set equal to the hard-edge default (64) as a
 * conservative starting point but is a SEPARATE, independently overrideable
 * limit — NOT a frozen design fact, and never derived from the hard-edge cap.
 */
export const DEFAULT_MAX_TOTAL_EDGES = 64 as const;
export const MIN_GATED_DESCENDANTS_FOR_REVIEW = 1 as const;

/** Non-configurable parser ceilings; policy overrides may tighten, never exceed. */
export const ABSOLUTE_MAX_GRAPH_NODES = 64 as const;
export const ABSOLUTE_MAX_GRAPH_HARD_EDGES = 128 as const;
export const ABSOLUTE_MAX_GRAPH_TOTAL_EDGES = 128 as const;
export const MAX_GRAPH_KEY_CODE_UNITS = 128 as const;

export const DEFAULT_GRAPH_POLICY: GraphPolicy = Object.freeze({
  maxNodes: DEFAULT_MAX_NODES,
  maxHardEdges: DEFAULT_MAX_HARD_EDGES,
  maxTotalEdges: DEFAULT_MAX_TOTAL_EDGES,
  minGatedDescendantsForReview: MIN_GATED_DESCENDANTS_FOR_REVIEW,
});

/** True when a value is a finite, non-NaN integer >= 0. */
export function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/**
 * Resolve a caller policy against the frozen defaults. Any missing field falls
 * back to its default; the result is frozen so it cannot be mutated later. A
 * malformed override (NaN, negative, non-integer) is rejected by returning
 * `null` so the caller fails closed rather than running with a bad limit.
 */
export function resolveGraphPolicy(
  override?: unknown,
): GraphPolicy | null {
  if (override === undefined) {
    return DEFAULT_GRAPH_POLICY;
  }
  if (!isPlainRecord(override) || !hasOnlyOwnStringKeys(override, POLICY_KEYS)) {
    return null;
  }
  const maxNodesProperty = readOwnDataProperty(override, "maxNodes");
  const maxHardEdgesProperty = readOwnDataProperty(override, "maxHardEdges");
  const maxTotalEdgesProperty = readOwnDataProperty(override, "maxTotalEdges");
  const reviewThresholdProperty = readOwnDataProperty(
    override,
    "minGatedDescendantsForReview",
  );
  if (
    !maxNodesProperty.ok ||
    !maxHardEdgesProperty.ok ||
    !maxTotalEdgesProperty.ok ||
    !reviewThresholdProperty.ok
  ) {
    return null;
  }
  const maxNodes = maxNodesProperty.present
    ? maxNodesProperty.value
    : DEFAULT_MAX_NODES;
  const maxHardEdges = maxHardEdgesProperty.present
    ? maxHardEdgesProperty.value
    : DEFAULT_MAX_HARD_EDGES;
  const maxTotalEdges = maxTotalEdgesProperty.present
    ? maxTotalEdgesProperty.value
    : DEFAULT_MAX_TOTAL_EDGES;
  const minGatedDescendantsForReview = reviewThresholdProperty.present
    ? reviewThresholdProperty.value
    : MIN_GATED_DESCENDANTS_FOR_REVIEW;
  if (
    !isNonNegativeInteger(maxNodes) ||
    !isNonNegativeInteger(maxHardEdges) ||
    !isNonNegativeInteger(maxTotalEdges) ||
    !isNonNegativeInteger(minGatedDescendantsForReview) ||
    maxNodes > ABSOLUTE_MAX_GRAPH_NODES ||
    maxHardEdges > ABSOLUTE_MAX_GRAPH_HARD_EDGES ||
    maxTotalEdges > ABSOLUTE_MAX_GRAPH_TOTAL_EDGES ||
    minGatedDescendantsForReview > ABSOLUTE_MAX_GRAPH_NODES
  ) {
    return null;
  }
  return Object.freeze({
    maxNodes,
    maxHardEdges,
    maxTotalEdges,
    minGatedDescendantsForReview,
  });
}
