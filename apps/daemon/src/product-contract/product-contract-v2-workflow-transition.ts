import type { ProductContractClarificationV2SharedIdentity,
  ProductContractRevisionV2Ref } from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE,
  PRODUCT_CONTRACT_V2_WORKFLOW_LAYER,
  PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS,
  PRODUCT_CONTRACT_V2_WORKFLOW_VERSION,
  deriveProductContractV2WorkflowAggregateId,
  encodeProductContractV2WorkflowHead,
  productContractV2WorkflowHeadWithinLimits,
  sameProductContractV2WorkflowRef,
  type ProductContractV2WorkflowCause,
  type ProductContractV2WorkflowHead,
} from "./product-contract-v2-workflow-contract.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";

type Accepted = Readonly<{ readonly head: ProductContractV2WorkflowHead;
  readonly leg: ExpectedVersionDecisionLeg; readonly ok: true }>;
type Refused = Readonly<{ readonly code: string; readonly layer: string; readonly ok: false }>;
export type ProductContractV2WorkflowTransition = Accepted | Refused;
export interface ProductContractV2AskWorkflowInput {
  readonly clarificationId: string;
  readonly commandId: string;
  readonly goalRef: string;
  readonly identity: ProductContractClarificationV2SharedIdentity;
  readonly projectId: string;
}

const refused = (code: string): Refused => Object.freeze({
  code, layer: PRODUCT_CONTRACT_V2_WORKFLOW_LAYER, ok: false as const,
});
function bindingMatches(head: ProductContractV2WorkflowHead,
  input: Readonly<{ contractId: string; goalRef: string; projectId: string }>): boolean {
  return head.contractId === input.contractId && head.goalRef === input.goalRef
    && head.projectId === input.projectId;
}
function accepted(head: ProductContractV2WorkflowHead): ProductContractV2WorkflowTransition {
  if (head.generation > PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS
    || !productContractV2WorkflowHeadWithinLimits(head)) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_LIMIT_EXCEEDED");
  }
  const bytes = encodeProductContractV2WorkflowHead(head);
  return Object.freeze({ head, leg: Object.freeze({ aggregateId:
    deriveProductContractV2WorkflowAggregateId(head.projectId, head.contractId),
  events: Object.freeze([{ domainSchemaVersion: PRODUCT_CONTRACT_V2_WORKFLOW_VERSION,
    eventId: `${head.cause.commandId}-workflow`,
    eventType: PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE, payload: bytes }]),
  expectedVersion: head.generation - 1 }), ok: true as const });
}
function head(input: Readonly<{
  cause: ProductContractV2WorkflowCause;
  clarificationGeneration: number;
  clarificationIds: readonly string[];
  clarificationStatus: ProductContractV2WorkflowHead["clarificationStatus"];
  contractId: string;
  currentRevision: ProductContractRevisionV2Ref | null;
  currentSlotDigest: string | null;
  currentSlotGeneration: number;
  effectiveGateRef: ProductContractRevisionV2Ref | null;
  generation: number;
  goalRef: string;
  projectId: string;
}>): ProductContractV2WorkflowHead {
  return Object.freeze({ cause: input.cause,
    clarificationGeneration: input.clarificationGeneration,
    clarificationIds: Object.freeze([...input.clarificationIds].sort()),
    clarificationStatus: input.clarificationStatus, contractId: input.contractId,
    currentRevision: input.currentRevision, currentSlotDigest: input.currentSlotDigest,
    currentSlotGeneration: input.currentSlotGeneration,
    effectiveGateRef: input.effectiveGateRef, generation: input.generation,
    goalRef: input.goalRef, projectId: input.projectId,
    schemaVersion: PRODUCT_CONTRACT_V2_WORKFLOW_VERSION });
}
function read(store: SqliteEventStore, input: Readonly<{ contractId: string;
  projectId: string }>): ReturnType<typeof readProductContractV2WorkflowHead> {
  return readProductContractV2WorkflowHead(store, input);
}
export function prepareProductContractV2RevisionWorkflow(
  store: SqliteEventStore,
  input: Readonly<{ commandId: string; contractId: string; goalRef: string;
    projectId: string; ref: ProductContractRevisionV2Ref; slotDigest: string;
    slotGeneration: number }>,
): ProductContractV2WorkflowTransition {
  const prior = read(store, input);
  if (!prior.ok && prior.code !== "PRODUCT_CONTRACT_V2_WORKFLOW_ABSENT") return prior;
  if (prior.ok && !bindingMatches(prior.head, input)) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_BINDING_MISMATCH");
  }
  if (prior.ok && prior.head.clarificationStatus !== "SATISFIED"
    && prior.head.clarificationStatus !== "ANSWERED_PENDING") {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_OPEN");
  }
  const previous = prior.ok ? prior.head : null;
  if (input.slotGeneration !== (previous?.currentSlotGeneration ?? 0) + 1) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH");
  }
  return accepted(head({ cause: Object.freeze({ clarificationId: null,
    commandId: input.commandId, kind: "REVISION", revisionRef: input.ref }),
  clarificationGeneration: previous?.clarificationGeneration ?? 0,
  clarificationIds: Object.freeze([]), clarificationStatus: "SATISFIED",
  contractId: input.contractId, currentRevision: input.ref,
  currentSlotDigest: input.slotDigest, currentSlotGeneration: input.slotGeneration,
  effectiveGateRef: null, generation: (previous?.generation ?? 0) + 1,
  goalRef: input.goalRef, projectId: input.projectId }));
}
export function prepareProductContractV2AskWorkflow(
  store: SqliteEventStore,
  input: ProductContractV2AskWorkflowInput,
): ProductContractV2WorkflowTransition {
  const contractId = input.identity.contractId;
  const prior = read(store, { contractId, projectId: input.projectId });
  if (!prior.ok && prior.code !== "PRODUCT_CONTRACT_V2_WORKFLOW_ABSENT") return prior;
  return advanceProductContractV2AskWorkflow(prior.ok ? prior.head : null, input);
}
export function advanceProductContractV2AskWorkflow(
  previous: ProductContractV2WorkflowHead | null,
  input: ProductContractV2AskWorkflowInput,
): ProductContractV2WorkflowTransition {
  const contractId = input.identity.contractId;
  if (previous === null && input.identity.lineage !== null) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH");
  }
  if (previous !== null && !bindingMatches(previous, { contractId,
    goalRef: input.goalRef, projectId: input.projectId })) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_BINDING_MISMATCH");
  }
  const candidateRef = previous?.currentRevision?.revisionId === input.identity.revisionId
    ? previous.currentRevision : null;
  if (previous?.effectiveGateRef !== null && previous?.effectiveGateRef !== undefined
    && candidateRef !== null) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_GATE_1_ALREADY_APPROVED");
  }
  if (previous?.clarificationIds.includes(input.clarificationId)) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID");
  }
  return accepted(head({ cause: Object.freeze({ clarificationId: input.clarificationId,
    commandId: input.commandId, kind: "ASK", revisionRef: candidateRef }),
  clarificationGeneration: (previous?.clarificationGeneration ?? 0) + 1,
  clarificationIds: Object.freeze([...(previous?.clarificationIds ?? []), input.clarificationId]),
  clarificationStatus: "OPEN", contractId,
  currentRevision: previous?.currentRevision ?? null,
  currentSlotDigest: previous?.currentSlotDigest ?? null,
  currentSlotGeneration: previous?.currentSlotGeneration ?? 0,
  effectiveGateRef: null, generation: (previous?.generation ?? 0) + 1,
  goalRef: input.goalRef, projectId: input.projectId }));
}
export function prepareProductContractV2AnswerWorkflow(
  store: SqliteEventStore,
  input: Readonly<{ clarificationId: string; commandId: string; contractId: string;
    clarificationStatus: "ANSWERED_PENDING" | "INVALID" | "OPEN" | "SATISFIED";
    goalRef: string; projectId: string }>,
): ProductContractV2WorkflowTransition {
  const prior = read(store, input);
  if (!prior.ok) return prior;
  if (!bindingMatches(prior.head, input)
    || !prior.head.clarificationIds.includes(input.clarificationId)
    || prior.head.clarificationStatus !== "OPEN") {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_UNSATISFIED");
  }
  const ids = prior.head.clarificationIds.filter((id) => id !== input.clarificationId);
  if ((ids.length > 0 && input.clarificationStatus !== "OPEN")
    || (ids.length === 0 && input.clarificationStatus === "OPEN")) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_UNSATISFIED");
  }
  return accepted(head({ cause: Object.freeze({ clarificationId: input.clarificationId,
    commandId: input.commandId, kind: "ANSWER", revisionRef: null }),
  clarificationGeneration: prior.head.clarificationGeneration + 1,
  clarificationIds: ids,
  clarificationStatus: input.clarificationStatus,
  contractId: input.contractId, currentRevision: prior.head.currentRevision,
  currentSlotDigest: prior.head.currentSlotDigest,
  currentSlotGeneration: prior.head.currentSlotGeneration,
  effectiveGateRef: prior.head.effectiveGateRef, generation: prior.head.generation + 1,
  goalRef: input.goalRef, projectId: input.projectId }));
}
export function prepareProductContractV2GateWorkflow(
  store: SqliteEventStore,
  input: Readonly<{ commandId: string; contractId: string; projectId: string;
    ref: ProductContractRevisionV2Ref }>,
): ProductContractV2WorkflowTransition {
  const prior = read(store, input);
  if (!prior.ok) return prior;
  if (!sameProductContractV2WorkflowRef(prior.head.currentRevision, input.ref)) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH");
  }
  if (prior.head.clarificationStatus !== "SATISFIED") {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_UNSATISFIED");
  }
  if (prior.head.effectiveGateRef !== null) {
    return refused("PRODUCT_CONTRACT_V2_WORKFLOW_GATE_1_ALREADY_APPROVED");
  }
  return accepted(head({ ...prior.head, cause: Object.freeze({ clarificationId: null,
    commandId: input.commandId, kind: "GATE_1", revisionRef: input.ref }),
  effectiveGateRef: input.ref, generation: prior.head.generation + 1 }));
}
