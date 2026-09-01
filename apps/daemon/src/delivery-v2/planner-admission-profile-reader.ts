import { DurableStoreError, type SqliteEventStore } from "@moe/store";

import { decodePlannerAdmissionProfileRevisionBytes } from
  "../planning/v2-compiler/planner-admission-profile-codec.js";
import {
  PLANNER_ADMISSION_PROFILE_VERSION,
  type PlannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileRevision,
} from "../planning/v2-compiler/planner-admission-profile-contract.js";
import {
  plannerAdmissionProfileHex64,
  plannerAdmissionProfileText,
} from "../planning/v2-compiler/planner-admission-profile-fields.js";
import {
  DELIVERY_V2_READER_LAYER,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { admitDeliveryV2MaterialPublisherPrincipalId } from
  "./material-publisher-admission.js";
import {
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
  deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId,
  deriveDeliveryV2PlannerAdmissionProfileRevisionEventId,
  type DeliveryV2PlannerAdmissionProfileRevisionRef,
} from "./planner-admission-profile-persistence.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

export type { DeliveryV2PlannerAdmissionProfileRevisionRef } from
  "./planner-admission-profile-persistence.js";

export interface DeliveryV2PlannerAdmissionProfileRevisionReadAccepted {
  readonly ok: true;
  readonly revision: PlannerAdmissionProfileRevision;
}

export type DeliveryV2PlannerAdmissionProfileRevisionReadResult =
  | DeliveryV2PlannerAdmissionProfileRevisionReadAccepted
  | DeliveryV2Refusal
  | PlannerAdmissionProfileRefusal;

const REF_KEYS = Object.freeze(["profileId", "projectId", "revisionDigest", "revisionId"]);
const refuse = (
  code: DeliveryV2Refusal["code"],
  layer: DeliveryV2Refusal["layer"] = DELIVERY_V2_READER_LAYER,
): DeliveryV2Refusal => Object.freeze({ code, layer, ok: false as const });

const storageRefusal = (error: unknown): DeliveryV2Refusal => error instanceof DurableStoreError
  ? refuse(error.code, "DURABLE_STORE")
  : refuse("STORAGE_DEGRADED");

function admittedText(value: unknown): value is string {
  return typeof value === "string"
    && admitDeliveryV2MaterialPublisherPrincipalId(value) !== undefined
    && value.isWellFormed() && !value.includes("\0");
}

function admitRef(value: unknown): DeliveryV2PlannerAdmissionProfileRevisionRef | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (safe === undefined || safe === null || typeof safe !== "object" || Array.isArray(safe)
    || Object.keys(safe).length !== REF_KEYS.length
    || !REF_KEYS.every((key) => Object.hasOwn(safe, key))) return undefined;
  const record = safe as unknown as Readonly<Record<string, unknown>>;
  if (!plannerAdmissionProfileText(record["profileId"])
    || !admittedText(record["projectId"])
    || !plannerAdmissionProfileText(record["revisionId"])
    || !plannerAdmissionProfileHex64(record["revisionDigest"])) return undefined;
  return Object.freeze({
    profileId: record["profileId"],
    projectId: record["projectId"],
    revisionDigest: record["revisionDigest"],
    revisionId: record["revisionId"],
  });
}

/**
 * Authenticates one immutable content-addressed revision and its durable write provenance only.
 * It does not select a current revision or authenticate its authorRef, allocationDecisionRef,
 * or any conversion.authorityRef.
 */
export function readDeliveryV2PlannerAdmissionProfileRevision(
  store: SqliteEventStore,
  refValue: DeliveryV2PlannerAdmissionProfileRevisionRef,
  expectedPrincipalId: string,
): DeliveryV2PlannerAdmissionProfileRevisionReadResult {
  const ref = admitRef(refValue);
  const principalId = admitDeliveryV2MaterialPublisherPrincipalId(expectedPrincipalId);
  if (ref === undefined || principalId === undefined
    || !principalId.isWellFormed() || principalId.includes("\0")) {
    return refuse("DELIVERY_V2_INPUT_INVALID");
  }

  const aggregateId = deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
    ref.projectId,
    ref.revisionDigest,
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
    || event.domainSchemaVersion !== PLANNER_ADMISSION_PROFILE_VERSION
    || event.eventType !== DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE
    || event.decisionTrace === undefined) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (event.decisionTrace.projectId !== ref.projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  if (event.decisionTrace.commandKind
      !== DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND
    || event.decisionTrace.principalId !== principalId) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  const eventId = deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
    ref.projectId,
    principalId,
    event.decisionTrace.commandId,
  );
  if (event.eventId !== eventId) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

  const payloadBytes = new Uint8Array(event.payload);
  const decoded = decodePlannerAdmissionProfileRevisionBytes(payloadBytes);
  if (!decoded.ok) return decoded;
  if (decoded.revision.revisionDigest !== ref.revisionDigest) {
    return refuse("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH");
  }
  if (decoded.revision.profileId !== ref.profileId
    || decoded.revision.revisionId !== ref.revisionId) {
    return refuse("DELIVERY_V2_MATERIAL_REF_MISMATCH");
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
    commandKind: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
    domainSchemaVersion: PLANNER_ADMISSION_PROFILE_VERSION,
    eventId,
    eventType: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
    expectedPrincipalId: principalId,
    expectedProjectId: ref.projectId,
    expectedVersion: 0,
    payloadBytes,
    requestBytes: payloadBytes,
    resultBytes: payloadBytes,
  })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

  return Object.freeze({ ok: true as const, revision: decoded.revision });
}
