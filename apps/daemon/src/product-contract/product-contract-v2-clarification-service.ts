import {
  PRODUCT_CONTRACT_V2_LIMITS,
  assessProductContractClarificationMaterialityV2,
  type ProductContractClarificationV2MaterialityResult,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { exactDataRecord } from "../documents/document-work-safe-value.js";
import { validateProductContractClarificationV2AskCurrentAuthority,
  validateProductContractClarificationV2AskIdentityAuthority }
  from "./product-contract-v2-clarification-ask-authority.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  deriveProductContractClarificationV2Id,
  productContractClarificationV2AggregateId,
  productContractClarificationV2AnswerCommandId,
  productContractClarificationV2AnswerRequestBytes,
  productContractClarificationV2AskCommandId,
  productContractClarificationV2AskRequestBytes,
  type ProductContractClarificationV2CommandInput,
  type ProductContractClarificationV2Result,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import { validProductContractClarificationV2Text }
  from "./product-contract-v2-clarification-row.js";
import {
  readProductContractClarificationV2,
} from "./product-contract-v2-clarification-reader.js";
import {
  commitProductContractClarificationV2Row as commitRow,
  productContractClarificationV2Accepted as accepted,
  productContractClarificationV2Refused as refused,
  sameProductContractClarificationV2Ask as sameAsk,
  validProductContractClarificationV2CommandInput as validInput,
} from "./product-contract-v2-clarification-writer.js";
export {
  PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_CODES,
  PRODUCT_CONTRACT_CLARIFICATION_V2_CORRUPT_OPEN_ID,
  PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  productContractClarificationV2AggregateId,
} from "./product-contract-v2-clarification-contract.js";
export type {
  ProductContractClarificationV2Accepted,
  ProductContractClarificationV2AnswerProvenance,
  ProductContractClarificationV2Code,
  ProductContractClarificationV2CommandInput,
  ProductContractClarificationV2DecisionProvenance,
  ProductContractClarificationV2Refused,
  ProductContractClarificationV2Result,
  ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
export {
  createProductContractClarificationV2OpenReader,
  productContractClarificationsV2ForContract,
  readProductContractClarificationV2,
  readProductContractClarificationsV2ForContract,
} from "./product-contract-v2-clarification-reader.js";
export type {
  ProductContractClarificationV2OpenReader,
  ProductContractClarificationV2Read,
} from "./product-contract-v2-clarification-reader.js";
export { readProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";
export type { ProductContractClarificationV2Authority, ProductContractClarificationV2Selection }
  from "./product-contract-v2-clarification-authority.js";
function reconcileAsk(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  expected: ProductContractClarificationV2Row,
): ProductContractClarificationV2Result {
  const read = readProductContractClarificationV2(
    store, input.projectId, expected.contractId, expected.clarificationId,
  );
  if (read.kind === "PRESENT" && sameAsk(read.row, expected)) {
    return accepted(expected.clarificationId, "REPLAYED");
  }
  if (read.kind === "UNREADABLE") return refused(read.code, read.layer);
  return read.kind === "INVALID" || read.kind === "PRESENT"
    ? refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID")
    : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STORE_REFUSED", "DURABLE_STORE");
}
export function runAskProductContractClarificationV2(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
): ProductContractClarificationV2Result {
  const payload = exactDataRecord(input.payload, PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS);
  if (!validInput(input) || payload === null
    || !validProductContractClarificationV2Text(payload["contractId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)
    || !validProductContractClarificationV2Text(payload["goalRef"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)
    || !validProductContractClarificationV2Text(payload["question"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes)) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED");
  }
  if (input.targetAggregateId !== payload["goalRef"]) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_TARGET_MISMATCH");
  }
  const materiality: ProductContractClarificationV2MaterialityResult =
    assessProductContractClarificationMaterialityV2({
      options: payload["options"], question: payload["question"],
    });
  if (!materiality.ok) return materiality;
  if (materiality.contractId !== payload["contractId"]) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED");
  }
  const identityAuthority = validateProductContractClarificationV2AskIdentityAuthority(
    store, input, payload["goalRef"], materiality,
  );
  if (!identityAuthority.ok) return identityAuthority;
  const clarificationId = deriveProductContractClarificationV2Id(
    payload["goalRef"], materiality.sharedIdentity, payload["question"],
    materiality.optionDigests,
  );
  const row: ProductContractClarificationV2Row = Object.freeze({
    answerDecision: null,
    askDecision: Object.freeze({
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      principalId: input.principalId,
    }),
    clarificationId,
    contractId: materiality.contractId,
    goalRef: payload["goalRef"],
    optionDigests: materiality.optionDigests,
    question: payload["question"],
    schemaVersion: PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
    sharedIdentity: materiality.sharedIdentity,
  });
  const aggregateId = productContractClarificationV2AggregateId(
    input.projectId, row.contractId, clarificationId,
  );
  const prior = readProductContractClarificationV2(
    store, input.projectId, row.contractId, clarificationId,
  );
  if (prior.kind !== "ABSENT") return reconcileAsk(store, input, row);
  const currentAuthority = validateProductContractClarificationV2AskCurrentAuthority(
    store, input, materiality,
  );
  if (!currentAuthority.ok) return currentAuthority;
  const disposition = commitRow(store, input, aggregateId, {
    commandId: productContractClarificationV2AskCommandId(
      input.projectId, row.contractId, clarificationId,
    ),
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
    expectedVersion: 0,
    requestBytes: productContractClarificationV2AskRequestBytes(row),
    row,
  });
  return disposition === null
    ? reconcileAsk(store, input, row) : accepted(clarificationId, disposition);
}

function reconcileAnswer(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  contractId: string,
  clarificationId: string,
  optionId: string,
): ProductContractClarificationV2Result {
  const read = readProductContractClarificationV2(
    store, input.projectId, contractId, clarificationId,
  );
  if (read.kind === "PRESENT" && read.row.answerDecision?.optionId === optionId) {
    return accepted(clarificationId, "REPLAYED");
  }
  if (read.kind === "PRESENT" && read.row.answerDecision !== null) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED");
  }
  if (read.kind === "UNREADABLE") return refused(read.code, read.layer);
  return read.kind === "INVALID"
    ? refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID")
    : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STORE_REFUSED", "DURABLE_STORE");
}

export function runAnswerProductContractClarificationV2(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
): ProductContractClarificationV2Result {
  const payload = exactDataRecord(
    input.payload, PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
  );
  if (!validInput(input) || payload === null
    || !validProductContractClarificationV2Text(payload["answerOptionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)
    || typeof payload["clarificationId"] !== "string"
    || !/^clar-v2-[0-9a-f]{64}$/u.test(payload["clarificationId"])
    || !validProductContractClarificationV2Text(payload["contractId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED");
  }
  const aggregateId = productContractClarificationV2AggregateId(
    input.projectId, payload["contractId"], payload["clarificationId"],
  );
  if (input.targetAggregateId !== aggregateId) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_TARGET_MISMATCH");
  }
  const read = readProductContractClarificationV2(
    store, input.projectId, payload["contractId"], payload["clarificationId"],
  );
  if (read.kind === "ABSENT") return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_UNKNOWN");
  if (read.kind === "INVALID") {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID");
  }
  if (read.kind === "UNREADABLE") return refused(read.code, read.layer);
  if (read.row.answerDecision !== null) {
    return read.row.answerDecision.optionId === payload["answerOptionId"]
      ? accepted(read.row.clarificationId, "REPLAYED")
      : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED");
  }
  const option = read.row.optionDigests.find(
    (candidate) => candidate.optionId === payload["answerOptionId"],
  );
  if (option === undefined) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_ANSWER_UNKNOWN_OPTION");
  }
  const row: ProductContractClarificationV2Row = Object.freeze({
    ...read.row,
    answerDecision: Object.freeze({
      answeredAt: input.decidedAt,
      correlationId: input.correlationId,
      optionId: option.optionId,
      principalId: input.principalId,
      projectionDigest: option.projectionDigest,
      revisionDigest: option.revisionDigest,
    }),
  });
  const disposition = commitRow(store, input, aggregateId, {
    commandId: productContractClarificationV2AnswerCommandId(
      input.projectId, row.contractId, row.clarificationId,
    ),
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
    expectedVersion: 1,
    requestBytes: productContractClarificationV2AnswerRequestBytes(row),
    row,
  });
  return disposition === null
    ? reconcileAnswer(store, input, row.contractId, row.clarificationId, option.optionId)
    : accepted(row.clarificationId, disposition);
}
