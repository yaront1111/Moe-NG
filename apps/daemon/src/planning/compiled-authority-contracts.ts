/**
 * The compile input the PRD compiler's dispatcher hands the N-node producer: the
 * plan STRUCTURE an agent submitted (nodes, criterion bindings, advisory order)
 * joined with the criteria of the operator-approved Product Contract revision.
 * The agent's structure is ADVISORY — every authority byte is derived by the
 * producer through the same @moe/core / @moe/scheduler codecs the propose seam
 * re-derives with, so nothing an agent writes here becomes authority without
 * surviving production admission.
 *
 * v0 scope, stated rather than implied: inter-node `dependsOn` compiles to
 * NON-BLOCKING `PREFERRED_ORDER` edges (which may not carry dependency
 * contracts, per the scheduler's own DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN);
 * hard ARTIFACT_CONSUMPTION/STATE_PRECONDITION edges with their 17-key
 * contracts are a later row. Criterion statements travel BYTE-EQUAL from the
 * approved revision — `validateProductAcceptanceBinding` compares statements
 * byte-for-byte at finalize, so the producer never prettifies.
 */

export const COMPILED_PLAN_CODES = Object.freeze([
  "COMPILED_PLAN_MALFORMED",
  "COMPILED_PLAN_BUDGET_EXCEEDED",
  "COMPILED_PLAN_CAPABILITY_UNCATALOGED",
  "COMPILED_PLAN_CRITERION_UNBOUND",
  "COMPILED_PLAN_ADMISSION_REFUSED",
] as const);
export type CompiledPlanCode = (typeof COMPILED_PLAN_CODES)[number];

/** The producer's convention, not a scheduler fence (the codec bound is
 *  ABSOLUTE_MAX_GRAPH_NODES = 64): "plan the smallest complete slice". */
export const COMPILED_PLAN_NODE_BUDGET = 24;

export interface CompiledCriterion {
  readonly criterionId: string;
  /** Byte-equal from the approved contract revision; never normalised here. */
  readonly statement: string;
}

export interface CompiledNodeInput {
  readonly capability: string;
  /** Criteria this node's delivery satisfies; every listed id must exist. */
  readonly criterionIds: readonly string[];
  /** Advisory build order: producers this node prefers to follow. */
  readonly dependsOn: readonly string[];
  readonly nodeKey: string;
  readonly objective: string;
  readonly readScopes: readonly string[];
  readonly resources: readonly string[];
  readonly verificationRecipeRefs: readonly string[];
  readonly writeScopes: readonly string[];
}

export interface CompiledPlanInput {
  readonly authorRef: string;
  /** The node whose delivery completes the goal; must name a listed node. */
  readonly completionNodeKey: string;
  readonly criteria: readonly CompiledCriterion[];
  readonly graphRevisionRef: string;
  /** Namespaces contract/revision ids so two compiles never collide on one store. */
  readonly idPrefix: string;
  /**
   * The falsifiability floor: capabilities the host's verification catalog can
   * verify. `null` DISABLES the floor (a composition without a catalog states
   * so explicitly); a roster refuses any node whose capability is absent, which
   * moves the produceNodeBrief NODE_MISSION_TEST_UNAVAILABLE stall from
   * staffing time to compile time with the capability named.
   */
  readonly knownCapabilities: readonly string[] | null;
  readonly nodes: readonly CompiledNodeInput[];
}

export interface CompiledPlanAuthority {
  readonly authority: Record<string, unknown>;
  readonly graphContentBytesBase64: string;
  readonly graphContentHash: string;
  readonly ok: true;
  readonly submissionHash: string;
}
export interface CompiledPlanRefused {
  readonly code: CompiledPlanCode;
  /** The refusing producer's own issues, forwarded verbatim when one refused. */
  readonly detail: string;
  readonly layer: string;
  readonly ok: false;
}
export type CompiledPlanResult = CompiledPlanAuthority | CompiledPlanRefused;
