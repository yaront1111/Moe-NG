/**
 * Pure structural graph model for the Moe scheduler kernel.
 *
 * Contract-neutral by design: this module and its siblings expose exact
 * *structural* facts about a proposed work graph. They deliberately do NOT
 * implement command semantics, persistence, approval policy, provider
 * dispatch, leases, budgets, semantic dependency truth, or automatic graph
 * mutation. Those are deferred until the technical design is frozen
 * (see docs/plans/2026-08-05-moe-rebuild-design.md §§8.3-8.4). The kernel
 * reports what is structurally true and refuses to invent independence,
 * delete edges, or claim a decomposition is faster.
 *
 * Edge direction convention: an edge points `producerNodeKey -> consumerNodeKey`.
 * The producer is upstream; the consumer depends on the producer. A HARD edge
 * is an incoming HARD dependency of its consumer. The `completionNodeKey` is
 * the terminal sink of the required HARD closure.
 */

export type GraphEdgeKind = "HARD" | "ADVISORY";

export interface GraphNode {
  readonly nodeKey: string;
  readonly executionBearing: boolean;
}

export interface GraphEdge {
  readonly edgeKey: string;
  readonly producerNodeKey: string;
  readonly consumerNodeKey: string;
  readonly kind: GraphEdgeKind;
}

export interface GraphSnapshot {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly completionNodeKey: string;
}

/** Stable, machine-checkable reason codes. Never reworded silently. */
export type GraphIssueCode =
  | "GRAPH_MALFORMED_SNAPSHOT"
  | "GRAPH_MALFORMED_NODE"
  | "GRAPH_MALFORMED_EDGE"
  | "GRAPH_DUPLICATE_NODE"
  | "GRAPH_DUPLICATE_EDGE"
  | "GRAPH_MISSING_ENDPOINT"
  | "GRAPH_SELF_EDGE"
  | "GRAPH_CYCLE"
  | "GRAPH_COMPLETION_NODE_MISSING"
  | "COMPLETION_CLOSURE_INCOMPLETE"
  | "GRAPH_NODE_LIMIT_EXCEEDED"
  | "GRAPH_HARD_EDGE_LIMIT_EXCEEDED"
  | "FRONTIER_MALFORMED_CURSOR"
  | "FRONTIER_EDGE_FACT_MISSING"
  | "FRONTIER_EDGE_FACT_DUPLICATE"
  | "FRONTIER_EDGE_FACT_UNKNOWN_EDGE"
  | "FRONTIER_NODE_FACT_MISSING"
  | "FRONTIER_NODE_FACT_DUPLICATE"
  | "FRONTIER_NODE_FACT_UNKNOWN_NODE";

/**
 * A single validation/frontier failure. `nodeKeys`/`edgeKeys` carry the exact
 * offending identifiers and are always present (empty when not applicable), so
 * consumers never have to distinguish "absent" from "none".
 */
export interface GraphIssue {
  readonly code: GraphIssueCode;
  readonly message: string;
  readonly nodeKeys: readonly string[];
  readonly edgeKeys: readonly string[];
}

/**
 * A snapshot that has passed {@link validateGraphSnapshot}. Nodes are sorted by
 * `nodeKey`, edges by `edgeKey`; both are deeply frozen. Carrying the applied
 * policy makes limit provenance explicit rather than implicit.
 */
export interface ValidatedGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly completionNodeKey: string;
  readonly policy: GraphPolicy;
}

/**
 * Explicit, documented structural limits. Defaults come from the provisional
 * design (§8.3): 24 nodes, 64 hard edges. `minGatedDescendantsForReview` is the
 * threshold at which a critical-path HARD edge earns an
 * `INTERFACE_FIRST_REVIEW_REQUIRED` (review-only) diagnostic. These are policy
 * inputs, never scattered magic numbers.
 */
export interface GraphPolicy {
  readonly maxNodes: number;
  readonly maxHardEdges: number;
  readonly minGatedDescendantsForReview: number;
}

export interface GraphValidationOk {
  readonly ok: true;
  readonly graph: ValidatedGraph;
}

export interface GraphValidationError {
  readonly ok: false;
  readonly issues: readonly GraphIssue[];
}

export type GraphValidationResult = GraphValidationOk | GraphValidationError;

// --- Structural analysis -----------------------------------------------------

export interface NodeStructuralFacts {
  readonly nodeKey: string;
  /** Transitive HARD-edge predecessors (upstream), sorted by nodeKey. */
  readonly hardAncestorKeys: readonly string[];
  /** Transitive HARD-edge successors (downstream), sorted by nodeKey. */
  readonly hardDescendantKeys: readonly string[];
  /** Count of HARD descendants this node structurally gates. */
  readonly blockedDescendantCount: number;
}

export interface CriticalPathEdge {
  readonly edgeKey: string;
  readonly producerNodeKey: string;
  readonly consumerNodeKey: string;
  /** How many HARD descendants of the consumer this edge currently gates. */
  readonly gatedDescendantCount: number;
}

/**
 * A direct HARD edge for which another HARD path connects the same endpoints.
 * This is ONLY a candidate. The kernel never deletes the edge, never rejects it
 * as semantically redundant, and never claims the alternate path carries the
 * same artifact/predicate — that requires semantic proof the kernel does not
 * possess. `requiresSemanticProof` is always `true` to make this explicit.
 */
export interface RedundancyCandidate {
  readonly edgeKey: string;
  readonly producerNodeKey: string;
  readonly consumerNodeKey: string;
  /** One deterministic witnessing alternate HARD path (producer..consumer). */
  readonly alternateHardPathNodeKeys: readonly string[];
  /**
   * The HARD edge keys traversed by the witnessing alternate path, so a
   * parallel-edge alternate (same endpoints, different edge) is machine-
   * distinguishable from the flagged edge — the node-key path alone would be
   * ambiguous for parallel edges.
   */
  readonly alternateHardPathEdgeKeys: readonly string[];
  readonly requiresSemanticProof: true;
}

/**
 * Review-only anti-serialization advisory. It flags a serial bottleneck for a
 * human/interface-first review. It never invents a stub, removes an edge, or
 * claims an interface-first slice is safe.
 */
export interface StructuralDiagnostic {
  readonly code: "INTERFACE_FIRST_REVIEW_REQUIRED";
  readonly edgeKey: string;
  readonly gatedDescendantCount: number;
  readonly reviewOnly: true;
}

export interface GraphStructuralAnalysis {
  /** Deterministic topological order; ties broken by ascending `nodeKey`. */
  readonly topologicalOrder: readonly string[];
  readonly hardEdgeCount: number;
  /** Max execution-bearing-node count along any HARD-edge path. */
  readonly structuralStageCount: number;
  /**
   * The node sequence of a deterministic maximum-execution-bearing-count HARD
   * path (ties broken toward the smaller node key). Note: because a trailing
   * non-execution-bearing node adds no execution weight, this path may END at
   * the last execution-bearing node rather than at the completion node. It is
   * the structural stage-count witness, not necessarily a source-to-completion
   * path.
   */
  readonly structuralCriticalPathNodeKeys: readonly string[];
  readonly criticalPathHardEdges: readonly CriticalPathEdge[];
  readonly nodes: readonly NodeStructuralFacts[];
  readonly rootNodeKeys: readonly string[];
  readonly leafNodeKeys: readonly string[];
  /**
   * Exact current ready width, supplied by frontier facts. `null` (UNKNOWN)
   * when no frontier partition is supplied — never fabricated as 0.
   */
  readonly readyWidth: number | null;
  readonly structuralRedundancyCandidates: readonly RedundancyCandidate[];
  readonly diagnostics: readonly StructuralDiagnostic[];
  /**
   * Duration/cost is out of scope for this structural kernel. It is always
   * absent (`null` = UNKNOWN), never zero, and never a speed claim.
   */
  readonly durationEstimate: null;
}

// --- Frontier ----------------------------------------------------------------

export type HardEdgeSatisfaction = "SATISFIED" | "UNSATISFIED" | "UNKNOWN";

export interface HardEdgeFact {
  readonly edgeKey: string;
  readonly state: HardEdgeSatisfaction;
}

export interface NodeAvailabilityFact {
  readonly nodeKey: string;
  /** Admission eligibility, supplied by the caller (never derived here). */
  readonly admissionEligible: boolean;
  /** Dispatch/resource availability, supplied by the caller. */
  readonly dispatchAvailable: boolean;
}

/**
 * Caller-supplied frontier facts. For every HARD edge exactly one satisfaction
 * fact; for every node exactly one availability fact. ADVISORY edges carry no
 * satisfaction fact and never block readiness.
 */
export interface FrontierCursor {
  readonly hardEdgeFacts: readonly HardEdgeFact[];
  readonly nodeAvailabilityFacts: readonly NodeAvailabilityFact[];
}

export type BlockedReasonCode =
  | "HARD_DEPENDENCY_UNSATISFIED"
  | "HARD_DEPENDENCY_UNKNOWN";

export interface BlockedReason {
  readonly code: BlockedReasonCode;
  readonly edgeKey: string;
  readonly producerNodeKey: string;
}

export interface BlockedNode {
  readonly nodeKey: string;
  readonly reasons: readonly BlockedReason[];
}

/**
 * Three distinct readiness concepts plus the hard-dependency-blocked set. These
 * are never collapsed into a single "ready" boolean:
 *  - logicalReady: every incoming HARD dependency SATISFIED (UNKNOWN never counts).
 *  - admissionReady: logicalReady AND caller admission-eligible (subset).
 *  - dispatchable: admissionReady AND caller dispatch-available (subset).
 *  - blocked: NOT logicalReady, with exact offending HARD edges/producers.
 */
export interface FrontierPartition {
  readonly logicalReady: readonly string[];
  readonly admissionReady: readonly string[];
  readonly dispatchable: readonly string[];
  readonly blocked: readonly BlockedNode[];
}

export interface FrontierOk {
  readonly ok: true;
  readonly partition: FrontierPartition;
}

export interface FrontierError {
  readonly ok: false;
  readonly issues: readonly GraphIssue[];
}

export type FrontierResult = FrontierOk | FrontierError;

// --- Instrumentation ---------------------------------------------------------

/**
 * Optional development-only traversal counter. Kernel operations are
 * single-pass over nodes and edges; passing a counter lets tests prove that
 * ordinary validation/topology/frontier work does not repeatedly rescan full
 * descendant histories (no O(V*E) per-node re-traversal).
 */
export interface TraversalCounter {
  nodeVisits: number;
  edgeVisits: number;
}

export function createTraversalCounter(): TraversalCounter {
  return { nodeVisits: 0, edgeVisits: 0 };
}
