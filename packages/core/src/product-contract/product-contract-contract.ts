import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

export const PRODUCT_CONTRACT_VERSION = "moe-product-contract-revision/1" as const;
export const PRODUCT_CONTRACT_CODES = Object.freeze([
  "PRODUCT_CONTRACT_PROVENANCE_INVALID", "PRODUCT_CONTRACT_PROVENANCE_VACUOUS",
  "PRODUCT_CONTRACT_VERSION_UNSUPPORTED", "PRODUCT_CONTRACT_LIMIT_EXCEEDED",
  "PRODUCT_CONTRACT_BYTES_INVALID", "PRODUCT_CONTRACT_DUPLICATE_KEY",
  "PRODUCT_CONTRACT_NONCANONICAL", "PRODUCT_CONTRACT_DIGEST_MISMATCH",
  "PRODUCT_CONTRACT_LINEAGE_PARENT_NOT_CURRENT", "PRODUCT_CONTRACT_LINEAGE_CONTRACT_MISMATCH",
  "PRODUCT_CONTRACT_LINEAGE_ID_REUSED", "PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE",
  "PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED", "PRODUCT_CONTRACT_CLARIFICATION_INVALID",
  "PRODUCT_CONTRACT_CLARIFICATION_VACUOUS", "PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL",
  "PRODUCT_CONTRACT_GATE_1_REQUIRED", "PRODUCT_CONTRACT_GATE_1_BINDING_INVALID",
  "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH",
  "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH",
  "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS",
] as const);
export const PRODUCT_CONTRACT_LAYERS = Object.freeze([
  "PROVENANCE", "LINEAGE", "MATERIALITY", "GATE_1", "ACCEPTANCE_BINDING",
] as const);
export const PRODUCT_CONTRACT_LIMITS = Object.freeze({
  maxBytes: MAX_JSON_BODY_BYTES,
  maxCriteria: 512,
  maxIdBytes: 512,
  maxRequirements: 512,
  maxSourceDocuments: 64,
  maxStatementBytes: 32_768,
});

export type ProductContractCode = (typeof PRODUCT_CONTRACT_CODES)[number];
export type ProductContractLayer = (typeof PRODUCT_CONTRACT_LAYERS)[number];

export interface ProductContractLineage {
  readonly parentRevisionDigest: string;
  readonly parentRevisionId: string;
}

export interface ProductContractRequirement {
  readonly requirementId: string;
  readonly statement: string;
  readonly supersedesRequirementId: string | null;
}

export interface ProductContractCriterion {
  readonly criterionId: string;
  readonly requirementId: string;
  readonly statement: string;
  readonly supersedesCriterionId: string | null;
}

export interface ProductContractRevisionDraft {
  readonly authorRef: string;
  readonly contractId: string;
  readonly criteria: readonly ProductContractCriterion[];
  readonly lineage: ProductContractLineage | null;
  readonly requirements: readonly ProductContractRequirement[];
  readonly retiredCriterionIds: readonly string[];
  readonly retiredRequirementIds: readonly string[];
  readonly revisionId: string;
  readonly sourceDocumentDigests: readonly string[];
}

/** Advisory product truth. It contains no dispatch, effect, activation, or command capability. */
export interface ProductContractRevision extends ProductContractRevisionDraft {
  readonly advisoryOnly: true;
  readonly revisionDigest: string;
  readonly version: typeof PRODUCT_CONTRACT_VERSION;
}

export const PRODUCT_CONTRACT_REVISION_REF_KEYS = Object.freeze([
  "contractId", "revisionDigest", "revisionId",
] as const);

/**
 * The identity a Gate 1 grant binds to: shape and bounds only. Whether a
 * revision with this identity exists, and whether its content matches this
 * digest, are the reader's question and never this type's.
 */
export interface ProductContractRevisionRef {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export interface ProductContractRefusal {
  readonly code: ProductContractCode;
  readonly layer: ProductContractLayer;
  readonly ok: false;
}

export type ProductContractDraftAdmission =
  | Readonly<{ draft: ProductContractRevisionDraft; ok: true }>
  | ProductContractRefusal;
export type ProductContractAdmission =
  | Readonly<{ ok: true; revision: ProductContractRevision }>
  | ProductContractRefusal;
export type ProductContractRevisionRefAdmission =
  | Readonly<{ ok: true; ref: ProductContractRevisionRef }>
  | ProductContractRefusal;

export function productContractRefusal(
  code: ProductContractCode,
  layer: ProductContractLayer,
): ProductContractRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
