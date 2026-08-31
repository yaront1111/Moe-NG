import type { SqliteEventStore } from "@moe/store";

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

export interface ProductContractClarificationV2RowCommit {
  readonly commandId: string;
  readonly commandKind: string;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly requestBytes: Uint8Array;
  readonly row: ProductContractClarificationV2Row;
}

export function commitProductContractClarificationV2Row(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  aggregateId: string,
  commit: ProductContractClarificationV2RowCommit,
): "DECIDED" | "REPLAYED" | null {
  const rowBytes = encodeProductContractClarificationV2Value(commit.row);
  try {
    const response = store.commitExpectedVersionDecision({
      commandKind: commit.commandKind,
      committedResultBytes: rowBytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      events: [{
        domainSchemaVersion: PRODUCT_CONTRACT_CLARIFICATION_V2_SCHEMA_VERSION,
        eventId: `${commit.commandId}-event`, eventType: commit.eventType, payload: rowBytes,
      }],
      expectedVersion: commit.expectedVersion,
      key: { commandId: commit.commandId, principalId: input.principalId,
        projectId: input.projectId },
      requestBytes: commit.requestBytes,
      targetAggregateId: aggregateId,
    });
    return response.decision.effectDisposition === "EFFECTS_COMMITTED"
      ? response.disposition : null;
  } catch {
    return null;
  }
}
