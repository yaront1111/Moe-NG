import type { DeliveryProfileQualificationStatusBinding } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { deriveDeliveryV2AuthorityAggregateId } from "./addresses.js";
import {
  admitDeliveryV2AuthorityPrincipalBindings,
  admitDeliveryV2ProjectId,
  admitDeliveryV2QualificationStatusBinding,
} from "./authority-admission.js";
import {
  DELIVERY_V2_AUTHORITY_COMMAND_KINDS,
  DELIVERY_V2_AUTHORITY_EVENT_TYPES,
} from "./authority-events.js";
import {
  DELIVERY_V2_QUALIFICATION_STATUS_VERSION,
  decodeDeliveryV2QualificationStatusRecord,
  encodeDeliveryV2QualificationStatusRecord,
  type DeliveryV2QualificationStatusRecord,
} from "./authority-records.js";
import type {
  DeliveryV2AuthorityPrincipalBindings,
  DeliveryV2QualificationStatusFence,
} from "./contracts.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";

function readStatusHistory(store: SqliteEventStore, projectId: string,
  binding: DeliveryProfileQualificationStatusBinding, expectedPrincipalId: string) {
  const aggregateId = deriveDeliveryV2AuthorityAggregateId(
    projectId, "QUALIFICATION_STATUS", binding.qualificationId,
  );
  try {
    const page = store.readAggregateEvents(aggregateId, 0, 3);
    if (page.hasMore || page.items.length === 0 || page.items.length > 2) return undefined;
    const records = page.items.map((event, index) => {
      if (event.aggregateSequence !== index + 1 || event.aggregateId !== aggregateId
        || event.decisionTrace === undefined
        || event.eventId !== `${event.decisionTrace.commandId}:delivery-v2-authority`
        || event.eventType !== DELIVERY_V2_AUTHORITY_EVENT_TYPES.QUALIFICATION_STATUS
        || event.domainSchemaVersion !== DELIVERY_V2_QUALIFICATION_STATUS_VERSION
        || event.decisionTrace.projectId !== projectId
        || event.decisionTrace.commandKind
          !== DELIVERY_V2_AUTHORITY_COMMAND_KINDS.QUALIFICATION_STATUS) return undefined;
      const record = decodeDeliveryV2QualificationStatusRecord(event.payload);
      const bytes = record === undefined
        ? undefined : encodeDeliveryV2QualificationStatusRecord(record);
      return record?.projectId === projectId && bytes !== undefined
        && record.qualificationId === binding.qualificationId
        && record.qualificationDigest === binding.qualificationDigest
        && validateDeliveryV2EventProvenance(store, event, {
          aggregateId,
          commandKind: DELIVERY_V2_AUTHORITY_COMMAND_KINDS.QUALIFICATION_STATUS,
          domainSchemaVersion: DELIVERY_V2_QUALIFICATION_STATUS_VERSION,
          eventId: `${event.decisionTrace.commandId}:delivery-v2-authority`,
          eventType: DELIVERY_V2_AUTHORITY_EVENT_TYPES.QUALIFICATION_STATUS,
          expectedPrincipalId,
          expectedProjectId: projectId,
          expectedVersion: index,
          payloadBytes: bytes,
          requestBytes: bytes,
          resultBytes: bytes,
        }) ? record : undefined;
    });
    if (records.some((record) => record === undefined) || records[0]?.status !== "CURRENT"
      || (records.length === 2 && records[1]?.status !== "REVOKED")) return undefined;
    return Object.freeze(records as DeliveryV2QualificationStatusRecord[]);
  } catch { return undefined; }
}

export function readDeliveryV2QualificationStatus(store: SqliteEventStore, projectId: string,
  binding: DeliveryProfileQualificationStatusBinding, expectedPrincipalId: string) {
  const records = readStatusHistory(store, projectId, binding, expectedPrincipalId);
  if (records === undefined) return undefined;
  const current = records.at(-1)!;
  return Object.freeze({ qualificationDigest: current.qualificationDigest,
    qualificationId: current.qualificationId, status: current.status,
    statusDigest: current.statusDigest, statusRef: current.statusRef });
}

/** Returns the exact no-event expected-version leg a planner must commit atomically. */
export function readDeliveryProfileQualificationStatusFence(
  store: SqliteEventStore, projectId: string, binding: DeliveryProfileQualificationStatusBinding,
  principals: DeliveryV2AuthorityPrincipalBindings,
): DeliveryV2QualificationStatusFence | undefined {
  const safeProjectId = admitDeliveryV2ProjectId(projectId);
  const safeBinding = admitDeliveryV2QualificationStatusBinding(binding);
  const safePrincipals = admitDeliveryV2AuthorityPrincipalBindings(principals);
  if (safeProjectId === undefined || safeBinding === undefined || safePrincipals === undefined) {
    return undefined;
  }
  const records = readStatusHistory(
    store, safeProjectId, safeBinding, safePrincipals.qualificationStatusPrincipalId,
  );
  if (records === undefined || records.length !== 1 || records[0]?.status !== "CURRENT") {
    return undefined;
  }
  const current = records[0];
  return Object.freeze({
    aggregateId: deriveDeliveryV2AuthorityAggregateId(
      safeProjectId, "QUALIFICATION_STATUS", safeBinding.qualificationId,
    ),
    expectedVersion: 1,
    qualificationDigest: current.qualificationDigest,
    qualificationId: current.qualificationId,
    statusDigest: current.statusDigest,
    statusRef: current.statusRef,
  });
}
