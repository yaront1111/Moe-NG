import { NODE_AUTHORITY_LIMITS } from "@moe/scheduler";
import { DurableStoreError, type SqliteEventStore } from "@moe/store";

import {
  DELIVERY_V2_READER_LAYER,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { captureDeliveryV2SingleEventPage } from "./event-read-snapshot.js";
import { admitDeliveryV2MaterialPublisherPrincipalId }
  from "./material-publisher-admission.js";
import {
  DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
  DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
  deriveDeliveryV2NodePlanningSourceAggregateId,
  deriveDeliveryV2NodePlanningSourceEventId,
  type DeliveryV2NodePlanningSourceRef,
} from "./node-planning-source-persistence.js";
import {
  DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
  decodeDeliveryV2NodePlanningSourceRecord,
  type DeliveryV2NodePlanningSourceRecord,
} from "./node-planning-source-record.js";
import {
  plannerAdmissionProfileHex64,
  plannerAdmissionProfileText,
} from "../planning/v2-compiler/planner-admission-profile-fields.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

export interface DeliveryV2NodePlanningSourceReadAccepted {
  readonly ok: true;
  readonly record: DeliveryV2NodePlanningSourceRecord;
}
export type DeliveryV2NodePlanningSourceReadResult =
  | DeliveryV2NodePlanningSourceReadAccepted
  | DeliveryV2Refusal
  | Exclude<ReturnType<typeof decodeDeliveryV2NodePlanningSourceRecord>, { readonly ok: true }>;

const REF_KEYS = Object.freeze(["nodeKey", "projectId", "revisionDigest", "sourceDigest"]);
const NODE_PLANNING_SOURCE_EVENT_READ_MAX_BYTES = NODE_AUTHORITY_LIMITS.maxBytes + 65_536;
const refuse = (
  code: DeliveryV2Refusal["code"],
  layer: DeliveryV2Refusal["layer"] = DELIVERY_V2_READER_LAYER,
): DeliveryV2Refusal => Object.freeze({ code, layer, ok: false as const });
const storageRefusal = (error: unknown): DeliveryV2Refusal => error instanceof DurableStoreError
  ? refuse(error.code, "DURABLE_STORE") : refuse("STORAGE_DEGRADED");

function admittedText(value: unknown): value is string {
  return typeof value === "string"
    && admitDeliveryV2MaterialPublisherPrincipalId(value) !== undefined
    && value.isWellFormed() && !value.includes("\0");
}

function admitRef(value: unknown): DeliveryV2NodePlanningSourceRef | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (safe === undefined || safe === null || typeof safe !== "object" || Array.isArray(safe)
    || Object.keys(safe).length !== REF_KEYS.length
    || !REF_KEYS.every((key) => Object.hasOwn(safe, key))) return undefined;
  const record = safe as unknown as Readonly<Record<string, unknown>>;
  if (!plannerAdmissionProfileText(record["nodeKey"])
    || !admittedText(record["projectId"])
    || !plannerAdmissionProfileHex64(record["revisionDigest"])
    || !plannerAdmissionProfileHex64(record["sourceDigest"])) return undefined;
  return Object.freeze({
    nodeKey: record["nodeKey"],
    projectId: record["projectId"],
    revisionDigest: record["revisionDigest"],
    sourceDigest: record["sourceDigest"],
  });
}

type ReaderAuthority = Readonly<{ readonly kind: "OBSERVED_AUTHOR" }>
  | Readonly<{ readonly expectedPrincipalId: unknown; readonly kind: "TRUSTED_PUBLISHER" }>;

function readAuthenticatedNodePlanningSource(
  store: SqliteEventStore,
  refValue: DeliveryV2NodePlanningSourceRef,
  authority: ReaderAuthority,
): DeliveryV2NodePlanningSourceReadResult {
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
  const aggregateId = deriveDeliveryV2NodePlanningSourceAggregateId(
    ref.projectId, ref.revisionDigest,
  );
  let page;
  try {
    page = store.readAggregateEvents(
      aggregateId, 0, 2, NODE_PLANNING_SOURCE_EVENT_READ_MAX_BYTES,
    );
  }
  catch (error) { return storageRefusal(error); }
  const captured = captureDeliveryV2SingleEventPage(page);
  if (captured.kind === "ABSENT") return refuse("DELIVERY_V2_MATERIAL_ABSENT");
  if (captured.kind !== "EVENT") return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  const { event } = captured;
  const { decisionTrace } = event;
  if (event.aggregateId !== aggregateId || event.aggregateSequence !== 1
    || event.domainSchemaVersion !== DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION
    || event.eventType !== DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE
    ) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (decisionTrace.projectId !== ref.projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  const principalId = admitDeliveryV2MaterialPublisherPrincipalId(decisionTrace.principalId);
  if (decisionTrace.commandKind !== DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND
    || principalId === undefined || !principalId.isWellFormed() || principalId.includes("\0")
    || (expectedPrincipalId !== undefined && principalId !== expectedPrincipalId)) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  const eventId = deriveDeliveryV2NodePlanningSourceEventId(
    ref.projectId, principalId, decisionTrace.commandId,
  );
  if (event.eventId !== eventId) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  const payloadBytes = new Uint8Array(event.payload);
  const decoded = decodeDeliveryV2NodePlanningSourceRecord(payloadBytes, principalId);
  if (!decoded.ok) return decoded;
  const record = decoded.record;
  if (record.sourceDigest !== ref.sourceDigest) {
    return refuse("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH");
  }
  if (record.nodeKey !== ref.nodeKey || record.revisionDigest !== ref.revisionDigest) {
    return refuse("DELIVERY_V2_MATERIAL_REF_MISMATCH");
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
  } catch (error) { return storageRefusal(error); }
  const capturedStore = Object.freeze({
    getCommandDecision: () => decision,
    getCommandReceipt: () => receipt,
  }) as unknown as SqliteEventStore;
  if (!validateDeliveryV2EventProvenance(capturedStore, event, {
    aggregateId,
    commandKind: DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
    domainSchemaVersion: DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
    eventId,
    eventType: DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
    expectedCommandId: decisionTrace.commandId,
    expectedPrincipalId: principalId,
    expectedProjectId: ref.projectId,
    expectedVersion: 0,
    payloadBytes,
    requestBytes: payloadBytes,
    resultBytes: payloadBytes,
  })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  return Object.freeze({ ok: true as const, record });
}

/** Historical authorship only; this reader does not select a graph or a current revision. */
export function readDeliveryV2AuthoredNodePlanningSource(
  store: SqliteEventStore,
  ref: DeliveryV2NodePlanningSourceRef,
): DeliveryV2NodePlanningSourceReadResult {
  return readAuthenticatedNodePlanningSource(store, ref, Object.freeze({
    kind: "OBSERVED_AUTHOR" as const,
  }));
}

/** Authenticates one explicitly referenced immutable source against one expected author. */
export function readDeliveryV2NodePlanningSource(
  store: SqliteEventStore,
  ref: DeliveryV2NodePlanningSourceRef,
  expectedPrincipalId: string,
): DeliveryV2NodePlanningSourceReadResult {
  return readAuthenticatedNodePlanningSource(store, ref, Object.freeze({
    expectedPrincipalId, kind: "TRUSTED_PUBLISHER" as const,
  }));
}
