import type {
  GraphIssue,
  GraphStructuralAnalysis,
} from "./graph-model.js";

/** Fields that make the preview's lack of mutation authority explicit. */
export interface GraphPreviewAdvisoryEnvelope {
  readonly authority: "NONE";
  readonly advisoryOnly: true;
}

/** Exact optional inputs for the pure preview composition. */
export interface GraphPreviewOptions {
  readonly policyOverride?: unknown;
  readonly frontierCursor?: unknown;
}

export interface GraphPreviewOptionsInvalid
  extends GraphPreviewAdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "OPTIONS_INVALID";
  readonly issues: readonly GraphIssue[];
}

export interface GraphPreviewPolicyInvalid
  extends GraphPreviewAdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "POLICY_INVALID";
  readonly issues: readonly GraphIssue[];
}

export interface GraphPreviewGraphInvalid
  extends GraphPreviewAdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "GRAPH_INVALID";
  readonly issues: readonly GraphIssue[];
}

export interface GraphPreviewFrontierInvalid
  extends GraphPreviewAdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "FRONTIER_INVALID";
  /** Structural binding only; this is not an authoritative content hash. */
  readonly graphIdentity: string;
  readonly issues: readonly GraphIssue[];
}

export interface GraphPreviewAnalyzed extends GraphPreviewAdvisoryEnvelope {
  readonly ok: true;
  readonly outcome: "ANALYZED";
  /** Structural binding only; this is not an authoritative content hash. */
  readonly graphIdentity: string;
  /**
   * Non-cryptographic binding of graph structure, resolved policy, and the
   * normalized frontier facts that determine this result. It grants no
   * authority and is only a stale-result/cache guard.
   */
  readonly previewIdentity: string;
  /** Numeric readiness widths are conditional on these unverified assertions. */
  readonly frontierFacts: "ABSENT" | "CALLER_SUPPLIED_UNVERIFIED";
  readonly analysis: GraphStructuralAnalysis;
}

/** Closed, fail-closed result of the zero-authority preview composition. */
export type GraphPreviewResult =
  | GraphPreviewOptionsInvalid
  | GraphPreviewPolicyInvalid
  | GraphPreviewGraphInvalid
  | GraphPreviewFrontierInvalid
  | GraphPreviewAnalyzed;
