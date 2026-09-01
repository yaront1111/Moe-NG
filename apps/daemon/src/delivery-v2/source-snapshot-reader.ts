import {
  SOURCE_SNAPSHOT_VERSION,
  admitSourceSnapshotRef,
  decodeSourceSnapshotBytes,
  type SourceSnapshot,
  type SourceSnapshotRef,
  type SourceSnapshotRefusal,
} from "@moe/core";
import { DurableStoreError, type SqliteEventStore } from "@moe/store";

import {
  DELIVERY_V2_READER_LAYER,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { admitDeliveryV2MaterialPublisherPrincipalId } from
  "./material-publisher-admission.js";
import {
  DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
  DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
  deriveDeliveryV2SourceSnapshotAggregateId,
  deriveDeliveryV2SourceSnapshotEventId,
} from "./source-snapshot-persistence.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";

export interface DeliveryV2SourceSnapshotReadAccepted {
  readonly ok: true;
  readonly snapshot: SourceSnapshot;
}

export type DeliveryV2SourceSnapshotReadResult =
  | DeliveryV2SourceSnapshotReadAccepted
  | DeliveryV2Refusal
  | SourceSnapshotRefusal;

const refuse = (
  code: DeliveryV2Refusal["code"],
  layer: DeliveryV2Refusal["layer"] = DELIVERY_V2_READER_LAYER,
): DeliveryV2Refusal => Object.freeze({ code, layer, ok: false as const });

const storageRefusal = (error: unknown): DeliveryV2Refusal => error instanceof DurableStoreError
  ? refuse(error.code, "DURABLE_STORE")
  : refuse("STORAGE_DEGRADED");

/** Reads one immutable SourceSnapshot by content address; it does not attest Git provenance. */
export function readDeliveryV2SourceSnapshot(
  store: SqliteEventStore,
  ref: SourceSnapshotRef,
  expectedPrincipalId: string,
): DeliveryV2SourceSnapshotReadResult {
  const admitted = admitSourceSnapshotRef(ref);
  if (!admitted.ok) return admitted;
  const principalId = admitDeliveryV2MaterialPublisherPrincipalId(expectedPrincipalId);
  if (principalId === undefined || !principalId.isWellFormed() || principalId.includes("\0")) {
    return refuse("DELIVERY_V2_INPUT_INVALID");
  }

  const { projectId, sourceSnapshotDigest } = admitted.ref;
  const aggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
    projectId, sourceSnapshotDigest,
  );
  let page;
  try {
    page = store.readAggregateEvents(aggregateId, 0, 2);
  } catch (error) {
    return storageRefusal(error);
  }
  if (page.items.length === 0 && !page.hasMore) {
    return refuse("DELIVERY_V2_MATERIAL_ABSENT");
  }
  const event = page.items[0];
  if (page.hasMore || page.items.length !== 1 || event === undefined
    || event.aggregateId !== aggregateId || event.aggregateSequence !== 1
    || event.domainSchemaVersion !== SOURCE_SNAPSHOT_VERSION
    || event.eventType !== DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE
    || event.decisionTrace === undefined) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (event.decisionTrace.projectId !== projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  if (event.decisionTrace.commandKind !== DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND
    || event.decisionTrace.principalId !== principalId) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  const eventId = deriveDeliveryV2SourceSnapshotEventId(
    projectId, principalId, event.decisionTrace.commandId,
  );
  if (event.eventId !== eventId) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

  const payloadBytes = new Uint8Array(event.payload);
  const decoded = decodeSourceSnapshotBytes(payloadBytes);
  if (!decoded.ok) return decoded;
  if (decoded.snapshot.projectId !== projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  if (decoded.snapshot.sourceSnapshotDigest !== sourceSnapshotDigest) {
    return refuse("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH");
  }

  let decision;
  let receipt;
  try {
    decision = store.getCommandDecision({
      commandId: event.decisionTrace.commandId,
      principalId: event.decisionTrace.principalId,
      projectId: event.decisionTrace.projectId,
    });
    receipt = store.getCommandReceipt(event.commandId);
  } catch (error) {
    return storageRefusal(error);
  }
  const capturedProvenanceStore = Object.freeze({
    getCommandDecision: () => decision,
    getCommandReceipt: () => receipt,
  }) as unknown as SqliteEventStore;
  if (!validateDeliveryV2EventProvenance(capturedProvenanceStore, event, {
    aggregateId,
    commandKind: DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
    domainSchemaVersion: SOURCE_SNAPSHOT_VERSION,
    eventId,
    eventType: DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
    expectedPrincipalId: principalId,
    expectedProjectId: projectId,
    expectedVersion: 0,
    payloadBytes,
    requestBytes: payloadBytes,
    resultBytes: payloadBytes,
  })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

  return Object.freeze({ ok: true as const, snapshot: decoded.snapshot });
}
