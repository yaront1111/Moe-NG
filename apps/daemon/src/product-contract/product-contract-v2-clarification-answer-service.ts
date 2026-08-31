import { PRODUCT_CONTRACT_V2_LIMITS } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { exactDataRecord } from "../documents/document-work-safe-value.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
  productContractClarificationV2AggregateId,
  productContractClarificationV2AnswerRequestBytes,
  type ProductContractClarificationV2CommandInput,
  type ProductContractClarificationV2Result,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import { projectProductContractClarificationV2AnswerAuthority }
  from "./product-contract-v2-clarification-projection.js";
import { readProductContractClarificationV2 }
  from "./product-contract-v2-clarification-reader.js";
import { validProductContractClarificationV2Text }
  from "./product-contract-v2-clarification-row.js";
import {
  commitProductContractClarificationV2Row as commitRow,
  isExactProductContractClarificationV2Replay as exactReplay,
  productContractClarificationV2Accepted as accepted,
  productContractClarificationV2Refused as refused,
  validProductContractClarificationV2CommandInput as validInput,
} from "./product-contract-v2-clarification-writer.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";
import { prepareProductContractV2AnswerWorkflow }
  from "./product-contract-v2-workflow-transition.js";

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
    if (read.row.answerDecision.commandId !== input.commandId
      || read.row.answerDecision.principalId !== input.principalId) {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED");
    }
    const replay = exactReplay(store, input, productContractClarificationV2AggregateId(
      input.projectId, contractId, clarificationId,
    ), { commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
      expectedVersion: 1, requestBytes: productContractClarificationV2AnswerRequestBytes(read.row),
      row: read.row });
    if (replay.kind === "UNREADABLE") return refused(replay.code, replay.layer);
    if (replay.kind !== "EXACT") {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED");
    }
    const workflow = readProductContractV2WorkflowHead(store, { contractId,
      projectId: input.projectId, requiredCause: Object.freeze({ clarificationId,
        commandId: read.row.answerDecision.commandId, kind: "ANSWER" }) });
    if (!workflow.ok) return refused(workflow.code, workflow.layer);
    if (!workflow.companionFound) {
      return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID", "PRODUCT_CONTRACT_V2_WORKFLOW");
    }
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
      ? reconcileAnswer(store, input, read.row.contractId, read.row.clarificationId,
        payload["answerOptionId"])
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
      commandId: input.commandId,
      correlationId: input.correlationId,
      optionId: option.optionId,
      principalId: input.principalId,
      projectionDigest: option.projectionDigest,
      revisionDigest: option.revisionDigest,
    }),
  });
  const authority = projectProductContractClarificationV2AnswerAuthority(
    store, row, input.projectId,
  );
  if (!authority.ok) return refused(authority.code, authority.layer);
  const workflow = prepareProductContractV2AnswerWorkflow(store, {
    clarificationId: row.clarificationId, commandId: input.commandId,
    clarificationStatus: authority.status, contractId: row.contractId,
    goalRef: row.goalRef, projectId: input.projectId,
  });
  if (!workflow.ok) return workflow;
  const disposition = commitRow(store, input, aggregateId, {
    commandId: input.commandId,
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
    expectedVersion: 1,
    requestBytes: productContractClarificationV2AnswerRequestBytes(row),
    row,
    secondaryLegs: Object.freeze([workflow.leg]),
  });
  return typeof disposition === "string"
    ? accepted(row.clarificationId, disposition) : disposition;
}
