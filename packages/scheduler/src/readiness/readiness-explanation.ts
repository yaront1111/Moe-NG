/**
 * Design 8.2's explanation vocabulary over an already-decided projection.
 *
 * THIS MODULE DECIDES NOTHING. It reads `NodeReadinessProjection.logical /
 * admission / dispatch / reasons` and classifies; it never re-derives a layer.
 * A second derivation could disagree with the first and both would look
 * correct in isolation, so readiness is computed exactly once, in
 * ./readiness-projection.ts.
 *
 * Classification order is deliberately conservative — an earlier arm wins:
 *  1. no execution authority        -> UNSAFE_OR_UNKNOWN
 *  2. any UNKNOWN reason            -> UNSAFE_OR_UNKNOWN  (nothing may be
 *     dressed as nearer to ready than the truth supports)
 *  3. a CURRENT wait record         -> INTENTIONAL_WAIT
 *  4. dispatchable                  -> READY_NOW
 *  5. exactly one remaining AND its producer/recovery command known
 *                                   -> UNBLOCK_NEXT
 *  6. otherwise (including >1 remaining, fully enumerated)
 *                                   -> UNSAFE_OR_UNKNOWN
 */
import { deepFreeze } from "../admission/admission-model.js";
import { GraphAnalysisError } from "../graph-analysis-error.js";
import { buildHardGraphIndex } from "../graph-internal.js";
import { hasValidatedGraphProvenance } from "../graph-provenance.js";
import type { GraphKey, ValidatedGraph } from "../graph-model.js";
import type {
  NodeReadinessProjection,
  ReadinessProjection,
} from "./readiness-projection.js";
import {
  LEGAL_CHOICES,
  READINESS_CLASS_RANK,
  type LegalChoice,
  type ReadinessClass,
  type ReadinessReason,
} from "./readiness-model.js";

export interface FailedContract {
  readonly edgeKey: GraphKey;
  readonly producerNodeKey: GraphKey;
}

export interface ReadinessExplanation {
  readonly nodeKey: GraphKey;
  readonly readinessClass: ReadinessClass;
  /** Every outstanding predicate, enumerated in full even when there are many. */
  readonly reasons: readonly ReadinessReason[];
  readonly remainingCount: number;
  /** Exact failed HARD contracts; empty unless a predecessor failed. */
  readonly failedContracts: readonly FailedContract[];
  /** HARD descendants held behind this node; empty unless a predecessor failed. */
  readonly affectedDescendants: readonly GraphKey[];
  readonly legalChoices: readonly LegalChoice[];
}

export interface ReadinessExplanationReport {
  readonly graphIdentity: string;
  /** Ordered nearest-to-ready first; ties by remaining count, then node key. */
  readonly entries: readonly ReadinessExplanation[];
}

function classify(node: NodeReadinessProjection): ReadinessClass {
  if (!node.executionBearing) {
    return "UNSAFE_OR_UNKNOWN";
  }
  if (node.reasons.some((reason) => reason.confidence === "UNKNOWN")) {
    return "UNSAFE_OR_UNKNOWN";
  }
  if (node.waitCurrent) {
    return "INTENTIONAL_WAIT";
  }
  if (node.dispatch === "CONFIRMED_TRUE") {
    return "READY_NOW";
  }
  const only = node.reasons.length === 1 ? node.reasons[0] : undefined;
  return only !== undefined && only.recoveryRef !== null ? "UNBLOCK_NEXT" : "UNSAFE_OR_UNKNOWN";
}

/**
 * HARD descendants of `nodeKey`, excluding itself. Uses the landed HARD-edge
 * index so advisory overlay edges never widen the affected set.
 */
function descendantsOf(
  index: ReturnType<typeof buildHardGraphIndex>,
  nodeKey: GraphKey,
): GraphKey[] {
  const start = index.indexOf.get(nodeKey);
  if (start === undefined) {
    return [];
  }
  const seen = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const arc of index.hardOut[current]!) {
      if (!seen.has(arc.nodeIndex)) {
        seen.add(arc.nodeIndex);
        queue.push(arc.nodeIndex);
      }
    }
  }
  seen.delete(start);
  return [...seen].map((i) => index.nodeKeys[i]!).sort();
}

function failedContractsOf(node: NodeReadinessProjection): FailedContract[] {
  // An UNKNOWN hard dependency is not a FAILED one, and a reason without both
  // an edge and a producer names no contract — neither is reported as failed.
  return node.reasons
    .filter((reason) =>
      reason.code === "HARD_DEPENDENCY_UNSATISFIED" &&
      reason.edgeKey !== null &&
      reason.recoveryRef !== null)
    .map((reason) => ({
      edgeKey: reason.edgeKey!,
      producerNodeKey: reason.recoveryRef!,
    }));
}

/**
 * Explain an already-computed projection. One entry per projected node,
 * ordered so that no node is ever presented nearer to ready than its class
 * and remaining-predicate count allow.
 */
export function explainReadiness(
  graph: ValidatedGraph,
  projection: ReadinessProjection,
): ReadinessExplanationReport {
  if (!hasValidatedGraphProvenance(graph)) {
    throw new GraphAnalysisError(
      "GRAPH_VALIDATION_PROVENANCE_INVALID",
      "graph was not produced by this runtime's validateGraphSnapshot",
    );
  }
  // graph-model.ts:292: a projection computed for another graph must never be
  // used to explain readiness here. Its descendant closure would be silently
  // empty rather than wrong-looking, which is exactly the misleading answer.
  if (projection.graphIdentity !== graph.graphIdentity) {
    throw new GraphAnalysisError(
      "FRONTIER_GRAPH_IDENTITY_MISMATCH",
      "projection graphIdentity does not match the validated graph",
    );
  }
  const index = buildHardGraphIndex(graph);
  const entries = projection.nodes.map((node) => {
    const failedContracts = failedContractsOf(node);
    const hasFailedPredecessor = failedContracts.length > 0;
    return {
      nodeKey: node.nodeKey,
      readinessClass: classify(node),
      reasons: [...node.reasons],
      remainingCount: node.reasons.length,
      failedContracts,
      affectedDescendants: hasFailedPredecessor ? descendantsOf(index, node.nodeKey) : [],
      legalChoices: hasFailedPredecessor ? [...LEGAL_CHOICES] : [],
    };
  });
  entries.sort((a, b) => {
    const byClass = READINESS_CLASS_RANK[a.readinessClass] - READINESS_CLASS_RANK[b.readinessClass];
    if (byClass !== 0) {
      return byClass;
    }
    const byRemaining = a.remainingCount - b.remainingCount;
    if (byRemaining !== 0) {
      return byRemaining;
    }
    return a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0;
  });
  return deepFreeze({ graphIdentity: projection.graphIdentity, entries });
}
