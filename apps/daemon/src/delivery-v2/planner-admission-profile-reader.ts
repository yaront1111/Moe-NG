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
import { captureDeliveryV2SingleEventPage } from "./event-read-snapshot.js";
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

type PlannerAdmissionProfileReaderAuthority =
  | Readonly<{ readonly kind: "OBSERVED_AUTHOR" }>
  | Readonly<{ readonly expectedPrincipalId: unknown; readonly kind: "TRUSTED_PUBLISHER" }>;

function readAuthenticatedPlannerAdmissionProfileRevision(
  store: SqliteEventStore,
  refValue: DeliveryV2PlannerAdmissionProfileRevisionRef,
  authority: PlannerAdmissionProfileReaderAuthority,
): DeliveryV2PlannerAdmissionProfileRevisionReadResult {
  const ref = admitRef(refValue);
  if (ref === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  let expectedPrincipalId: string | undefined;
  if (authority.kind === "TRUSTED_PUBLISHER") {
    expectedPrincipalId = admitDeliveryV2MaterialPublisherPrincipalId(
      authority.expectedPrincipalId,
    );
    if (expectedPrincipalId === undefined || !expectedPrincipalId.isWellFormed()
      || expectedPrincipalId.includes("\0")) return refuse("DELIVERY_V2_INPUT_INVALID");
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
  const capturedPage = captureDeliveryV2SingleEventPage(page);
  if (capturedPage.kind === "ABSENT") {
    return refuse("DELIVERY_V2_MATERIAL_ABSENT");
  }
  if (capturedPage.kind !== "EVENT") return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  const { event } = capturedPage;
  const { decisionTrace } = event;
  if (event.aggregateId !== aggregateId || event.aggregateSequence !== 1
    || event.domainSchemaVersion !== PLANNER_ADMISSION_PROFILE_VERSION
    || event.eventType !== DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (decisionTrace.projectId !== ref.projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  const principalId = admitDeliveryV2MaterialPublisherPrincipalId(decisionTrace.principalId);
  if (decisionTrace.commandKind !== DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND
    || principalId === undefined || !principalId.isWellFormed() || principalId.includes("\0")
    || (expectedPrincipalId !== undefined && principalId !== expectedPrincipalId)) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  const eventId = deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
    ref.projectId, principalId, decisionTrace.commandId,
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
  if (authority.kind === "OBSERVED_AUTHOR" && decoded.revision.authorRef !== principalId) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }

  let decision;
  let receipt;
  try {
    decision = store.getCommandDecision({
      commandId: decisionTrace.commandId,
      principalId: decisionTrace.principalId,
      projectId: decisionTrace.projectId,
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
    expectedCommandId: decisionTrace.commandId,
    expectedPrincipalId: principalId,
    expectedProjectId: ref.projectId,
    expectedVersion: 0,
    payloadBytes,
    requestBytes: payloadBytes,
    resultBytes: payloadBytes,
  })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");

  return Object.freeze({ ok: true as const, revision: decoded.revision });
}

/**
 * Authenticates one immutable content-addressed revision against a caller-selected publisher.
 * It does not select a current revision or authenticate its authorRef, allocationDecisionRef,
 * or any conversion.authorityRef.
 */
export function readDeliveryV2PlannerAdmissionProfileRevision(
  store: SqliteEventStore,
  refValue: DeliveryV2PlannerAdmissionProfileRevisionRef,
  expectedPrincipalId: string,
): DeliveryV2PlannerAdmissionProfileRevisionReadResult {
  return readAuthenticatedPlannerAdmissionProfileRevision(store, refValue, Object.freeze({
    expectedPrincipalId,
    kind: "TRUSTED_PUBLISHER" as const,
  }));
}

/**
 * Authenticates that one immutable content-addressed revision was durably committed by the
 * principal named in its authorRef. This is historical authorship only: it does not select a
 * current revision or authenticate allocationDecisionRef or any conversion.authorityRef.
 */
export function readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
  store: SqliteEventStore,
  refValue: DeliveryV2PlannerAdmissionProfileRevisionRef,
): DeliveryV2PlannerAdmissionProfileRevisionReadResult {
  return readAuthenticatedPlannerAdmissionProfileRevision(store, refValue, Object.freeze({
    kind: "OBSERVED_AUTHOR" as const,
  }));
}
