import { createHash } from "node:crypto";

import type {
  ProductContractClarificationV2Row,
} from
  "./product-contract-v2-clarification-contract.js";
import type { ProductContractClarificationV2SharedIdentity } from "@moe/core";

export const PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX =
  "product-contract-clarification-v2:" as const;

const ADDRESS_DOMAIN = "moe/product-contract/clarification/2";
const ASK_COMMAND_DOMAIN = "moe/product-contract/clarification/2/ask-command";
const ANSWER_COMMAND_DOMAIN = "moe/product-contract/clarification/2/answer-command";
const encoder = new TextEncoder();

export function compareProductContractV2CodeUnits(left: string, right: string): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function productContractClarificationV2CanonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(productContractClarificationV2CanonicalText).join(",")}]`;
  }
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(source).sort(compareProductContractV2CodeUnits).map(
      (key) => `${JSON.stringify(key)}:${productContractClarificationV2CanonicalText(source[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("Product Contract /2 clarification canonicalization received invalid data");
}

export function encodeProductContractClarificationV2Value(value: unknown): Uint8Array {
  return encoder.encode(productContractClarificationV2CanonicalText(value));
}

function hashParts(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update(Uint8Array.of(0)).update(part, "utf8");
  return hash.digest("hex");
}

export function deriveProductContractClarificationV2Id(
  goalRef: string,
  sharedIdentity: ProductContractClarificationV2SharedIdentity,
  question: string,
  optionDigests: ProductContractClarificationV2Row["optionDigests"],
): string {
  return `clar-v2-${hashParts(ADDRESS_DOMAIN, [goalRef,
    productContractClarificationV2CanonicalText(sharedIdentity), question,
    productContractClarificationV2CanonicalText(optionDigests)])}`;
}

export function productContractClarificationV2AggregateId(
  projectId: string, contractId: string, clarificationId: string,
): string {
  return `${PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX}${hashParts(
    ADDRESS_DOMAIN, [projectId, contractId, clarificationId],
  )}`;
}

export function productContractClarificationV2AskCommandId(
  projectId: string, contractId: string, clarificationId: string,
): string {
  return `product-contract-clarification-v2-ask-${hashParts(
    ASK_COMMAND_DOMAIN, [projectId, contractId, clarificationId],
  )}`;
}

export function productContractClarificationV2AnswerCommandId(
  projectId: string, contractId: string, clarificationId: string,
): string {
  return `product-contract-clarification-v2-answer-${hashParts(
    ANSWER_COMMAND_DOMAIN, [projectId, contractId, clarificationId],
  )}`;
}

export function productContractClarificationV2AskRequestBytes(
  row: ProductContractClarificationV2Row,
): Uint8Array {
  return encodeProductContractClarificationV2Value({
    contractId: row.contractId, goalRef: row.goalRef, optionDigests: row.optionDigests,
    question: row.question, sharedIdentity: row.sharedIdentity,
  });
}

export function productContractClarificationV2AnswerRequestBytes(
  row: ProductContractClarificationV2Row,
): Uint8Array {
  if (row.answerDecision === null) throw new TypeError("answer request requires an answer");
  return encodeProductContractClarificationV2Value({
    answerOptionId: row.answerDecision.optionId,
    clarificationId: row.clarificationId,
    contractId: row.contractId,
  });
}
