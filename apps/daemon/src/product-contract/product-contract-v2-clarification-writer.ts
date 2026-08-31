import { COMMAND_EFFECT_IDENTITY_VERSION, DurableStoreError, identifyReplayRequest,
  type ExpectedVersionDecisionLeg,
  type SqliteEventStore } from "@moe/store";

import { encodeProductContractClarificationV2Value }
  from "./product-contract-v2-clarification-canonical.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER,
  PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
  type ProductContractClarificationV2Accepted,
  type ProductContractClarificationV2Code,
  type ProductContractClarificationV2CommandInput,
  type ProductContractClarificationV2Refused,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import { validProductContractClarificationV2Text }
  from "./product-contract-v2-clarification-row.js";

export function productContractClarificationV2Refused(
  code: ProductContractClarificationV2Code | string,
  layer: ProductContractClarificationV2Refused["layer"] =
    PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER,
): ProductContractClarificationV2Refused {
  return Object.freeze({ code, layer, ok: false as const });
}

export function productContractClarificationV2Accepted(
  clarificationId: string,
  disposition: ProductContractClarificationV2Accepted["disposition"],
): ProductContractClarificationV2Accepted {
  return Object.freeze({ clarificationId, disposition, ok: true as const });
}

export function validProductContractClarificationV2CommandInput(
  input: ProductContractClarificationV2CommandInput,
): boolean {
  return validProductContractClarificationV2Text(input.correlationId)
    && validProductContractClarificationV2Text(input.commandId)
    && validProductContractClarificationV2Text(input.decidedAt)
    && validProductContractClarificationV2Text(input.principalId)
    && validProductContractClarificationV2Text(input.projectId)
    && validProductContractClarificationV2Text(input.targetAggregateId);
}

export function sameProductContractClarificationV2Ask(
  row: ProductContractClarificationV2Row,
  expected: ProductContractClarificationV2Row,
): boolean {
  if (expected.answerDecision !== null) return false;
  const content = (candidate: ProductContractClarificationV2Row) => ({
    clarificationId: candidate.clarificationId, contractId: candidate.contractId,
    goalRef: candidate.goalRef, optionDigests: candidate.optionDigests,
    question: candidate.question, schemaVersion: candidate.schemaVersion,
    sharedIdentity: candidate.sharedIdentity,
  });
  const left = encodeProductContractClarificationV2Value(content(row));
  const right = encodeProductContractClarificationV2Value(content(expected));
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

export interface ProductContractClarificationV2ReplayExpectation {
  readonly commandKind: string;
  readonly expectedVersion: number;
  readonly requestBytes: Uint8Array;
  readonly row: ProductContractClarificationV2Row;
}
export type ProductContractClarificationV2ReplayProof =
  | Readonly<{ readonly kind: "EXACT" }>
  | Readonly<{ readonly kind: "MISMATCH" }>
  | Readonly<{ readonly code: string; readonly kind: "UNREADABLE";
    readonly layer: "DURABLE_STORE" }>;

const EXACT_REPLAY = Object.freeze({ kind: "EXACT" as const });
const MISMATCHED_REPLAY = Object.freeze({ kind: "MISMATCH" as const });

/** Proves replay from the submitted durable key, its exact request, event, and receipt. */
export function isExactProductContractClarificationV2Replay(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  aggregateId: string,
  expected: ProductContractClarificationV2ReplayExpectation,
): ProductContractClarificationV2ReplayProof {
  try {
    const decision = store.getCommandDecision({ commandId: input.commandId,
      principalId: input.principalId, projectId: input.projectId });
    const event = store.readAggregateEvents(
      aggregateId, expected.expectedVersion, 1,
    ).items[0];
    const receipt = event === undefined ? null : store.getCommandReceipt(event.commandId);
    const rowBytes = encodeProductContractClarificationV2Value(expected.row);
    const eventId = `${input.commandId}-event`;
    const exact = decision !== null && event !== undefined && receipt !== null
      && decision.effectDisposition === "EFFECTS_COMMITTED"
      && decision.resultCode === "EFFECTS_COMMITTED"
      && decision.commandKind === expected.commandKind
      && decision.key.commandId === input.commandId
      && decision.key.principalId === input.principalId
      && decision.key.projectId === input.projectId
      && decision.targetAggregateId === aggregateId
      && decision.expectedVersion === expected.expectedVersion
      && decision.observedVersion === expected.expectedVersion
      && decision.previousVersion === expected.expectedVersion
      && decision.currentVersion === expected.expectedVersion + 1
      && decision.businessEventIds.length === 1
      && decision.businessEventIds[0] === eventId
      && decision.replayRequestSha256 === identifyReplayRequest(decision, expected.requestBytes)
      && sameBytes(decision.resultBytes, rowBytes)
      && event.aggregateId === aggregateId
      && event.aggregateSequence === expected.expectedVersion + 1
      && event.eventId === eventId
      && event.commandId === `moe-internal:decision-effect:${decision.decisionId}`
      && sameBytes(event.payload, rowBytes)
      && receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
      && receipt.effectSha256 === decision.effectSha256
      && receipt.aggregateId === aggregateId && receipt.commandId === event.commandId
      && receipt.previousVersion === expected.expectedVersion
      && receipt.currentVersion === expected.expectedVersion + 1
      && receipt.eventIds.length === 1 && receipt.eventIds[0] === eventId
      && receipt.requestSha256 === decision.replayRequestSha256;
    return exact ? EXACT_REPLAY : MISMATCHED_REPLAY;
  } catch (error) {
    return Object.freeze({ code: error instanceof DurableStoreError
      ? error.code : "STORAGE_DEGRADED", kind: "UNREADABLE" as const,
    layer: "DURABLE_STORE" as const });
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

export interface ProductContractClarificationV2RowCommit {
  readonly commandId: string;
  readonly commandKind: string;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly requestBytes: Uint8Array;
  readonly row: ProductContractClarificationV2Row;
  readonly secondaryLegs: readonly ExpectedVersionDecisionLeg[];
}

export function commitProductContractClarificationV2Row(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  aggregateId: string,
  commit: ProductContractClarificationV2RowCommit,
): "DECIDED" | "REPLAYED" | ProductContractClarificationV2Refused {
  const rowBytes = encodeProductContractClarificationV2Value(commit.row);
  try {
    const response = store.commitExpectedVersionDecisionLegs({
      commandKind: commit.commandKind,
      committedResultBytes: rowBytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key: { commandId: commit.commandId, principalId: input.principalId,
        projectId: input.projectId },
      legs: [{ aggregateId, events: [{
        domainSchemaVersion: PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
        eventId: `${commit.commandId}-event`, eventType: commit.eventType, payload: rowBytes,
      }], expectedVersion: commit.expectedVersion }, ...commit.secondaryLegs],
      requestBytes: commit.requestBytes,
    });
    return response.decision.effectDisposition === "EFFECTS_COMMITTED"
      ? response.disposition
      : productContractClarificationV2Refused(response.decision.resultCode, "DURABLE_STORE");
  } catch (error) {
    return productContractClarificationV2Refused(
      error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER,
    );
  }
}
