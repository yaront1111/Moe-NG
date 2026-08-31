import {
  PRODUCT_CONTRACT_V2_LIMITS,
  assessProductContractClarificationMaterialityV2,
  productContractGate1Authority,
  type ProductContractClarificationV2MaterialityResult,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { exactDataRecord } from "../documents/document-work-safe-value.js";
import { validateProductContractClarificationV2AskCurrentAuthority,
  validateProductContractClarificationV2AskIdentityAuthority }
  from "./product-contract-v2-clarification-ask-authority.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  deriveProductContractClarificationV2Id,
  productContractClarificationV2AggregateId,
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
  isExactProductContractClarificationV2Replay as exactReplay,
  productContractClarificationV2Accepted as accepted,
  productContractClarificationV2Refused as refused,
  sameProductContractClarificationV2Ask as sameAsk,
  validProductContractClarificationV2CommandInput as validInput,
} from "./product-contract-v2-clarification-writer.js";
import { deriveProductContractGate1AggregateId }
  from "./product-contract-gate-1-contract.js";
import { prepareProductContractV2GoalBindingLegs }
  from "./product-contract-v2-goal-binding-leg.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";
import { prepareProductContractV2AskWorkflow }
  from "./product-contract-v2-workflow-transition.js";
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
export { runAnswerProductContractClarificationV2 }
  from "./product-contract-v2-clarification-answer-service.js";
function reconcileAsk(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  expected: ProductContractClarificationV2Row,
): ProductContractClarificationV2Result {
  const read = readProductContractClarificationV2(
    store, input.projectId, expected.contractId, expected.clarificationId,
  );
  if (read.kind === "PRESENT" && sameAsk(read.row, expected)) {
    const askRow = Object.freeze({ ...read.row, answerDecision: null });
    if (read.row.askDecision.commandId !== input.commandId
      || read.row.askDecision.principalId !== input.principalId) {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID");
    }
    const replay = exactReplay(store, input, productContractClarificationV2AggregateId(
      input.projectId, expected.contractId, expected.clarificationId,
    ), { commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
      expectedVersion: 0, requestBytes: productContractClarificationV2AskRequestBytes(askRow),
      row: askRow });
    if (replay.kind === "UNREADABLE") return refused(replay.code, replay.layer);
    if (replay.kind !== "EXACT") {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID");
    }
    const workflow = readProductContractV2WorkflowHead(store, {
      contractId: expected.contractId, projectId: input.projectId,
      requiredCause: Object.freeze({ clarificationId: expected.clarificationId,
        commandId: read.row.askDecision.commandId, kind: "ASK" }),
    });
    if (!workflow.ok) return refused(workflow.code, workflow.layer);
    if (!workflow.companionFound) {
      return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID", "PRODUCT_CONTRACT_V2_WORKFLOW");
    }
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
      commandId: input.commandId,
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
  const binding = prepareProductContractV2GoalBindingLegs(store, {
    cause: Object.freeze({ commandId: input.commandId, kind: "CLARIFICATION",
      ref: clarificationId }), commandId: input.commandId, contractId: row.contractId,
    goalRef: row.goalRef, projectId: input.projectId,
  });
  if (!binding.ok) return binding;
  const workflow = prepareProductContractV2AskWorkflow(store, {
    clarificationId, commandId: input.commandId, goalRef: row.goalRef,
    identity: row.sharedIdentity, projectId: input.projectId,
  });
  if (!workflow.ok) return workflow;
  const sameCurrentRef = workflow.head.cause.revisionRef;
  if (sameCurrentRef !== null) {
    const gateAggregateId = deriveProductContractGate1AggregateId(
      productContractGate1Authority(sameCurrentRef).workRef,
    );
    if (store.getAggregateVersion(gateAggregateId) !== 0) {
      return refused("PRODUCT_CONTRACT_V2_WORKFLOW_GATE_1_ALREADY_APPROVED",
        "PRODUCT_CONTRACT_V2_WORKFLOW");
    }
  }
  const disposition = commitRow(store, input, aggregateId, {
    commandId: input.commandId,
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
    expectedVersion: 0,
    requestBytes: productContractClarificationV2AskRequestBytes(row),
    row,
    secondaryLegs: Object.freeze([...binding.legs, workflow.leg,
      ...(sameCurrentRef === null ? [] : [Object.freeze({ aggregateId:
        deriveProductContractGate1AggregateId(productContractGate1Authority(
          sameCurrentRef,
        ).workRef), events: Object.freeze([]), expectedVersion: 0 })])]),
  });
  return typeof disposition === "string"
    ? accepted(clarificationId, disposition) : disposition;
}
