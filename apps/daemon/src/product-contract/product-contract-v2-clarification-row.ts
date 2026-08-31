import {
  PRODUCT_CONTRACT_V2_LIMITS,
  type ProductContractClarificationV2SharedIdentity,
} from "@moe/core";

import { exactDataArray, exactDataRecord, sha256String }
  from "../documents/document-work-safe-value.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  type ProductContractClarificationV2AnswerProvenance,
  type ProductContractClarificationV2DecisionProvenance,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import {
  compareProductContractV2CodeUnits,
  deriveProductContractClarificationV2Id,
} from "./product-contract-v2-clarification-canonical.js";

const ROW_KEYS = Object.freeze([
  "answerDecision", "askDecision", "clarificationId", "contractId", "goalRef",
  "optionDigests", "question", "schemaVersion", "sharedIdentity",
]);
const ASK_KEYS = Object.freeze(["commandId", "correlationId", "decidedAt", "principalId"]);
const ANSWER_KEYS = Object.freeze([
  "answeredAt", "commandId", "correlationId", "optionId", "principalId", "projectionDigest",
  "revisionDigest",
]);
const OPTION_KEYS = Object.freeze([
  "label", "optionId", "projectionDigest", "revisionDigest",
]);
const IDENTITY_KEYS = Object.freeze([
  "authorRef", "contractId", "lineage", "retiredCriterionIds", "retiredRequirementIds",
  "revisionId", "sourceDocumentDigests",
]);
const LINEAGE_KEYS = Object.freeze(["parentRevisionDigest", "parentRevisionId"]);
const encoder = new TextEncoder();

export function validProductContractClarificationV2Text(
  value: unknown, maximum = 2_000,
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && value.isWellFormed() && value.normalize("NFC") === value
    && !value.includes("\0") && encoder.encode(value).byteLength <= maximum;
}

function readSortedStrings(value: unknown, maximum: number, digests = false): readonly string[] | null {
  const values = exactDataArray(value);
  if (values === null || values.length > maximum) return null;
  const admitted: string[] = [];
  for (const candidate of values) {
    if ((digests ? !sha256String(candidate) : !validProductContractClarificationV2Text(
      candidate, PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
    )) || (admitted.length > 0 && compareProductContractV2CodeUnits(
      admitted.at(-1)!, candidate as string,
    ) >= 0)) return null;
    admitted.push(candidate as string);
  }
  return Object.freeze(admitted);
}

function readIdentity(value: unknown): ProductContractClarificationV2SharedIdentity | null {
  const record = exactDataRecord(value, IDENTITY_KEYS);
  const lineage = record?.["lineage"] === null ? null
    : exactDataRecord(record?.["lineage"], LINEAGE_KEYS);
  const retiredCriteria = readSortedStrings(
    record?.["retiredCriterionIds"], PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
  );
  const retiredRequirements = readSortedStrings(
    record?.["retiredRequirementIds"], PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
  );
  const sources = readSortedStrings(
    record?.["sourceDocumentDigests"], PRODUCT_CONTRACT_V2_LIMITS.maxSourceDocuments, true,
  );
  if (record === null || !validProductContractClarificationV2Text(
    record["authorRef"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
  ) || !validProductContractClarificationV2Text(
    record["contractId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
  ) || !validProductContractClarificationV2Text(
    record["revisionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
  ) || retiredCriteria === null || retiredRequirements === null || sources === null
    || sources.length === 0
    || (record["lineage"] !== null && (lineage === null
      || !sha256String(lineage["parentRevisionDigest"])
      || !validProductContractClarificationV2Text(
        lineage["parentRevisionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
      )))) return null;
  return Object.freeze({
    authorRef: record["authorRef"], contractId: record["contractId"],
    lineage: lineage === null ? null : Object.freeze({
      parentRevisionDigest: lineage["parentRevisionDigest"] as string,
      parentRevisionId: lineage["parentRevisionId"] as string,
    }),
    retiredCriterionIds: retiredCriteria, retiredRequirementIds: retiredRequirements,
    revisionId: record["revisionId"], sourceDocumentDigests: sources,
  });
}

function readAsk(value: unknown): ProductContractClarificationV2DecisionProvenance | null {
  const record = exactDataRecord(value, ASK_KEYS);
  if (record === null || ![record["commandId"], record["correlationId"],
    record["decidedAt"], record["principalId"]]
    .every((candidate) => validProductContractClarificationV2Text(candidate))) return null;
  return Object.freeze({ commandId: record["commandId"] as string,
    correlationId: record["correlationId"] as string,
    decidedAt: record["decidedAt"] as string, principalId: record["principalId"] as string });
}

function readAnswer(value: unknown): ProductContractClarificationV2AnswerProvenance | null {
  const record = exactDataRecord(value, ANSWER_KEYS);
  if (record === null || ![record["answeredAt"], record["commandId"],
    record["correlationId"], record["principalId"]]
    .every((candidate) => validProductContractClarificationV2Text(candidate))
    || !validProductContractClarificationV2Text(
      record["optionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
    ) || !sha256String(record["projectionDigest"]) || !sha256String(record["revisionDigest"])) {
    return null;
  }
  return Object.freeze({ answeredAt: record["answeredAt"] as string,
    commandId: record["commandId"] as string,
    correlationId: record["correlationId"] as string, optionId: record["optionId"],
    principalId: record["principalId"] as string, projectionDigest: record["projectionDigest"],
    revisionDigest: record["revisionDigest"] });
}

function readOptions(value: unknown): ProductContractClarificationV2Row["optionDigests"] | null {
  const values = exactDataArray(value);
  if (values === null || values.length < 2
    || values.length > PRODUCT_CONTRACT_V2_LIMITS.maxOptionsPerDecision) return null;
  const options: ProductContractClarificationV2Row["optionDigests"][number][] = [];
  const projections = new Set<string>(); const revisions = new Set<string>();
  for (const candidate of values) {
    const option = exactDataRecord(candidate, OPTION_KEYS);
    if (option === null || !validProductContractClarificationV2Text(
      option["optionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
    ) || !validProductContractClarificationV2Text(
      option["label"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes,
    ) || !sha256String(option["projectionDigest"]) || !sha256String(option["revisionDigest"])
      || projections.has(option["projectionDigest"]) || revisions.has(option["revisionDigest"])
      || (options.length > 0 && compareProductContractV2CodeUnits(
        options.at(-1)!.optionId, option["optionId"],
      ) >= 0)) return null;
    projections.add(option["projectionDigest"]); revisions.add(option["revisionDigest"]);
    options.push(Object.freeze({ label: option["label"], optionId: option["optionId"],
      projectionDigest: option["projectionDigest"], revisionDigest: option["revisionDigest"] }));
  }
  return Object.freeze(options);
}

/** Exact decoder; it re-derives content identity before any row becomes authority. */
export function readProductContractClarificationV2Row(value: unknown): ProductContractClarificationV2Row | null {
  const record = exactDataRecord(value, ROW_KEYS);
  const askDecision = readAsk(record?.["askDecision"]);
  const identity = readIdentity(record?.["sharedIdentity"]);
  const options = readOptions(record?.["optionDigests"]);
  const answerDecision = record?.["answerDecision"] === null ? null
    : readAnswer(record?.["answerDecision"]);
  if (record === null || askDecision === null || identity === null || options === null
    || (record["answerDecision"] !== null && answerDecision === null)
    || record["schemaVersion"] !== PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION
    || record["contractId"] !== identity.contractId
    || askDecision.principalId !== identity.authorRef
    || !validProductContractClarificationV2Text(record["goalRef"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)
    || !validProductContractClarificationV2Text(record["question"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes)
    || !/^clar-v2-[0-9a-f]{64}$/u.test(String(record["clarificationId"]))) return null;
  if (answerDecision !== null && !options.some((option) =>
    option.optionId === answerDecision.optionId
      && option.projectionDigest === answerDecision.projectionDigest
      && option.revisionDigest === answerDecision.revisionDigest)) return null;
  const expectedId = deriveProductContractClarificationV2Id(
    record["goalRef"], identity, record["question"], options,
  );
  if (record["clarificationId"] !== expectedId) return null;
  return Object.freeze({ answerDecision, askDecision, clarificationId: expectedId,
    contractId: identity.contractId, goalRef: record["goalRef"], optionDigests: options,
    question: record["question"], schemaVersion: PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
    sharedIdentity: identity });
}
