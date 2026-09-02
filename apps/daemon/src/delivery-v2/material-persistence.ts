import { DurableStoreError, type SqliteEventStore } from "@moe/store";
import type {
  CapabilityCatalogRevision,
  DeliveryProfileQualification,
  DeliveryProfileRevision,
  ExecutionIsolationProfileRevision,
  VerificationRecipeRevision,
} from "@moe/core";

import {
  DELIVERY_V2_MATERIAL_COMMAND_KINDS,
  DELIVERY_V2_MATERIAL_EVENT_TYPES,
  deriveDeliveryV2MaterialAggregateId,
  type DeliveryV2MaterialKind,
} from "./addresses.js";
import {
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2AppendResult,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { encodeDeliveryV2Material } from "./material-codecs.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

const refusal = (code: DeliveryV2Refusal["code"], layer: DeliveryV2Refusal["layer"] =
DELIVERY_V2_PERSISTENCE_LAYER): DeliveryV2Refusal =>
  Object.freeze({ code, layer, ok: false as const });

function validContext(value: DeliveryV2AppendContext): boolean {
  return value !== null && typeof value === "object"
    && [value.commandId, value.correlationId, value.decidedAt,
      value.principalId, value.projectId].every((item) => typeof item === "string" && item !== "")
    && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion >= 0
    && !Object.is(value.expectedVersion, -0);
}

function appendImmutable<T>(
  store: SqliteEventStore,
  kind: DeliveryV2MaterialKind,
  context: DeliveryV2AppendContext,
  value: unknown,
): DeliveryV2AppendResult<T> {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  if (safeContext === undefined || !validContext(safeContext) || safeContext.expectedVersion !== 0) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const material = encodeDeliveryV2Material(kind, value);
  if (material === undefined) return refusal("DELIVERY_V2_MATERIAL_INVALID");
  const aggregateId = deriveDeliveryV2MaterialAggregateId(
    safeContext.projectId, kind, material.identity.digest,
  );
  try {
    const result = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_MATERIAL_COMMAND_KINDS[kind],
      committedResultBytes: material.bytes,
      correlationId: safeContext.correlationId,
      decidedAt: safeContext.decidedAt,
      key: { commandId: safeContext.commandId, principalId: safeContext.principalId,
        projectId: safeContext.projectId },
      legs: [{
        aggregateId,
        events: [{
          domainSchemaVersion: material.domainSchemaVersion,
          eventId: `${safeContext.commandId}:delivery-v2-material`,
          eventType: DELIVERY_V2_MATERIAL_EVENT_TYPES[kind],
          payload: material.bytes,
        }],
        expectedVersion: 0,
      }],
      requestBytes: material.bytes,
    });
    if (!validateDeliveryV2DecisionDisposition(result)) {
      return refusal("DELIVERY_V2_MATERIAL_UNREADABLE");
    }
    if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refusal(result.decision.resultCode as DeliveryV2Refusal["code"], "DURABLE_STORE");
    }
    const event = store.readAggregateEvents(aggregateId, 0, 1).items[0];
    if (event === undefined || !validateDeliveryV2EventProvenance(store, event, {
      aggregateId,
      commandKind: DELIVERY_V2_MATERIAL_COMMAND_KINDS[kind],
      domainSchemaVersion: material.domainSchemaVersion,
      eventId: `${safeContext.commandId}:delivery-v2-material`,
      eventType: DELIVERY_V2_MATERIAL_EVENT_TYPES[kind],
      expectedCommandId: safeContext.commandId,
      expectedPrincipalId: safeContext.principalId,
      expectedProjectId: safeContext.projectId,
      expectedVersion: 0,
      payloadBytes: material.bytes,
      requestBytes: material.bytes,
      resultBytes: material.bytes,
    })) return refusal("DELIVERY_V2_MATERIAL_UNREADABLE");
    return Object.freeze({ disposition: result.disposition, ok: true as const,
      value: material.value as T });
  } catch (error) {
    return refusal(error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER);
  }
}

export const appendCapabilityCatalogRevision = (
  store: SqliteEventStore, context: DeliveryV2AppendContext, value: unknown,
): DeliveryV2AppendResult<CapabilityCatalogRevision> =>
  appendImmutable(store, "CAPABILITY_CATALOG", context, value);

export const appendDeliveryProfileRevision = (
  store: SqliteEventStore, context: DeliveryV2AppendContext, value: unknown,
): DeliveryV2AppendResult<DeliveryProfileRevision> =>
  appendImmutable(store, "DELIVERY_PROFILE", context, value);

export const appendDeliveryProfileQualification = (
  store: SqliteEventStore, context: DeliveryV2AppendContext, value: unknown,
): DeliveryV2AppendResult<DeliveryProfileQualification> =>
  appendImmutable(store, "DELIVERY_PROFILE_QUALIFICATION", context, value);

export const appendExecutionIsolationProfileRevision = (
  store: SqliteEventStore, context: DeliveryV2AppendContext, value: unknown,
): DeliveryV2AppendResult<ExecutionIsolationProfileRevision> =>
  appendImmutable(store, "EXECUTION_ISOLATION_PROFILE", context, value);

export const appendVerificationRecipeRevision = (
  store: SqliteEventStore, context: DeliveryV2AppendContext, value: unknown,
): DeliveryV2AppendResult<VerificationRecipeRevision> =>
  appendImmutable(store, "VERIFICATION_RECIPE", context, value);
