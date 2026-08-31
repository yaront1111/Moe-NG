import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

export const PRODUCT_CONTRACT_V2_VERSION = "moe-product-contract-revision/2" as const;
export const PRODUCT_CONTRACT_V2_DIGEST_DOMAIN =
  "moe-product-contract-revision-digest/2" as const;

export const PRODUCT_CONTRACT_V2_PRIORITIES = Object.freeze([
  "MUST", "SHOULD", "COULD",
] as const);
export const PRODUCT_CONTRACT_V2_BUDGET_KINDS = Object.freeze([
  "MONEY", "TIME", "TOKEN", "COMPUTE",
] as const);
export const PRODUCT_CONTRACT_V2_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
  "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS",
  "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
  "PRODUCT_CONTRACT_V2_VERSION_UNSUPPORTED",
  "PRODUCT_CONTRACT_V2_BYTES_INVALID",
  "PRODUCT_CONTRACT_V2_DUPLICATE_KEY",
  "PRODUCT_CONTRACT_V2_NONCANONICAL",
  "PRODUCT_CONTRACT_V2_DIGEST_MISMATCH",
  "PRODUCT_CONTRACT_V2_REFERENCE_INVALID",
  "PRODUCT_CONTRACT_V2_REQUIREMENT_CYCLE",
  "PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE",
  "PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED",
  "PRODUCT_CONTRACT_V2_SLOT_INVALID",
  "PRODUCT_CONTRACT_V2_SLOT_VERSION_UNSUPPORTED",
  "PRODUCT_CONTRACT_V2_SLOT_BYTES_INVALID",
  "PRODUCT_CONTRACT_V2_SLOT_DUPLICATE_KEY",
  "PRODUCT_CONTRACT_V2_SLOT_NONCANONICAL",
  "PRODUCT_CONTRACT_V2_SLOT_DIGEST_MISMATCH",
  "PRODUCT_CONTRACT_V2_SLOT_PARENT_NOT_CURRENT",
  "PRODUCT_CONTRACT_V2_SLOT_CONTRACT_MISMATCH",
  "PRODUCT_CONTRACT_V2_SLOT_CURRENT_REVISION_MISMATCH",
  "PRODUCT_CONTRACT_V2_SLOT_REVISION_REUSED",
  "PRODUCT_CONTRACT_V2_SLOT_GENERATION_OVERFLOW",
  "PRODUCT_CONTRACT_V2_LINEAGE_PARENT_NOT_CURRENT",
  "PRODUCT_CONTRACT_V2_LINEAGE_CONTRACT_MISMATCH",
  "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
  "PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE",
  "PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED",
] as const);
export const PRODUCT_CONTRACT_V2_LAYERS = Object.freeze([
  "PRODUCT_CONTRACT_V2_PROVENANCE",
  "PRODUCT_CONTRACT_V2_SEMANTICS",
  "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
  "PRODUCT_CONTRACT_V2_LINEAGE",
] as const);
export const PRODUCT_CONTRACT_V2_LIMITS = Object.freeze({
  maxBudgets: 64,
  maxBytes: MAX_JSON_BODY_BYTES,
  maxCriteria: 1_024,
  maxDecisions: 256,
  maxIdBytes: 512,
  maxItemsPerSection: 512,
  maxOptionsPerDecision: 64,
  maxRetiredIds: 8_192,
  maxRevisionHistory: 1_024,
  maxSnapshotDepth: 8,
  maxSnapshotNodes: 100_000,
  maxStatementBytes: 32_768,
  maxSourceDocuments: 64,
});

export type ProductContractV2Priority = (typeof PRODUCT_CONTRACT_V2_PRIORITIES)[number];
export type ProductContractV2BudgetKind = (typeof PRODUCT_CONTRACT_V2_BUDGET_KINDS)[number];
export type ProductContractV2Code = (typeof PRODUCT_CONTRACT_V2_CODES)[number];
export type ProductContractV2Layer = (typeof PRODUCT_CONTRACT_V2_LAYERS)[number];

export interface ProductContractV2Lineage {
  readonly parentRevisionDigest: string;
  readonly parentRevisionId: string;
}

export interface ProductContractV2Statement {
  readonly statement: string;
}

export interface ProductContractV2Objective extends ProductContractV2Statement {
  readonly objectiveId: string;
}

export interface ProductContractV2UserJob {
  readonly job: string;
  readonly user: string;
  readonly userJobId: string;
}

export interface ProductContractV2Journey extends ProductContractV2Statement {
  readonly criterionIds: readonly string[];
  readonly journeyId: string;
  readonly userJobId: string;
}

export interface ProductContractV2Requirement extends ProductContractV2Statement {
  readonly dependsOnRequirementIds: readonly string[];
  readonly priority: ProductContractV2Priority;
  readonly requirementId: string;
  readonly supersedesRequirementId: string | null;
}

export interface ProductContractV2Criterion extends ProductContractV2Statement {
  readonly criterionId: string;
  readonly requirementId: string;
  readonly supersedesCriterionId: string | null;
  /** A falsifiable statement; concrete argv is bound later by a verification recipe revision. */
  readonly verification: string;
}

export interface ProductContractV2NegativeScope extends ProductContractV2Statement {
  readonly scopeId: string;
}

export interface ProductContractV2Assumption extends ProductContractV2Statement {
  readonly assumptionId: string;
  readonly validationCriterionId: string;
}

export interface ProductContractV2Budget {
  readonly budgetId: string;
  readonly kind: ProductContractV2BudgetKind;
  readonly limit: number;
  readonly unit: string;
}

export interface ProductContractV2SuccessMetric extends ProductContractV2Statement {
  readonly measurement: string;
  readonly metricId: string;
  readonly objectiveIds: readonly string[];
  readonly target: string;
}

export interface ProductContractV2DecisionOption extends ProductContractV2Statement {
  readonly optionId: string;
}

export interface ProductContractV2MaterialDecision {
  readonly decisionId: string;
  readonly options: readonly ProductContractV2DecisionOption[];
  readonly question: string;
  readonly selectedOptionId: string | null;
}

export interface ProductContractV2ProductCompleteDefinition extends ProductContractV2Statement {
  readonly criterionIds: readonly string[];
}

export interface ProductContractRevisionV2Draft {
  readonly assumptions: readonly ProductContractV2Assumption[];
  readonly authorRef: string;
  readonly budgets: readonly ProductContractV2Budget[];
  readonly contractId: string;
  readonly criteria: readonly ProductContractV2Criterion[];
  readonly deploymentRequirements: readonly ProductContractV2Requirement[];
  readonly functionalRequirements: readonly ProductContractV2Requirement[];
  readonly journeys: readonly ProductContractV2Journey[];
  readonly lineage: ProductContractV2Lineage | null;
  readonly materialDecisions: readonly ProductContractV2MaterialDecision[];
  readonly negativeScope: readonly ProductContractV2NegativeScope[];
  readonly nonFunctionalRequirements: readonly ProductContractV2Requirement[];
  readonly objectives: readonly ProductContractV2Objective[];
  readonly productCompleteDefinition: ProductContractV2ProductCompleteDefinition;
  readonly retiredCriterionIds: readonly string[];
  readonly retiredRequirementIds: readonly string[];
  readonly revisionId: string;
  readonly securityPrivacyRequirements: readonly ProductContractV2Requirement[];
  readonly sourceDocumentDigests: readonly string[];
  readonly successMetrics: readonly ProductContractV2SuccessMetric[];
  readonly technologyRequirements: readonly ProductContractV2Requirement[];
  readonly userJobs: readonly ProductContractV2UserJob[];
  readonly uxAccessibilityRequirements: readonly ProductContractV2Requirement[];
}

/** Advisory product truth. It cannot dispatch, activate, publish, or deploy. */
export interface ProductContractRevisionV2 extends ProductContractRevisionV2Draft {
  readonly advisoryOnly: true;
  readonly revisionDigest: string;
  readonly version: typeof PRODUCT_CONTRACT_V2_VERSION;
}

export interface ProductContractV2Refusal {
  readonly code: ProductContractV2Code;
  readonly layer: ProductContractV2Layer;
  readonly ok: false;
}

export type ProductContractV2DraftAdmission =
  | Readonly<{ draft: ProductContractRevisionV2Draft; ok: true }>
  | ProductContractV2Refusal;
export type ProductContractV2Admission =
  | Readonly<{ ok: true; revision: ProductContractRevisionV2 }>
  | ProductContractV2Refusal;

export function productContractV2Refusal(
  code: ProductContractV2Code,
  layer: ProductContractV2Layer,
): ProductContractV2Refusal {
  return Object.freeze({ code, layer, ok: false as const });
}
