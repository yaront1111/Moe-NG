import type {
  CapabilityCatalogRevision,
  DeliveryProfileQualification,
  DeliveryProfileRevision,
  ExecutionIsolationProfileRevision,
  VerificationRecipeRevision,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2AppendResult,
  type DeliveryV2Refusal,
} from "./contracts.js";
import {
  appendCapabilityCatalogRevision,
  appendDeliveryProfileQualification,
  appendDeliveryProfileRevision,
  appendExecutionIsolationProfileRevision,
  appendVerificationRecipeRevision,
} from "./material-persistence.js";
import { admitDeliveryV2MaterialPublisherPrincipalId } from
  "./material-publisher-admission.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

type Append<T> = (store: SqliteEventStore, context: DeliveryV2AppendContext,
  value: unknown) => DeliveryV2AppendResult<T>;
const refuse = (): DeliveryV2Refusal => Object.freeze({
  code: "DELIVERY_V2_INPUT_INVALID", layer: DELIVERY_V2_PERSISTENCE_LAYER, ok: false as const,
});

function createIngress<T>(store: SqliteEventStore, principalId: string, append: Append<T>) {
  const trustedPrincipalId = admitDeliveryV2MaterialPublisherPrincipalId(principalId);
  return Object.freeze((context: DeliveryV2AppendContext, value: unknown) => {
    const safeContext = snapshotDeliveryV2AppendContext(context);
    return trustedPrincipalId === undefined || safeContext?.principalId !== trustedPrincipalId
      ? refuse() : append(store, safeContext, value);
  });
}

export const createCapabilityCatalogRevisionIngress = (
  store: SqliteEventStore, principalId: string,
) => createIngress<CapabilityCatalogRevision>(store, principalId, appendCapabilityCatalogRevision);
export const createDeliveryProfileRevisionIngress = (
  store: SqliteEventStore, principalId: string,
) => createIngress<DeliveryProfileRevision>(store, principalId, appendDeliveryProfileRevision);
export const createDeliveryProfileQualificationIngress = (
  store: SqliteEventStore, principalId: string,
) => createIngress<DeliveryProfileQualification>(
  store, principalId, appendDeliveryProfileQualification,
);
export const createExecutionIsolationProfileRevisionIngress = (
  store: SqliteEventStore, principalId: string,
) => createIngress<ExecutionIsolationProfileRevision>(
  store, principalId, appendExecutionIsolationProfileRevision,
);
export const createVerificationRecipeRevisionIngress = (
  store: SqliteEventStore, principalId: string,
) => createIngress<VerificationRecipeRevision>(
  store, principalId, appendVerificationRecipeRevision,
);
