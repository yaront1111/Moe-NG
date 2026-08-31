import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  PRODUCT_CONTRACT_V2_GOAL_BINDING_EVENT_TYPE,
  PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER,
  PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION,
  deriveProductContractV2ContractBindingAggregateId,
  deriveProductContractV2GoalBindingAggregateId,
  encodeProductContractV2GoalBinding,
  type ProductContractV2GoalBinding,
  type ProductContractV2GoalBindingCause,
} from "./product-contract-v2-goal-binding-contract.js";
import { readProductContractV2ContractBinding, readProductContractV2GoalBinding }
  from "./product-contract-v2-goal-binding-reader.js";

export type ProductContractV2GoalBindingLegs = Readonly<{
  binding: ProductContractV2GoalBinding;
  legs: readonly ExpectedVersionDecisionLeg[];
  ok: true;
}> | Readonly<{
  code: string; layer: string; ok: false;
}>;

const mismatch = (): ProductContractV2GoalBindingLegs => Object.freeze({
  code: "PRODUCT_CONTRACT_V2_GOAL_BINDING_MISMATCH",
  layer: PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER,
  ok: false as const,
});

export function prepareProductContractV2GoalBindingLegs(
  store: SqliteEventStore,
  input: Readonly<{ cause: ProductContractV2GoalBindingCause; commandId: string;
    contractId: string; goalRef: string; projectId: string }>,
): ProductContractV2GoalBindingLegs {
  if (input.cause.commandId !== input.commandId) return mismatch();
  const byGoal = readProductContractV2GoalBinding(store, {
    goalRef: input.goalRef, projectId: input.projectId,
  });
  const byContract = readProductContractV2ContractBinding(store, {
    contractId: input.contractId, projectId: input.projectId,
  });
  const goalAbsent = !byGoal.ok && byGoal.code === "PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT";
  const contractAbsent = !byContract.ok
    && byContract.code === "PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT";
  if (goalAbsent !== contractAbsent) return mismatch();
  if (!goalAbsent) {
    if (!byGoal.ok) return Object.freeze({ code: byGoal.code, layer: byGoal.layer,
      ok: false as const });
    if (!byContract.ok) return Object.freeze({ code: byContract.code,
      layer: byContract.layer, ok: false as const });
    if (byGoal.binding.contractId !== input.contractId
      || byContract.binding.goalRef !== input.goalRef
      || byGoal.binding.goalRef !== byContract.binding.goalRef
      || byGoal.binding.contractId !== byContract.binding.contractId) return mismatch();
    return Object.freeze({ binding: byGoal.binding, legs: Object.freeze([Object.freeze({
      aggregateId: deriveProductContractV2GoalBindingAggregateId(input.projectId, input.goalRef),
      events: Object.freeze([]), expectedVersion: 1,
    }), Object.freeze({ aggregateId: deriveProductContractV2ContractBindingAggregateId(
      input.projectId, input.contractId,
    ), events: Object.freeze([]), expectedVersion: 1 })]), ok: true as const });
  }
  const binding: ProductContractV2GoalBinding = Object.freeze({ cause: input.cause,
    contractId: input.contractId, goalRef: input.goalRef, projectId: input.projectId,
    schemaVersion: PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION });
  const bytes = encodeProductContractV2GoalBinding(binding);
  const event = (suffix: "contract-binding" | "goal-binding") => Object.freeze({
    domainSchemaVersion: PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION,
    eventId: `${input.commandId}-${suffix}`,
    eventType: PRODUCT_CONTRACT_V2_GOAL_BINDING_EVENT_TYPE,
    payload: bytes,
  });
  return Object.freeze({ binding, legs: Object.freeze([Object.freeze({
    aggregateId: deriveProductContractV2GoalBindingAggregateId(input.projectId, input.goalRef),
    events: Object.freeze([event("goal-binding")]), expectedVersion: 0,
  }), Object.freeze({ aggregateId: deriveProductContractV2ContractBindingAggregateId(
    input.projectId, input.contractId,
  ), events: Object.freeze([event("contract-binding")]), expectedVersion: 0 })]), ok: true as const });
}
