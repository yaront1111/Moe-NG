import type { GraphKey } from "./graph-model.js";

/** Exact topology after removing one validated source-graph HARD edge in memory. */
export interface HardEdgeCounterfactual {
  readonly edgeKey: GraphKey;
  readonly producerNodeKey: GraphKey;
  readonly consumerNodeKey: GraphKey;
  /** Source-graph stage count after removing only this edge. */
  readonly structuralStageCountWithoutEdge: number;
  /** Validated source-graph stage count minus the counterfactual count. */
  readonly structuralStageReduction: number;
  /** Structural HARD roots only; never logical/admission/dispatch readiness. */
  readonly executionBearingHardRootCountWithoutEdge: number;
  /** Execution-bearing nodes that become HARD roots only in this counterfactual. */
  readonly newlyHardRootedExecutionNodeKeys: readonly GraphKey[];
  /** Whether producer still reaches consumer through another HARD path. */
  readonly alternateHardPathPresent: boolean;
  /** Whether every executable still reaches the completion node through HARD edges. */
  readonly completionClosureIntactWithoutEdge: boolean;
  /** Structural evidence cannot establish real dependency necessity. */
  readonly dependencyNecessity: "UNKNOWN";
  readonly requiresSemanticProof: true;
  readonly reviewOnly: true;
}

/**
 * Review-only counterfactuals over the validated source graph. These are not semantic
 * reduction, admission, mutation, or speed evidence.
 */
export interface HardEdgeCounterfactualAnalysis {
  readonly graphIdentity: string;
  readonly sourceGraphStructuralStageCount: number;
  /** Structural HARD roots only; never logical/admission/dispatch readiness. */
  readonly sourceGraphExecutionBearingHardRootCount: number;
  readonly edges: readonly HardEdgeCounterfactual[];
  readonly durationEstimate: null;
}
