import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  identifyCorrelation,
  identifyReplayRequest,
  type CommandDecisionRecord,
  type DurableStoreErrorCode,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

import {
  encodeProductContractClarificationV2Value,
  productContractClarificationV2AnswerRequestBytes,
  productContractClarificationV2AskRequestBytes,
} from "./product-contract-v2-clarification-canonical.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import { readProductContractClarificationV2Row }
  from "./product-contract-v2-clarification-row.js";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameRow(
  left: ProductContractClarificationV2Row,
  right: ProductContractClarificationV2Row,
): boolean {
  return sameBytes(
    encodeProductContractClarificationV2Value(left),
    encodeProductContractClarificationV2Value(right),
  );
}

function decodeEventRow(event: StoredEvent): ProductContractClarificationV2Row | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok) return null;
  const row = readProductContractClarificationV2Row(decoded.value);
  return row !== null && sameBytes(event.payload, encodeProductContractClarificationV2Value(row))
    ? row : null;
}

interface ExpectedDecision {
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly requestBytes: Uint8Array;
  readonly row: ProductContractClarificationV2Row;
}

export type ProductContractClarificationV2ProvenanceResult =
  | Readonly<{ readonly kind: "VALID" }>
  | Readonly<{ readonly kind: "INVALID" }>
  | Readonly<{ readonly code: DurableStoreErrorCode | "STORAGE_DEGRADED";
    readonly kind: "UNREADABLE"; readonly layer: "DURABLE_STORE" }>;

const VALID = Object.freeze({ kind: "VALID" as const });
const INVALID = Object.freeze({ kind: "INVALID" as const });
function unreadable(error: unknown): ProductContractClarificationV2ProvenanceResult {
  return Object.freeze({
    code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    kind: "UNREADABLE" as const,
    layer: "DURABLE_STORE" as const,
  });
}

function validatesDecision(
  store: SqliteEventStore,
  projectId: string,
  aggregateId: string,
  event: StoredEvent,
  expected: ExpectedDecision,
): ProductContractClarificationV2ProvenanceResult {
  const expectedEventId = `${expected.commandId}-event`;
  if (event.aggregateId !== aggregateId
    || event.aggregateSequence !== expected.expectedVersion + 1
    || event.committedAt !== expected.decidedAt
    || event.domainSchemaVersion !== PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION
    || event.eventId !== expectedEventId || event.eventType !== expected.eventType
    || !sameBytes(event.payload, encodeProductContractClarificationV2Value(expected.row))) return INVALID;
  const trace = event.decisionTrace;
  if (trace === undefined || trace.commandId !== expected.commandId
    || trace.commandKind !== expected.commandKind || trace.principalId !== expected.principalId
    || trace.projectId !== projectId
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION) return INVALID;
  let decision: CommandDecisionRecord | null;
  let receipt: ReturnType<SqliteEventStore["getCommandReceipt"]>;
  try {
    decision = store.getCommandDecision({
      commandId: expected.commandId, principalId: expected.principalId, projectId,
    });
    receipt = store.getCommandReceipt(event.commandId);
  } catch (error) {
    return unreadable(error);
  }
  const agrees = decision !== null && decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.resultCode === "EFFECTS_COMMITTED"
    && decision.commandKind === expected.commandKind
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.key.commandId === expected.commandId
    && decision.key.principalId === expected.principalId
    && decision.key.projectId === projectId
    && event.commandId === `moe-internal:decision-effect:${decision.decisionId}`
    && decision.correlationSha256 === identifyCorrelation(expected.correlationId)
    && decision.targetAggregateId === aggregateId
    && decision.expectedVersion === expected.expectedVersion
    && decision.observedVersion === expected.expectedVersion
    && decision.previousVersion === expected.expectedVersion
    && decision.currentVersion === expected.expectedVersion + 1
    && decision.decidedAt === expected.decidedAt
    && decision.businessEventIds.length === 1
    && decision.businessEventIds[0] === expectedEventId
    && decision.outboxMessageIds.length === 0
    && decision.requestSha256 === trace.requestSha256
    && decision.requestIdentityVersion === trace.requestIdentityVersion
    && decision.replayRequestSha256 === identifyReplayRequest(decision, expected.requestBytes)
    && decision.replayRequestSha256 === event.requestSha256
    && sameBytes(decision.resultBytes, event.payload)
    && receipt !== null
    && receipt.commandId === event.commandId
    && receipt.aggregateId === aggregateId
    && receipt.committedAt === event.committedAt
    && receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.effectSha256 === decision.effectSha256
    && receipt.previousVersion === expected.expectedVersion
    && receipt.currentVersion === expected.expectedVersion + 1
    && receipt.eventIds.length === 1
    && receipt.eventIds[0] === expectedEventId
    && receipt.outboxMessageIds.length === 0
    && receipt.requestSha256 === event.requestSha256;
  return agrees ? VALID : INVALID;
}

export function validateProductContractClarificationV2Provenance(
  store: SqliteEventStore,
  projectId: string,
  aggregateId: string,
  row: ProductContractClarificationV2Row,
): ProductContractClarificationV2ProvenanceResult {
  let page: ReturnType<SqliteEventStore["readAggregateEvents"]>;
  try { page = store.readAggregateEvents(aggregateId, 0, 3); }
  catch (error) { return unreadable(error); }
  const expectedCount = row.answerDecision === null ? 1 : 2;
  if (page.hasMore || page.items.length !== expectedCount) return INVALID;
  const askEvent = page.items[0];
  if (askEvent === undefined) return INVALID;
  const askRow = readProductContractClarificationV2Row({ ...row, answerDecision: null });
  const decodedAsk = decodeEventRow(askEvent);
  if (askRow === null || decodedAsk === null || !sameRow(decodedAsk, askRow)) return INVALID;
  const askValidation = validatesDecision(store, projectId, aggregateId, askEvent, {
    commandId: row.askDecision.commandId,
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
    correlationId: row.askDecision.correlationId,
    decidedAt: row.askDecision.decidedAt,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
    expectedVersion: 0,
    principalId: row.askDecision.principalId,
    requestBytes: productContractClarificationV2AskRequestBytes(askRow),
    row: askRow,
  });
  if (askValidation.kind !== "VALID") return askValidation;
  if (row.answerDecision === null) return VALID;
  const answerEvent = page.items[1];
  if (answerEvent === undefined) return INVALID;
  const decodedAnswer = decodeEventRow(answerEvent);
  if (decodedAnswer === null || !sameRow(decodedAnswer, row)) return INVALID;
  return validatesDecision(store, projectId, aggregateId, answerEvent, {
    commandId: row.answerDecision.commandId,
    commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
    correlationId: row.answerDecision.correlationId,
    decidedAt: row.answerDecision.answeredAt,
    eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
    expectedVersion: 1,
    principalId: row.answerDecision.principalId,
    requestBytes: productContractClarificationV2AnswerRequestBytes(row),
    row,
  });
}
