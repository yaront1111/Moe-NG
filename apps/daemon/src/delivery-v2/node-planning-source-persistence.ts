import { DurableStoreError, identifyCorrelation, type SqliteEventStore } from "@moe/store";

import { deliveryV2Digest } from "./addresses.js";
import {
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { admitDeliveryV2MaterialPublisherPrincipalId }
  from "./material-publisher-admission.js";
import {
  DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
  createDeliveryV2NodePlanningSourceRecord,
  encodeDeliveryV2NodePlanningSourceRecord,
  type DeliveryV2NodePlanningSourceRecord,
} from "./node-planning-source-record.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

export const DELIVERY_V2_NODE_PLANNING_SOURCE_ADDRESS_DOMAIN =
  "moe-delivery-v2-node-planning-source-address/1" as const;
export const DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND =
  "delivery_v2.node_planning_source.commit" as const;
export const DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_ID_DOMAIN =
  "moe-delivery-v2-node-planning-source-event/1" as const;
export const DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE =
  "DeliveryV2NodePlanningSourceCommitted" as const;

export interface DeliveryV2NodePlanningSourceRef {
  readonly nodeKey: string;
  readonly projectId: string;
  readonly revisionDigest: string;
  readonly sourceDigest: string;
}
export interface DeliveryV2NodePlanningSourceAppendAccepted {
  readonly bytes: Uint8Array;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly record: DeliveryV2NodePlanningSourceRecord;
  readonly ref: DeliveryV2NodePlanningSourceRef;
}
export type DeliveryV2NodePlanningSourceAppendResult =
  | DeliveryV2NodePlanningSourceAppendAccepted
  | DeliveryV2Refusal
  | Exclude<ReturnType<typeof createDeliveryV2NodePlanningSourceRecord>, { readonly ok: true }>;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const refuse = (
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

export function deriveDeliveryV2NodePlanningSourceAggregateId(
  projectId: string,
  revisionDigest: string,
): string {
  return `delivery-v2:node-planning-source:${deliveryV2Digest(
    DELIVERY_V2_NODE_PLANNING_SOURCE_ADDRESS_DOMAIN, projectId, revisionDigest,
  )}`;
}

export function deriveDeliveryV2NodePlanningSourceEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `delivery-v2:node-planning-source-event:${deliveryV2Digest(
    DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_ID_DOMAIN, projectId, principalId, commandId,
  )}`;
}

/** Persists inert planner-authored content. It selects no graph and grants no execution right. */
export function appendDeliveryV2NodePlanningSource(
  store: SqliteEventStore,
  context: DeliveryV2AppendContext,
  source: unknown,
): DeliveryV2NodePlanningSourceAppendResult {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const principalId = safeContext === undefined ? undefined
    : admitDeliveryV2MaterialPublisherPrincipalId(safeContext.principalId);
  if (safeContext === undefined || !validContext(safeContext) || principalId === undefined) {
    return refuse("DELIVERY_V2_INPUT_INVALID");
  }
  const created = createDeliveryV2NodePlanningSourceRecord(principalId, source);
  if (!created.ok) return created;
  const encoded = encodeDeliveryV2NodePlanningSourceRecord(created.record);
  if (!encoded.ok) return encoded;
  const bytes = encoded.bytes;
  const aggregateId = deriveDeliveryV2NodePlanningSourceAggregateId(
    safeContext.projectId, created.record.revisionDigest,
  );
  const eventId = deriveDeliveryV2NodePlanningSourceEventId(
    safeContext.projectId, principalId, safeContext.commandId,
  );
  try {
    const result = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
      committedResultBytes: new Uint8Array(bytes),
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
          domainSchemaVersion: DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
          eventId,
          eventType: DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
          payload: new Uint8Array(bytes),
        }],
        expectedVersion: 0,
      }],
      requestBytes: new Uint8Array(bytes),
    });
    if (!validateDeliveryV2DecisionDisposition(result)) {
      return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
    }
    if (result.disposition === "DECIDED"
      && (result.decision.correlationSha256 !== identifyCorrelation(safeContext.correlationId)
        || result.decision.decidedAt !== safeContext.decidedAt)) {
      return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
    }
    if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refuse(result.decision.resultCode as DeliveryV2Refusal["code"], "DURABLE_STORE");
    }
    const page = store.readAggregateEvents(aggregateId, 0, 2);
    const event = page.items[0];
    if (page.hasMore || page.items.length !== 1 || event === undefined
      || !validateDeliveryV2EventProvenance(store, event, {
        aggregateId,
        commandKind: DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
        domainSchemaVersion: DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
        eventId,
        eventType: DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
        expectedCommandId: safeContext.commandId,
        expectedPrincipalId: principalId,
        expectedProjectId: safeContext.projectId,
        expectedVersion: 0,
        payloadBytes: bytes,
        requestBytes: bytes,
        resultBytes: bytes,
      })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      disposition: result.disposition,
      ok: true as const,
      record: created.record,
      ref: Object.freeze({
        nodeKey: created.record.nodeKey,
        projectId: safeContext.projectId,
        revisionDigest: created.record.revisionDigest,
        sourceDigest: created.record.sourceDigest,
      }),
    });
  } catch (error) {
    return refuse(
      error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER,
    );
  }
}
