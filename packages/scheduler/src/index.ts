/**
 * @moe/scheduler — pure structural graph-analysis kernel.
 *
 * Public surface:
 *  - validateGraphSnapshot: fail-closed structural validation -> ValidatedGraph.
 *  - analyzeGraphStructure: deterministic structural facts about a ValidatedGraph.
 *  - analyzeHardEdgeCounterfactuals: review-only source-edge pressure facts.
 *  - partitionFrontier: readiness partition from caller-supplied frontier facts.
 *
 * The kernel is contract-neutral: it reports exact structural facts and never
 * invents independence, deletes edges, infers semantic dependency truth, or
 * claims a decomposition is faster. See ./graph-model.ts for the full rationale.
 */

export { validateGraphSnapshot } from "./validate-graph.js";
export { analyzeGraphStructure } from "./analyze-graph.js";
export { analyzeHardEdgeCounterfactuals } from "./hard-edge-counterfactual.js";
export { GraphAnalysisError } from "./graph-analysis-error.js";
export { partitionFrontier } from "./frontier.js";
export {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  DEFAULT_GRAPH_POLICY,
  DEFAULT_MAX_HARD_EDGES,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TOTAL_EDGES,
  MIN_GATED_DESCENDANTS_FOR_REVIEW,
  MAX_GRAPH_KEY_CODE_UNITS,
  resolveGraphPolicy,
} from "./graph-policy.js";
export { createTraversalCounter } from "./graph-model.js";

export type {
  BlockedNode,
  BlockedReason,
  BlockedReasonCode,
  CriticalPathEdge,
  FrontierCursor,
  FrontierError,
  FrontierOk,
  FrontierPartition,
  FrontierResult,
  GraphEdge,
  GraphEdgeKind,
  GraphIssue,
  GraphIssueCode,
  GraphKey,
  GraphNode,
  GraphPolicy,
  GraphSnapshot,
  GraphStructuralAnalysis,
  GraphValidationError,
  GraphValidationOk,
  GraphValidationResult,
  HardEdgeFact,
  HardEdgeSatisfaction,
  NodeAvailabilityFact,
  NodeStructuralFacts,
  RedundancyCandidate,
  StructuralDiagnostic,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";
export type { GraphAnalysisErrorCode } from "./graph-analysis-error.js";
export type {
  HardEdgeCounterfactual,
  HardEdgeCounterfactualAnalysis,
} from "./hard-edge-counterfactual-model.js";
