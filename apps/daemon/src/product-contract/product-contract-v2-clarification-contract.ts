import type {
  ProductContractClarificationV2MaterialityResult,
  ProductContractClarificationV2SharedIdentity,
} from "@moe/core";

export {
  PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX,
  compareProductContractV2CodeUnits,
  deriveProductContractClarificationV2Id,
  encodeProductContractClarificationV2Value,
  productContractClarificationV2AggregateId,
  productContractClarificationV2AnswerCommandId,
  productContractClarificationV2AnswerRequestBytes,
  productContractClarificationV2AskCommandId,
  productContractClarificationV2AskRequestBytes,
  productContractClarificationV2CanonicalText,
} from "./product-contract-v2-clarification-canonical.js";

export const PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION =
  "moe-product-contract-clarification/2" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER =
  "PRODUCT_CONTRACT_V2_CLARIFICATION" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE =
  "ProductContractClarificationV2Asked" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE =
  "ProductContractClarificationV2Answered" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND =
  "product_contract.ask_clarification" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND =
  "product_contract.answer_clarification" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS = Object.freeze([
  "contractId", "goalRef", "options", "question",
] as const);
export const PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS = Object.freeze([
  "answerOptionId", "clarificationId", "contractId",
] as const);
export const PRODUCT_CONTRACT_CLARIFICATION_V2_CORRUPT_OPEN_ID =
  "product-contract-v2-clarification-state-invalid" as const;
export const PRODUCT_CONTRACT_CLARIFICATION_V2_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHOR_MISMATCH",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_TARGET_MISMATCH",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_UNKNOWN",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_ANSWER_UNKNOWN_OPTION",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_UNREADABLE",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_STORE_REFUSED",
] as const);

export type ProductContractClarificationV2Code =
  (typeof PRODUCT_CONTRACT_CLARIFICATION_V2_CODES)[number];

export interface ProductContractClarificationV2CommandInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
  readonly targetAggregateId: string;
}

export interface ProductContractClarificationV2DecisionProvenance {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
}

export interface ProductContractClarificationV2AnswerProvenance {
  readonly answeredAt: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly optionId: string;
  readonly principalId: string;
  readonly projectionDigest: string;
  readonly revisionDigest: string;
}

export interface ProductContractClarificationV2Row {
  readonly answerDecision: ProductContractClarificationV2AnswerProvenance | null;
  readonly askDecision: ProductContractClarificationV2DecisionProvenance;
  readonly clarificationId: string;
  readonly contractId: string;
  readonly goalRef: string;
  readonly optionDigests: readonly {
    readonly label: string;
    readonly optionId: string;
    readonly projectionDigest: string;
    readonly revisionDigest: string;
  }[];
  readonly question: string;
  readonly schemaVersion: typeof PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION;
  readonly sharedIdentity: ProductContractClarificationV2SharedIdentity;
}

export interface ProductContractClarificationV2Accepted {
  readonly clarificationId: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
}
export interface ProductContractClarificationV2Refused {
  readonly code: ProductContractClarificationV2Code | string;
  readonly layer: typeof PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER | "DURABLE_STORE" | string;
  readonly ok: false;
}
export type ProductContractClarificationV2Result =
  | ProductContractClarificationV2Accepted
  | ProductContractClarificationV2Refused
  | Exclude<ProductContractClarificationV2MaterialityResult, { readonly ok: true }>;
