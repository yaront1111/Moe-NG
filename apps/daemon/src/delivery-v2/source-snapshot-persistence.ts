import {
  SOURCE_SNAPSHOT_VERSION,
  createSourceSnapshot,
  deriveSourceSnapshotDigest,
  encodeSourceSnapshot,
  type SourceSnapshot,
  type SourceSnapshotRefusal,
} from "@moe/core";
import { DurableStoreError, identifyCorrelation, type SqliteEventStore } from "@moe/store";

import { deliveryV2Digest } from "./addresses.js";
import {
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2Refusal,
} from "./contracts.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";
import { admitDeliveryV2MaterialPublisherPrincipalId } from
  "./material-publisher-admission.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

export const DELIVERY_V2_SOURCE_SNAPSHOT_ADDRESS_DOMAIN =
  "moe-delivery-v2-source-snapshot-address/1" as const;
export const DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND =
  "delivery_v2.source_snapshot.commit" as const;
export const DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_ID_DOMAIN =
  "moe-delivery-v2-source-snapshot-event/1" as const;
export const DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE =
  "DeliveryV2SourceSnapshotCommitted" as const;

export interface DeliveryV2SourceSnapshotAppendAccepted {
  readonly bytes: Uint8Array;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly ref: Readonly<{
    projectId: string;
    sourceSnapshotDigest: string;
  }>;
  readonly snapshot: SourceSnapshot;
}
export type DeliveryV2SourceSnapshotAppendResult =
  | DeliveryV2SourceSnapshotAppendAccepted
  | DeliveryV2Refusal
  | SourceSnapshotRefusal;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const refusal = (
  code: DeliveryV2Refusal["code"],
  layer: DeliveryV2Refusal["layer"] = DELIVERY_V2_PERSISTENCE_LAYER,
): DeliveryV2Refusal => Object.freeze({ code, layer, ok: false as const });

function validContext(value: DeliveryV2AppendContext): boolean {
  const identifiers = [value.commandId, value.correlationId, value.principalId, value.projectId];
  return value.expectedVersion === 0 && !Object.is(value.expectedVersion, -0)
    && identifiers.every((identifier) =>
      admitDeliveryV2MaterialPublisherPrincipalId(identifier) !== undefined
      && identifier.isWellFormed() && !identifier.includes("\0"))
    && CANONICAL_TIMESTAMP.test(value.decidedAt)
    && !Number.isNaN(Date.parse(value.decidedAt))
    && new Date(value.decidedAt).toISOString() === value.decidedAt;
}

export function deriveDeliveryV2SourceSnapshotAggregateId(
  projectId: string,
  sourceSnapshotDigest: string,
): string {
  return `delivery-v2:source-snapshot:${deliveryV2Digest(
    DELIVERY_V2_SOURCE_SNAPSHOT_ADDRESS_DOMAIN,
    projectId,
    sourceSnapshotDigest,
  )}`;
}

export function deriveDeliveryV2SourceSnapshotEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `delivery-v2:source-snapshot-event:${deliveryV2Digest(
    DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_ID_DOMAIN,
    projectId,
    principalId,
    commandId,
  )}`;
}

/** Persists core-created content bytes; it does not attest that Git produced the draft. */
export function appendDeliveryV2SourceSnapshot(
  store: SqliteEventStore,
  context: DeliveryV2AppendContext,
  value: unknown,
): DeliveryV2SourceSnapshotAppendResult {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const principalId = safeContext === undefined ? undefined
    : admitDeliveryV2MaterialPublisherPrincipalId(safeContext.principalId);
  if (safeContext === undefined || !validContext(safeContext) || principalId === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const created = createSourceSnapshot(value);
  if (!created.ok) return created;
  if (created.snapshot.projectId !== safeContext.projectId) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const derived = deriveSourceSnapshotDigest(created.snapshot);
  if (!derived.ok) return derived;
  if (derived.sourceSnapshotDigest !== created.snapshot.sourceSnapshotDigest) {
    return refusal("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH");
  }
  const encoded = encodeSourceSnapshot(created.snapshot);
  if (!encoded.ok) return encoded;

  const aggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
    safeContext.projectId,
    created.snapshot.sourceSnapshotDigest,
  );
  const eventId = deriveDeliveryV2SourceSnapshotEventId(
    safeContext.projectId,
    principalId,
    safeContext.commandId,
  );
  const canonicalBytes = encoded.bytes;
  try {
    const result = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
      committedResultBytes: new Uint8Array(canonicalBytes),
      correlationId: safeContext.correlationId,
      decidedAt: safeContext.decidedAt,
      key: {
        commandId: safeContext.commandId,
        principalId,
        projectId: safeContext.projectId,
      },
      legs: [{
        aggregateId,
        events: [{
          domainSchemaVersion: SOURCE_SNAPSHOT_VERSION,
          eventId,
          eventType: DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
          payload: new Uint8Array(canonicalBytes),
        }],
        expectedVersion: 0,
      }],
      requestBytes: new Uint8Array(canonicalBytes),
    });
    if (!validateDeliveryV2DecisionDisposition(result)) {
      return refusal("DELIVERY_V2_MATERIAL_UNREADABLE");
    }
    if (result.disposition === "DECIDED"
      && (result.decision.correlationSha256 !== identifyCorrelation(safeContext.correlationId)
        || result.decision.decidedAt !== safeContext.decidedAt)) {
      return refusal("DELIVERY_V2_MATERIAL_UNREADABLE");
    }
    if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refusal(result.decision.resultCode as DeliveryV2Refusal["code"], "DURABLE_STORE");
    }
    const page = store.readAggregateEvents(aggregateId, 0, 2);
    const event = page.items[0];
    if (page.hasMore || page.items.length !== 1 || event === undefined
      || !validateDeliveryV2EventProvenance(store, event, {
      aggregateId,
      commandKind: DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
      domainSchemaVersion: SOURCE_SNAPSHOT_VERSION,
      eventId,
      eventType: DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
      expectedCommandId: safeContext.commandId,
      expectedPrincipalId: principalId,
      expectedProjectId: safeContext.projectId,
      expectedVersion: 0,
      payloadBytes: canonicalBytes,
      requestBytes: canonicalBytes,
      resultBytes: canonicalBytes,
    })) return refusal("DELIVERY_V2_MATERIAL_UNREADABLE");
    return Object.freeze({
      bytes: new Uint8Array(canonicalBytes),
      disposition: result.disposition,
      ok: true as const,
      ref: Object.freeze({
        projectId: created.snapshot.projectId,
        sourceSnapshotDigest: created.snapshot.sourceSnapshotDigest,
      }),
      snapshot: created.snapshot,
    });
  } catch (error) {
    return refusal(
      error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER,
    );
  }
}
