import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

import { PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND } from "./product-contract-v2-address.js";
import { PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND }
  from "./product-contract-v2-clarification-contract.js";
import {
  PRODUCT_CONTRACT_V2_GOAL_BINDING_EVENT_TYPE,
  PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER,
  PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION,
  decodeProductContractV2GoalBinding,
  deriveProductContractV2ContractBindingAggregateId,
  deriveProductContractV2GoalBindingAggregateId,
  encodeProductContractV2GoalBinding,
  sameProductContractV2GoalBindingBytes,
  type ProductContractV2GoalBinding,
  type ProductContractV2GoalBindingCode,
} from "./product-contract-v2-goal-binding-contract.js";

export type ProductContractV2GoalBindingRead =
  | Readonly<{ binding: ProductContractV2GoalBinding; ok: true }>
  | Readonly<{ code: ProductContractV2GoalBindingCode | "STORAGE_DEGRADED" | string;
    layer: "DURABLE_STORE" | typeof PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER; ok: false }>;

function refused(code: ProductContractV2GoalBindingCode): ProductContractV2GoalBindingRead {
  return Object.freeze({ code, layer: PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER, ok: false });
}
function storeFailure(error: unknown): ProductContractV2GoalBindingRead {
  return Object.freeze({ code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    layer: error instanceof DurableStoreError ? "DURABLE_STORE" as const
      : PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER, ok: false });
}
function expectedCommand(binding: ProductContractV2GoalBinding): Readonly<{
  commandId: string; commandKind: string;
}> {
  return binding.cause.kind === "REVISION"
    ? Object.freeze({ commandId: binding.cause.commandId,
      commandKind: PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND })
    : Object.freeze({ commandId: binding.cause.commandId,
      commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND });
}
function exactEvent(
  event: StoredEvent | undefined, aggregateId: string, eventId: string, bytes: Uint8Array,
): event is StoredEvent {
  return event !== undefined && event.aggregateId === aggregateId && event.aggregateSequence === 1
    && event.domainSchemaVersion === PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION
    && event.eventId === eventId && event.eventType === PRODUCT_CONTRACT_V2_GOAL_BINDING_EVENT_TYPE
    && sameProductContractV2GoalBindingBytes(event.payload, bytes);
}
function sameTrace(left: StoredEvent, right: StoredEvent): boolean {
  const a = left.decisionTrace; const b = right.decisionTrace;
  return a !== undefined && b !== undefined && a.commandId === b.commandId
    && a.commandKind === b.commandKind && a.principalId === b.principalId
    && a.projectId === b.projectId && a.requestSha256 === b.requestSha256
    && a.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && b.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION;
}
function receiptAgrees(
  store: SqliteEventStore, event: StoredEvent,
): boolean {
  const receipt = store.getCommandReceipt(event.commandId);
  return receipt !== null && receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.commandId === event.commandId && receipt.aggregateId === event.aggregateId
    && receipt.previousVersion === 0 && receipt.currentVersion === 1
    && receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId
    && receipt.outboxMessageIds.length === 0 && receipt.committedAt === event.committedAt
    && receipt.requestSha256 === event.requestSha256;
}
function provenanceAgrees(
  store: SqliteEventStore, binding: ProductContractV2GoalBinding,
  goalEvent: StoredEvent, contractEvent: StoredEvent,
): boolean {
  const expected = expectedCommand(binding);
  const trace = goalEvent.decisionTrace;
  if (!sameTrace(goalEvent, contractEvent) || trace === undefined
    || trace.commandId !== expected.commandId || trace.commandKind !== expected.commandKind
    || trace.projectId !== binding.projectId) return false;
  const decision = store.getCommandDecision({ commandId: expected.commandId,
    principalId: trace.principalId, projectId: binding.projectId });
  return decision !== null && decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.resultCode === "EFFECTS_COMMITTED" && decision.commandKind === expected.commandKind
    && decision.key.commandId === expected.commandId && decision.key.principalId === trace.principalId
    && decision.key.projectId === binding.projectId
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.requestSha256 === trace.requestSha256
    && decision.decidedAt === goalEvent.committedAt
    && decision.decidedAt === contractEvent.committedAt
    && receiptAgrees(store, goalEvent)
    && receiptAgrees(store, contractEvent);
}

function readPair(
  store: SqliteEventStore, goalAggregateId: string, contractAggregateId: string,
): readonly [StoredEvent | undefined, StoredEvent | undefined] | null {
  const goal = store.readAggregateEvents(goalAggregateId, 0, 2);
  const contract = store.readAggregateEvents(contractAggregateId, 0, 2);
  return goal.hasMore || contract.hasMore || goal.items.length > 1 || contract.items.length > 1
    ? null : [goal.items[0], contract.items[0]];
}

function admitPair(
  store: SqliteEventStore, binding: ProductContractV2GoalBinding,
  goalEvent: StoredEvent | undefined, contractEvent: StoredEvent | undefined,
): ProductContractV2GoalBindingRead {
  const bytes = encodeProductContractV2GoalBinding(binding);
  const expected = expectedCommand(binding);
  const goalId = deriveProductContractV2GoalBindingAggregateId(binding.projectId, binding.goalRef);
  const contractId = deriveProductContractV2ContractBindingAggregateId(
    binding.projectId, binding.contractId,
  );
  if (!exactEvent(goalEvent, goalId, `${expected.commandId}-goal-binding`, bytes)
    || !exactEvent(contractEvent, contractId, `${expected.commandId}-contract-binding`, bytes)
    || !provenanceAgrees(store, binding, goalEvent, contractEvent)) {
    return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID");
  }
  return Object.freeze({ binding, ok: true as const });
}

export function readProductContractV2GoalBinding(
  store: SqliteEventStore, input: Readonly<{ goalRef: string; projectId: string }>,
): ProductContractV2GoalBindingRead {
  try {
    const goalId = deriveProductContractV2GoalBindingAggregateId(input.projectId, input.goalRef);
    const goal = store.readAggregateEvents(goalId, 0, 2);
    if (!goal.hasMore && goal.items.length === 0) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT");
    }
    if (goal.hasMore || goal.items.length !== 1) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID");
    }
    const binding = decodeProductContractV2GoalBinding(goal.items[0]!.payload);
    if (binding === null || binding.projectId !== input.projectId || binding.goalRef !== input.goalRef) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID");
    }
    const contractId = deriveProductContractV2ContractBindingAggregateId(
      input.projectId, binding.contractId,
    );
    const pair = readPair(store, goalId, contractId);
    return pair === null ? refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID")
      : admitPair(store, binding, pair[0], pair[1]);
  } catch (error) { return storeFailure(error); }
}

export function readProductContractV2ContractBinding(
  store: SqliteEventStore, input: Readonly<{ contractId: string; projectId: string }>,
): ProductContractV2GoalBindingRead {
  try {
    const contractId = deriveProductContractV2ContractBindingAggregateId(
      input.projectId, input.contractId,
    );
    const contract = store.readAggregateEvents(contractId, 0, 2);
    if (!contract.hasMore && contract.items.length === 0) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT");
    }
    if (contract.hasMore || contract.items.length !== 1) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID");
    }
    const binding = decodeProductContractV2GoalBinding(contract.items[0]!.payload);
    if (binding === null || binding.projectId !== input.projectId
      || binding.contractId !== input.contractId) {
      return refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID");
    }
    const goalId = deriveProductContractV2GoalBindingAggregateId(input.projectId, binding.goalRef);
    const pair = readPair(store, goalId, contractId);
    return pair === null ? refused("PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID")
      : admitPair(store, binding, pair[0], pair[1]);
  } catch (error) { return storeFailure(error); }
}
