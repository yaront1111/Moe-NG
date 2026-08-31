import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

import { PRODUCT_CONTRACT_GATE_1_COMMAND_KIND }
  from "./product-contract-gate-1-contract.js";
import { PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND } from "./product-contract-v2-address.js";
import { PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  }
  from "./product-contract-v2-clarification-contract.js";
import {
  PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE,
  PRODUCT_CONTRACT_V2_WORKFLOW_LAYER,
  PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS,
  PRODUCT_CONTRACT_V2_WORKFLOW_VERSION,
  decodeProductContractV2WorkflowHead,
  deriveProductContractV2WorkflowAggregateId,
  encodeProductContractV2WorkflowHead,
  sameProductContractV2WorkflowRef,
  type ProductContractV2WorkflowHead,
} from "./product-contract-v2-workflow-contract.js";
import { readProductContractV2WorkflowPrimary }
  from "./product-contract-v2-workflow-primary.js";

export type ProductContractV2WorkflowRead = Readonly<{
  readonly companionFound: boolean;
  readonly head: ProductContractV2WorkflowHead;
  readonly ok: true;
}> | Readonly<{
  readonly code: string;
  readonly layer: "DURABLE_STORE" | typeof PRODUCT_CONTRACT_V2_WORKFLOW_LAYER;
  readonly ok: false;
}>;

const refused = (code: string): ProductContractV2WorkflowRead => Object.freeze({
  code, layer: PRODUCT_CONTRACT_V2_WORKFLOW_LAYER, ok: false as const,
});
function storeFailure(error: unknown): ProductContractV2WorkflowRead {
  return Object.freeze({ code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    layer: error instanceof DurableStoreError ? "DURABLE_STORE" as const
      : PRODUCT_CONTRACT_V2_WORKFLOW_LAYER, ok: false as const });
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
function sameStable(a: ProductContractV2WorkflowHead,
  b: ProductContractV2WorkflowHead): boolean {
  return a.contractId === b.contractId && a.goalRef === b.goalRef
    && a.projectId === b.projectId && sameProductContractV2WorkflowRef(
      a.currentRevision, b.currentRevision,
    ) && a.currentSlotDigest === b.currentSlotDigest
    && a.currentSlotGeneration === b.currentSlotGeneration;
}
function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}
function transition(previous: ProductContractV2WorkflowHead | undefined,
  next: ProductContractV2WorkflowHead): boolean {
  if (next.generation !== (previous?.generation ?? 0) + 1) return false;
  const cause = next.cause;
  if (previous === undefined) {
    return cause.kind === "ASK" ? cause.clarificationId !== null && cause.revisionRef === null
      && next.currentRevision === null && next.currentSlotDigest === null
      && next.currentSlotGeneration === 0 && next.clarificationGeneration === 1
      && next.clarificationStatus === "OPEN"
      && sameIds(next.clarificationIds, [cause.clarificationId])
      && next.effectiveGateRef === null
      : cause.kind === "REVISION" && cause.clarificationId === null
        && cause.revisionRef !== null && sameProductContractV2WorkflowRef(
          next.currentRevision, cause.revisionRef,
        ) && next.currentSlotGeneration === 1 && next.clarificationGeneration === 0
        && next.clarificationStatus === "SATISFIED" && next.clarificationIds.length === 0
        && next.effectiveGateRef === null;
  }
  if (next.contractId !== previous.contractId || next.goalRef !== previous.goalRef
    || next.projectId !== previous.projectId) return false;
  if (cause.kind === "ASK") {
    if (cause.clarificationId === null
      || !sameStable(previous, next) || next.clarificationGeneration
        !== previous.clarificationGeneration + 1 || next.clarificationStatus !== "OPEN"
      || next.effectiveGateRef !== null
      || (previous.effectiveGateRef !== null && sameProductContractV2WorkflowRef(
        previous.currentRevision, cause.revisionRef,
      ))) return false;
    return sameIds(next.clarificationIds, [...previous.clarificationIds,
      cause.clarificationId].sort());
  }
  if (cause.kind === "ANSWER") {
    if (cause.clarificationId === null || cause.revisionRef !== null
      || !sameStable(previous, next) || next.clarificationGeneration
        !== previous.clarificationGeneration + 1
      || !sameProductContractV2WorkflowRef(next.effectiveGateRef,
        previous.effectiveGateRef)) return false;
    const ids = previous.clarificationIds.filter((id) => id !== cause.clarificationId);
    return ids.length !== previous.clarificationIds.length && sameIds(next.clarificationIds, ids)
      && (ids.length === 0
        ? next.clarificationStatus === "ANSWERED_PENDING"
          || next.clarificationStatus === "INVALID"
          || next.clarificationStatus === "SATISFIED"
        : next.clarificationStatus === "OPEN");
  }
  if (cause.kind === "REVISION") {
    return cause.clarificationId === null && cause.revisionRef !== null
      && (previous.clarificationStatus === "SATISFIED"
        || previous.clarificationStatus === "ANSWERED_PENDING")
      && sameProductContractV2WorkflowRef(next.currentRevision, cause.revisionRef)
      && next.currentSlotGeneration === previous.currentSlotGeneration + 1
      && next.clarificationGeneration === previous.clarificationGeneration
      && next.clarificationStatus === "SATISFIED" && next.clarificationIds.length === 0
      && next.effectiveGateRef === null;
  }
  return cause.kind === "GATE_1" && cause.clarificationId === null
    && cause.revisionRef !== null && sameStable(previous, next)
    && previous.clarificationStatus === "SATISFIED"
    && next.clarificationStatus === "SATISFIED"
    && next.clarificationGeneration === previous.clarificationGeneration
    && sameIds(next.clarificationIds, previous.clarificationIds)
    && previous.effectiveGateRef === null
    && sameProductContractV2WorkflowRef(next.currentRevision, cause.revisionRef)
    && sameProductContractV2WorkflowRef(next.effectiveGateRef, cause.revisionRef);
}
function expectedCommand(head: ProductContractV2WorkflowHead): Readonly<{
  commandId: string; commandKind: string;
}> {
  const cause = head.cause;
  const commandKind = cause.kind === "REVISION" ? PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND
    : cause.kind === "ASK" ? PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND
      : cause.kind === "ANSWER" ? PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND
        : PRODUCT_CONTRACT_GATE_1_COMMAND_KIND;
  return Object.freeze({ commandId: cause.commandId, commandKind });
}
function provenance(store: SqliteEventStore, event: StoredEvent,
  head: ProductContractV2WorkflowHead): boolean {
  const trace = event.decisionTrace;
  const primary = readProductContractV2WorkflowPrimary(store, head);
  const primaryTrace = primary?.decisionTrace;
  const expected = expectedCommand(head);
  if (trace === undefined || primary === null || primaryTrace === undefined
    || trace.commandId !== expected.commandId
    || trace.commandId !== head.cause.commandId || trace.commandKind !== expected.commandKind
    || trace.projectId !== head.projectId
    || primaryTrace.commandId !== trace.commandId
    || primaryTrace.commandKind !== trace.commandKind
    || primaryTrace.principalId !== trace.principalId
    || primaryTrace.projectId !== trace.projectId
    || primaryTrace.requestSha256 !== trace.requestSha256
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION) return false;
  const decision = store.getCommandDecision({ commandId: trace.commandId,
    principalId: trace.principalId, projectId: trace.projectId });
  const receipt = store.getCommandReceipt(event.commandId);
  const primaryReceipt = store.getCommandReceipt(primary.commandId);
  const agrees = decision !== null && decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.commandKind === expected.commandKind && decision.key.commandId === trace.commandId
    && decision.key.principalId === trace.principalId && decision.key.projectId === trace.projectId
    && decision.requestSha256 === trace.requestSha256
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.decidedAt === event.committedAt && receipt !== null
    && decision.decidedAt === primary.committedAt && primaryReceipt !== null
    && primaryReceipt.effectSha256 === decision.effectSha256
    && primaryReceipt.requestSha256 === primary.requestSha256
    && receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.aggregateId === event.aggregateId && receipt.commandId === event.commandId
    && receipt.previousVersion === event.aggregateSequence - 1
    && receipt.currentVersion === event.aggregateSequence
    && receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId
    && receipt.outboxMessageIds.length === 0 && receipt.committedAt === event.committedAt
    && receipt.requestSha256 === event.requestSha256;
  return agrees;
}
export interface ProductContractV2WorkflowReadInput {
  readonly contractId: string;
  readonly projectId: string;
  readonly requiredCause?: Readonly<{ commandId: string;
    clarificationId?: string; kind: ProductContractV2WorkflowHead["cause"]["kind"] }>;
}
function matchesRequired(head: ProductContractV2WorkflowHead,
  required: ProductContractV2WorkflowReadInput["requiredCause"]): boolean {
  return required !== undefined && head.cause.commandId === required.commandId
    && head.cause.kind === required.kind
    && (required.clarificationId === undefined
      || head.cause.clarificationId === required.clarificationId);
}
export function readProductContractV2WorkflowHead(store: SqliteEventStore,
  input: ProductContractV2WorkflowReadInput): ProductContractV2WorkflowRead {
  try {
    const aggregateId = deriveProductContractV2WorkflowAggregateId(
      input.projectId, input.contractId,
    );
    let cursor = 0; let latest: ProductContractV2WorkflowHead | undefined;
    let count = 0; let companionFound = false;
    for (;;) {
      const page = store.readAggregateEvents(aggregateId, cursor, 100);
      if (page.items.length > PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS - count) {
        return refused("PRODUCT_CONTRACT_V2_WORKFLOW_LIMIT_EXCEEDED");
      }
      if (page.items.length === 0 && count === 0) {
        return refused("PRODUCT_CONTRACT_V2_WORKFLOW_ABSENT");
      }
      for (const event of page.items) {
        count += 1;
        if (count > PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS) {
          return refused("PRODUCT_CONTRACT_V2_WORKFLOW_LIMIT_EXCEEDED");
        }
        const decoded = decodeProductContractV2WorkflowHead(event.payload);
        if (decoded === null || event.aggregateId !== aggregateId
          || event.aggregateSequence !== decoded.generation
          || event.domainSchemaVersion !== PRODUCT_CONTRACT_V2_WORKFLOW_VERSION
          || event.eventType !== PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE
          || event.eventId !== `${decoded.cause.commandId}-workflow`
          || decoded.projectId !== input.projectId || decoded.contractId !== input.contractId
          || !bytesEqual(event.payload, encodeProductContractV2WorkflowHead(decoded))
          || !transition(latest, decoded) || !provenance(store, event, decoded)) {
          return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID");
        }
        latest = decoded;
        companionFound ||= matchesRequired(decoded, input.requiredCause);
        cursor = event.aggregateSequence;
      }
      if (!page.hasMore) break;
      if (page.items.length === 0) return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID");
    }
    if (latest === undefined) return refused("PRODUCT_CONTRACT_V2_WORKFLOW_ABSENT");
    return Object.freeze({ companionFound, head: latest, ok: true as const });
  } catch (error) { return storeFailure(error); }
}
