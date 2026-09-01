import { DurableStoreError, identifyCorrelation, type SqliteEventStore } from "@moe/store";

import {
  createPlannerAdmissionProfileRevision,
  encodePlannerAdmissionProfileRevision,
} from "../planning/v2-compiler/planner-admission-profile-codec.js";
import {
  PLANNER_ADMISSION_PROFILE_VERSION,
  type PlannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileRevision,
} from "../planning/v2-compiler/planner-admission-profile-contract.js";
import { deliveryV2Digest } from "./addresses.js";
import {
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { admitDeliveryV2MaterialPublisherPrincipalId } from
  "./material-publisher-admission.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

export const DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_ADDRESS_DOMAIN =
  "moe-delivery-v2-planner-admission-profile-revision-address/1" as const;
export const DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND =
  "delivery_v2.planner_admission_profile_revision.commit" as const;
export const DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_ID_DOMAIN =
  "moe-delivery-v2-planner-admission-profile-revision-event/1" as const;
export const DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE =
  "DeliveryV2PlannerAdmissionProfileRevisionCommitted" as const;

export interface DeliveryV2PlannerAdmissionProfileRevisionRef {
  readonly profileId: string;
  readonly projectId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export interface DeliveryV2PlannerAdmissionProfileRevisionAppendAccepted {
  readonly bytes: Uint8Array;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly ref: DeliveryV2PlannerAdmissionProfileRevisionRef;
  readonly revision: PlannerAdmissionProfileRevision;
}

export type DeliveryV2PlannerAdmissionProfileRevisionAppendResult =
  | DeliveryV2PlannerAdmissionProfileRevisionAppendAccepted
  | DeliveryV2Refusal
  | PlannerAdmissionProfileRefusal;

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

export function deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
  projectId: string,
  revisionDigest: string,
): string {
  return `delivery-v2:planner-admission-profile-revision:${deliveryV2Digest(
    DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_ADDRESS_DOMAIN,
    projectId,
    revisionDigest,
  )}`;
}

export function deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `delivery-v2:planner-admission-profile-revision-event:${deliveryV2Digest(
    DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_ID_DOMAIN,
    projectId,
    principalId,
    commandId,
  )}`;
}

/**
 * Persists immutable profile content only. Success proves canonical bytes and durable provenance;
 * it does not prove that this revision is current or authenticate its authorRef,
 * allocationDecisionRef, or any conversion.authorityRef.
 */
export function appendDeliveryV2PlannerAdmissionProfileRevision(
  store: SqliteEventStore,
  context: DeliveryV2AppendContext,
  value: unknown,
): DeliveryV2PlannerAdmissionProfileRevisionAppendResult {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const principalId = safeContext === undefined ? undefined
    : admitDeliveryV2MaterialPublisherPrincipalId(safeContext.principalId);
  if (safeContext === undefined || !validContext(safeContext) || principalId === undefined) {
    return refuse("DELIVERY_V2_INPUT_INVALID");
  }

  const created = createPlannerAdmissionProfileRevision(value);
  if (!created.ok) return created;
  const encoded = encodePlannerAdmissionProfileRevision(created.revision);
  if (!encoded.ok) return encoded;

  const revision = created.revision;
  const canonicalBytes = encoded.bytes;
  const aggregateId = deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
    safeContext.projectId,
    revision.revisionDigest,
  );
  const eventId = deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
    safeContext.projectId,
    principalId,
    safeContext.commandId,
  );

  try {
    const result = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
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
          domainSchemaVersion: PLANNER_ADMISSION_PROFILE_VERSION,
          eventId,
          eventType: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
          payload: new Uint8Array(canonicalBytes),
        }],
        expectedVersion: 0,
      }],
      requestBytes: new Uint8Array(canonicalBytes),
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
        commandKind: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
        domainSchemaVersion: PLANNER_ADMISSION_PROFILE_VERSION,
        eventId,
        eventType: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
        expectedCommandId: safeContext.commandId,
        expectedPrincipalId: principalId,
        expectedProjectId: safeContext.projectId,
        expectedVersion: 0,
        payloadBytes: canonicalBytes,
        requestBytes: canonicalBytes,
        resultBytes: canonicalBytes,
      })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

    return Object.freeze({
      bytes: new Uint8Array(canonicalBytes),
      disposition: result.disposition,
      ok: true as const,
      ref: Object.freeze({
        profileId: revision.profileId,
        projectId: safeContext.projectId,
        revisionDigest: revision.revisionDigest,
        revisionId: revision.revisionId,
      }),
      revision,
    });
  } catch (error) {
    return refuse(
      error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER,
    );
  }
}
