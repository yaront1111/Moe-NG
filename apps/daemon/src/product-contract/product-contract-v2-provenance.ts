import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  identifyReplayRequest,
  type CommandDecisionRecord,
  type CommandReceipt,
  type DurableStoreErrorCode,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

import {
  PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND,
} from "./product-contract-v2-address.js";

export const PRODUCT_CONTRACT_V2_REVISION_READER_LAYER =
  "PRODUCT_CONTRACT_V2_REVISION_READER" as const;
export type ProductContractV2ProvenanceCode =
  | "PRODUCT_CONTRACT_V2_PROVENANCE_ABSENT"
  | "PRODUCT_CONTRACT_V2_COMMAND_KIND_MISMATCH"
  | "PRODUCT_CONTRACT_V2_DECISION_UNRESOLVED"
  | "PRODUCT_CONTRACT_V2_RECEIPT_UNBOUND"
  | "PRODUCT_CONTRACT_V2_ATOMIC_BINDING_MISMATCH";
export type ProductContractV2ProvenanceResult = Readonly<{ ok: true }>
  | Readonly<{
    code: DurableStoreErrorCode | ProductContractV2ProvenanceCode | "STORAGE_DEGRADED";
    layer: "DURABLE_STORE" | typeof PRODUCT_CONTRACT_V2_REVISION_READER_LAYER;
    ok: false;
  }>;

const HEX64 = /^[0-9a-f]{64}$/u;
type DecisionTrace = NonNullable<StoredEvent["decisionTrace"]>;

function refuse(code: ProductContractV2ProvenanceCode): ProductContractV2ProvenanceResult {
  return Object.freeze({ code, layer: PRODUCT_CONTRACT_V2_REVISION_READER_LAYER, ok: false });
}
function storeFailure(error: unknown): ProductContractV2ProvenanceResult {
  return Object.freeze({
    code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    layer: error instanceof DurableStoreError
      ? "DURABLE_STORE" : PRODUCT_CONTRACT_V2_REVISION_READER_LAYER,
    ok: false,
  });
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function traceOf(event: StoredEvent): DecisionTrace | null {
  const trace = event.decisionTrace;
  return trace === undefined || trace.commandId === "" || trace.principalId === ""
    || trace.projectId === "" || !HEX64.test(trace.requestSha256)
    || !HEX64.test(event.requestSha256)
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    || !Number.isSafeInteger(event.aggregateSequence) || event.aggregateSequence < 1
    ? null : trace;
}
function sameTrace(left: DecisionTrace, right: DecisionTrace): boolean {
  return left.commandId === right.commandId && left.commandKind === right.commandKind
    && left.principalId === right.principalId && left.projectId === right.projectId
    && left.requestIdentityVersion === right.requestIdentityVersion
    && left.requestSha256 === right.requestSha256;
}
function receiptAgrees(event: StoredEvent, receipt: CommandReceipt): boolean {
  const prior = event.aggregateSequence - 1;
  return receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.commandId === event.commandId && receipt.aggregateId === event.aggregateId
    && receipt.previousVersion === prior && receipt.currentVersion === event.aggregateSequence
    && receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId
    && receipt.outboxMessageIds.length === 0 && receipt.committedAt === event.committedAt
    && receipt.requestSha256 === event.requestSha256;
}
function decisionAgrees(
  decision: CommandDecisionRecord,
  trace: DecisionTrace,
  revisionEvent: StoredEvent,
  slotEvent: StoredEvent,
): boolean {
  return decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.resultCode === "EFFECTS_COMMITTED"
    && decision.commandKind === PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.key.commandId === trace.commandId
    && decision.key.principalId === trace.principalId
    && decision.key.projectId === trace.projectId
    && decision.targetAggregateId === revisionEvent.aggregateId
    && decision.expectedVersion === 0 && decision.observedVersion === 0
    && decision.previousVersion === 0 && decision.currentVersion === 1
    && decision.businessEventIds.length === 1
    && decision.businessEventIds[0] === revisionEvent.eventId
    && decision.outboxMessageIds.length === 0
    && decision.decidedAt === revisionEvent.committedAt
    && decision.decidedAt === slotEvent.committedAt
    && decision.requestSha256 === trace.requestSha256
    && decision.replayRequestSha256 === identifyReplayRequest(decision, revisionEvent.payload)
    && sameBytes(decision.resultBytes, slotEvent.payload);
}

/** Proves both event legs came from one exact atomic v2 command decision. */
export function validateProductContractV2EventProvenance(
  store: SqliteEventStore,
  input: Readonly<{
    contractId: string;
    projectId: string;
    revisionEvent: StoredEvent;
    revisionId: string;
    slotEvent: StoredEvent;
  }>,
): ProductContractV2ProvenanceResult {
  const revisionTrace = traceOf(input.revisionEvent);
  const slotTrace = traceOf(input.slotEvent);
  if (revisionTrace === null || slotTrace === null) {
    return refuse("PRODUCT_CONTRACT_V2_PROVENANCE_ABSENT");
  }
  if (revisionTrace.commandKind !== PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND
    || slotTrace.commandKind !== PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND) {
    return refuse("PRODUCT_CONTRACT_V2_COMMAND_KIND_MISMATCH");
  }
  if (!sameTrace(revisionTrace, slotTrace) || revisionTrace.projectId !== input.projectId
    || revisionTrace.commandId === "") {
    return refuse("PRODUCT_CONTRACT_V2_ATOMIC_BINDING_MISMATCH");
  }
  try {
    const decision = store.getCommandDecision({ commandId: revisionTrace.commandId,
      principalId: revisionTrace.principalId, projectId: input.projectId });
    if (decision === null
      || !decisionAgrees(decision, revisionTrace, input.revisionEvent, input.slotEvent)) {
      return refuse("PRODUCT_CONTRACT_V2_DECISION_UNRESOLVED");
    }
    const revisionReceipt = store.getCommandReceipt(input.revisionEvent.commandId);
    const slotReceipt = store.getCommandReceipt(input.slotEvent.commandId);
    if (revisionReceipt === null || slotReceipt === null
      || !receiptAgrees(input.revisionEvent, revisionReceipt)
      || revisionReceipt.effectSha256 !== decision.effectSha256
      || !receiptAgrees(input.slotEvent, slotReceipt)) {
      return refuse("PRODUCT_CONTRACT_V2_RECEIPT_UNBOUND");
    }
    return Object.freeze({ ok: true as const });
  } catch (error) { return storeFailure(error); }
}
