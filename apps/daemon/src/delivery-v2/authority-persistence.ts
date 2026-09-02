import type { DeliveryProfileBuilderIdentity, DeliveryProfileIndependentVerifierReceipt,
  DeliveryProfileOperatorApprovalBinding, DeliveryProfileProviderProfileRef,
  DeliveryProfileQualificationEvidenceBinding } from "@moe/core";
import { DurableStoreError, type SqliteEventStore } from "@moe/store";

import {
  deriveDeliveryV2AuthorityAggregateId,
  deliveryV2Digest,
  type DeliveryV2AuthorityKind,
} from "./addresses.js";
import { admitDeliveryV2QualificationStatusInput } from "./authority-admission.js";
import {
  deliveryV2BuilderIdentityDigest,
  deliveryV2EvidenceBindingDigest,
  deliveryV2OperatorApprovalBindingDigest,
  deliveryV2ProviderProfileDigest,
  deliveryV2VerifierReceiptDigest,
} from "./authority-binding-digests.js";
import {
  DELIVERY_V2_AUTHORITY_COMMAND_KINDS,
  DELIVERY_V2_AUTHORITY_EVENT_TYPES,
} from "./authority-events.js";
import {
  DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION,
  DELIVERY_V2_QUALIFICATION_STATUS_VERSION,
  createDeliveryV2AuthorityEvidenceRecord,
  createDeliveryV2QualificationStatusRecord,
  decodeDeliveryV2QualificationStatusRecord,
  encodeDeliveryV2AuthorityEvidenceRecord,
  encodeDeliveryV2QualificationStatusRecord,
  type DeliveryV2AuthorityEvidenceRecord,
  type DeliveryV2QualificationStatusRecord,
  type EvidenceAuthorityKind,
} from "./authority-records.js";
import {
  DELIVERY_V2_AUTHORITY_LAYER,
  DELIVERY_V2_PERSISTENCE_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2AppendResult,
  type DeliveryV2QualificationStatusInput,
  type DeliveryV2Refusal,
} from "./contracts.js";
import {
  snapshotDeliveryV2AppendContext,
  snapshotDeliveryV2PlainData,
} from "./snapshot.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";

const refusal = (code: DeliveryV2Refusal["code"], layer: DeliveryV2Refusal["layer"] =
DELIVERY_V2_AUTHORITY_LAYER): DeliveryV2Refusal =>
  Object.freeze({ code, layer, ok: false as const });
function appendRecord<T>(store: SqliteEventStore, context: DeliveryV2AppendContext,
  kind: DeliveryV2AuthorityKind, aggregateId: string, bytes: Uint8Array,
  schemaVersion: string, value: T): DeliveryV2AppendResult<T> {
  try {
    const result = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_AUTHORITY_COMMAND_KINDS[kind], committedResultBytes: bytes,
      correlationId: context.correlationId, decidedAt: context.decidedAt,
      key: { commandId: context.commandId, principalId: context.principalId,
        projectId: context.projectId },
      legs: [{ aggregateId, events: [{ domainSchemaVersion: schemaVersion,
        eventId: `${context.commandId}:delivery-v2-authority`,
        eventType: DELIVERY_V2_AUTHORITY_EVENT_TYPES[kind], payload: bytes }],
      expectedVersion: context.expectedVersion }], requestBytes: bytes,
    });
    if (!validateDeliveryV2DecisionDisposition(result)) {
      return refusal("DELIVERY_V2_AUTHORITY_UNREADABLE");
    }
    if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") return refusal(
      result.decision.resultCode as DeliveryV2Refusal["code"], "DURABLE_STORE",
    );
    const event = store.readAggregateEvents(aggregateId, context.expectedVersion, 1).items[0];
    if (event === undefined || !validateDeliveryV2EventProvenance(store, event, {
      aggregateId,
      commandKind: DELIVERY_V2_AUTHORITY_COMMAND_KINDS[kind],
      domainSchemaVersion: schemaVersion,
      eventId: `${context.commandId}:delivery-v2-authority`,
      eventType: DELIVERY_V2_AUTHORITY_EVENT_TYPES[kind],
      expectedCommandId: context.commandId,
      expectedPrincipalId: context.principalId,
      expectedProjectId: context.projectId,
      expectedVersion: context.expectedVersion,
      payloadBytes: bytes,
      requestBytes: bytes,
      resultBytes: bytes,
    })) return refusal("DELIVERY_V2_AUTHORITY_UNREADABLE");
    return Object.freeze({ disposition: result.disposition, ok: true as const, value });
  } catch (error) {
    return refusal(error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER);
  }
}
function appendEvidence(store: SqliteEventStore, context: DeliveryV2AppendContext,
  kind: EvidenceAuthorityKind, qualificationId: string, subjectRef: string,
  subjectDigest: string | undefined, bindingDigest: string | undefined,
): DeliveryV2AppendResult<DeliveryV2AuthorityEvidenceRecord> {
  if (context.expectedVersion !== 0 || subjectDigest === undefined || bindingDigest === undefined
    || context.projectId === "" || qualificationId === "" || subjectRef === "") {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const record = createDeliveryV2AuthorityEvidenceRecord({ bindingDigest, kind,
    projectId: context.projectId, qualificationId, subjectDigest, subjectRef });
  return appendRecord(store, context, kind, deriveDeliveryV2AuthorityAggregateId(
    context.projectId, kind, record.recordDigest,
  ), encodeDeliveryV2AuthorityEvidenceRecord(record), DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION,
  record);
}
export function appendDeliveryProfileOperatorApproval(store: SqliteEventStore,
  context: DeliveryV2AppendContext, binding: DeliveryProfileOperatorApprovalBinding) {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const safeBinding = snapshotDeliveryV2PlainData(binding);
  if (safeContext === undefined || safeBinding === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const bindingDigest = deliveryV2OperatorApprovalBindingDigest(safeBinding);
  const subjectDigest = bindingDigest === undefined ? undefined : deliveryV2Digest(
    "moe-delivery-v2-operator-approval-subject/1",
    safeBinding.operatorApprovalRef, safeBinding.qualificationDigest,
  );
  return appendEvidence(store, safeContext, "OPERATOR_APPROVAL", safeBinding.qualificationId,
    safeBinding.operatorApprovalRef, subjectDigest, bindingDigest);
}
export function appendDeliveryProfileBuilderIdentity(store: SqliteEventStore,
  context: DeliveryV2AppendContext, builder: DeliveryProfileBuilderIdentity,
  binding: DeliveryProfileQualificationEvidenceBinding) {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const safeBuilder = snapshotDeliveryV2PlainData(builder);
  const safeBinding = snapshotDeliveryV2PlainData(binding);
  if (safeContext === undefined || safeBuilder === undefined || safeBinding === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  return appendEvidence(store, safeContext, "BUILDER_IDENTITY", safeBinding.qualificationId,
    safeBuilder.authorityRef, deliveryV2BuilderIdentityDigest(safeBuilder),
    deliveryV2EvidenceBindingDigest(safeBinding));
}
export function appendDeliveryProfileProviderProfile(store: SqliteEventStore,
  context: DeliveryV2AppendContext, profile: DeliveryProfileProviderProfileRef,
  binding: DeliveryProfileQualificationEvidenceBinding) {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const safeProfile = snapshotDeliveryV2PlainData(profile);
  const safeBinding = snapshotDeliveryV2PlainData(binding);
  if (safeContext === undefined || safeProfile === undefined || safeBinding === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  return appendEvidence(store, safeContext, "PROVIDER_PROFILE", safeBinding.qualificationId,
    safeProfile.profileRef, deliveryV2ProviderProfileDigest(safeProfile),
    deliveryV2EvidenceBindingDigest(safeBinding));
}
export function appendDeliveryProfileVerifierReceipt(store: SqliteEventStore,
  context: DeliveryV2AppendContext, receipt: DeliveryProfileIndependentVerifierReceipt,
  binding: DeliveryProfileQualificationEvidenceBinding) {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const safeReceipt = snapshotDeliveryV2PlainData(receipt);
  const safeBinding = snapshotDeliveryV2PlainData(binding);
  if (safeContext === undefined || safeReceipt === undefined || safeBinding === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  return appendEvidence(store, safeContext, "VERIFIER_RECEIPT", safeBinding.qualificationId,
    safeReceipt.receiptRef, deliveryV2VerifierReceiptDigest(safeReceipt),
    deliveryV2EvidenceBindingDigest(safeBinding));
}
function statusHistory(store: SqliteEventStore, projectId: string, qualificationId: string,
  expectedPrincipalId: string):
readonly DeliveryV2QualificationStatusRecord[] | undefined {
  const aggregateId = deriveDeliveryV2AuthorityAggregateId(
    projectId, "QUALIFICATION_STATUS", qualificationId,
  );
  try {
    const page = store.readAggregateEvents(aggregateId, 0, 3);
    if (page.hasMore || page.items.length > 2) return undefined;
    const records: DeliveryV2QualificationStatusRecord[] = [];
    for (const [index, event] of page.items.entries()) {
      if (event.aggregateId !== aggregateId
        || event.aggregateSequence !== index + 1
        || event.decisionTrace === undefined
        || event.eventId !== `${event.decisionTrace.commandId}:delivery-v2-authority`
        || event.eventType !== DELIVERY_V2_AUTHORITY_EVENT_TYPES.QUALIFICATION_STATUS
        || event.domainSchemaVersion !== DELIVERY_V2_QUALIFICATION_STATUS_VERSION
        || event.decisionTrace?.projectId !== projectId
        || event.decisionTrace.commandKind
          !== DELIVERY_V2_AUTHORITY_COMMAND_KINDS.QUALIFICATION_STATUS) return undefined;
      const record = decodeDeliveryV2QualificationStatusRecord(event.payload);
      if (record === undefined || record.projectId !== projectId
        || record.qualificationId !== qualificationId) return undefined;
      const bytes = encodeDeliveryV2QualificationStatusRecord(record);
      if (!validateDeliveryV2EventProvenance(store, event, {
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
      })) return undefined;
      records.push(record);
    }
    return Object.freeze(records);
  } catch { return undefined; }
}
export function appendDeliveryProfileQualificationStatus(store: SqliteEventStore,
  context: DeliveryV2AppendContext, input: DeliveryV2QualificationStatusInput):
DeliveryV2AppendResult<DeliveryV2QualificationStatusRecord> {
  const safeContext = snapshotDeliveryV2AppendContext(context);
  const safeInput = admitDeliveryV2QualificationStatusInput(input);
  if (safeContext === undefined || safeInput === undefined) {
    return refusal("DELIVERY_V2_INPUT_INVALID");
  }
  const record = createDeliveryV2QualificationStatusRecord({ ...safeInput,
    projectId: safeContext.projectId });
  const aggregateId = deriveDeliveryV2AuthorityAggregateId(
    safeContext.projectId, "QUALIFICATION_STATUS", safeInput.qualificationId,
  );
  const key = { commandId: safeContext.commandId, principalId: safeContext.principalId,
    projectId: safeContext.projectId };
  let prior;
  try { prior = store.getCommandDecision(key); } catch (error) {
    return refusal(error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_PERSISTENCE_LAYER);
  }
  if (prior === null) {
    const history = statusHistory(
      store, safeContext.projectId, safeInput.qualificationId, safeContext.principalId,
    );
    if (history === undefined) return refusal("DELIVERY_V2_AUTHORITY_UNREADABLE");
    const previous = history.at(-1);
    const validInitial = history.length === 0 && safeContext.expectedVersion === 0
      && safeInput.status === "CURRENT";
    const validRevocation = history.length === 1 && safeContext.expectedVersion === 1
      && previous?.status === "CURRENT" && safeInput.status === "REVOKED"
      && previous.qualificationDigest === safeInput.qualificationDigest;
    if (!validInitial && !validRevocation) {
      return refusal("DELIVERY_V2_AUTHORITY_TRANSITION_INVALID");
    }
  }
  return appendRecord(store, safeContext, "QUALIFICATION_STATUS", aggregateId,
    encodeDeliveryV2QualificationStatusRecord(record), DELIVERY_V2_QUALIFICATION_STATUS_VERSION,
    record);
}
