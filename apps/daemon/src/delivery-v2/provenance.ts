import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  EVENT_RECORD_VERSION,
  EXPECTED_VERSION_DECISION_COVERAGE,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  identifyReplayRequest,
  type CommandDecisionResponse,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

export interface DeliveryV2EventProvenanceExpectation {
  readonly aggregateId: string;
  readonly commandKind: string;
  readonly domainSchemaVersion: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly expectedPrincipalId?: string;
  readonly expectedCommandId?: string;
  readonly expectedProjectId?: string;
  readonly expectedVersion: number;
  readonly payloadBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
}

export const deliveryV2BytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

export function validateDeliveryV2DecisionDisposition(value: CommandDecisionResponse): boolean {
  const replayed = value.disposition === "REPLAYED";
  return (value.disposition === "DECIDED" || replayed)
    && value.historical === replayed && value.requiresAffordanceRefresh === replayed;
}

/** Proves the domain event, scoped decision, replay request, and receipt as one exact effect. */
export function validateDeliveryV2EventProvenance(
  store: SqliteEventStore,
  event: StoredEvent,
  expected: DeliveryV2EventProvenanceExpectation,
): boolean {
  const trace = event.decisionTrace;
  if (event.aggregateId !== expected.aggregateId
    || event.aggregateSequence !== expected.expectedVersion + 1
    || event.recordVersion !== EVENT_RECORD_VERSION
    || event.payloadCodecVersion !== OPAQUE_PAYLOAD_CODEC_VERSION
    || event.metadata.byteLength !== 0
    || event.domainSchemaVersion !== expected.domainSchemaVersion
    || event.eventId !== expected.eventId || event.eventType !== expected.eventType
    || !deliveryV2BytesEqual(event.payload, expected.payloadBytes)
    || trace === undefined || trace.commandKind !== expected.commandKind
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    || (expected.expectedPrincipalId !== undefined
      && trace.principalId !== expected.expectedPrincipalId)
    || (expected.expectedCommandId !== undefined && trace.commandId !== expected.expectedCommandId)
    || (expected.expectedProjectId !== undefined
      && trace.projectId !== expected.expectedProjectId)) return false;
  try {
    const decision = store.getCommandDecision({
      commandId: trace.commandId,
      principalId: trace.principalId,
      projectId: trace.projectId,
    });
    const receipt = store.getCommandReceipt(event.commandId);
    return decision !== null && receipt !== null
      && decision.auditEventId === null
      && decision.key.commandId === trace.commandId
      && decision.key.principalId === trace.principalId
      && decision.key.projectId === trace.projectId
      && decision.commandKind === expected.commandKind
      && decision.coverage === EXPECTED_VERSION_DECISION_COVERAGE
      && decision.decisionIdentityVersion === COMMAND_DECISION_IDENTITY_VERSION
      && decision.recordVersion === COMMAND_DECISION_RECORD_VERSION
      && decision.effectDisposition === "EFFECTS_COMMITTED"
      && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
      && decision.resultCode === "EFFECTS_COMMITTED"
      && decision.resultVersion === COMMAND_DECISION_RESULT_VERSION
      && event.commandId === `moe-internal:decision-effect:${decision.decisionId}`
      && decision.targetAggregateId === expected.aggregateId
      && decision.expectedVersion === expected.expectedVersion
      && decision.observedVersion === expected.expectedVersion
      && decision.previousVersion === expected.expectedVersion
      && decision.currentVersion === expected.expectedVersion + 1
      && decision.decidedAt === event.committedAt
      && decision.businessEventIds.length === 1
      && decision.businessEventIds[0] === expected.eventId
      && decision.outboxMessageIds.length === 0
      && decision.requestIdentityVersion === trace.requestIdentityVersion
      && decision.requestSha256 === trace.requestSha256
      && decision.replayRequestSha256 === identifyReplayRequest(decision, expected.requestBytes)
      && decision.replayRequestSha256 === event.requestSha256
      && deliveryV2BytesEqual(decision.resultBytes, expected.resultBytes)
      && receipt.commandId === event.commandId
      && receipt.aggregateId === expected.aggregateId
      && receipt.committedAt === event.committedAt
      && receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
      && receipt.effectSha256 === decision.effectSha256
      && receipt.previousVersion === expected.expectedVersion
      && receipt.currentVersion === expected.expectedVersion + 1
      && receipt.eventIds.length === 1 && receipt.eventIds[0] === expected.eventId
      && receipt.outboxMessageIds.length === 0
      && receipt.requestSha256 === event.requestSha256;
  } catch {
    return false;
  }
}
