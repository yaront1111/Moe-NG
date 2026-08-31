import type {
  DeliveryProfileBuilderIdentity,
  DeliveryProfileIndependentVerifierReceipt,
  DeliveryProfileOperatorApprovalBinding,
  DeliveryProfileProviderProfileRef,
  DeliveryProfileQualificationAuthorityPort,
  DeliveryProfileQualificationEvidenceBinding,
  DeliveryProfileQualificationStatusBinding,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { deriveDeliveryV2AuthorityAggregateId, deliveryV2Digest } from "./addresses.js";
import {
  admitDeliveryV2AuthorityPrincipalBindings,
  admitDeliveryV2BuilderIdentity,
  admitDeliveryV2EvidenceBinding,
  admitDeliveryV2OperatorApprovalBinding,
  admitDeliveryV2ProjectId,
  admitDeliveryV2ProviderProfile,
  admitDeliveryV2QualificationStatusBinding,
  admitDeliveryV2VerifierReceipt,
} from "./authority-admission.js";
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
  createDeliveryV2AuthorityEvidenceRecord,
  decodeDeliveryV2AuthorityEvidenceRecord,
  encodeDeliveryV2AuthorityEvidenceRecord,
  type EvidenceAuthorityKind,
} from "./authority-records.js";
import type { DeliveryV2AuthorityPrincipalBindings } from "./contracts.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";
import { readDeliveryV2QualificationStatus } from "./qualification-status-reader.js";

type ReadStore = SqliteEventStore;
const CLOSED_AUTHORITY: DeliveryProfileQualificationAuthorityPort = Object.freeze({
  readDurableQualificationStatus: () => undefined,
  verifyDurableBuilderIdentity: () => false,
  verifyDurableOperatorApproval: () => false,
  verifyDurableProviderProfile: () => false,
  verifyDurableVerifierReceipt: () => false,
});

function evidenceExists(store: ReadStore, projectId: string, kind: EvidenceAuthorityKind,
  qualificationId: string, subjectRef: string, subjectDigest: string | undefined,
  bindingDigest: string | undefined, expectedPrincipalId: string | undefined): boolean {
  if (subjectDigest === undefined || bindingDigest === undefined) return false;
  const expected = createDeliveryV2AuthorityEvidenceRecord({ bindingDigest, kind, projectId,
    qualificationId, subjectDigest, subjectRef });
  const aggregateId = deriveDeliveryV2AuthorityAggregateId(projectId, kind, expected.recordDigest);
  try {
    const page = store.readAggregateEvents(aggregateId, 0, 2);
    const event = page.items[0];
    if (page.hasMore || page.items.length !== 1 || event === undefined
      || event.aggregateSequence !== 1
      || event.aggregateId !== aggregateId
      || event.decisionTrace === undefined
      || event.eventId !== `${event.decisionTrace.commandId}:delivery-v2-authority`
      || event.eventType !== DELIVERY_V2_AUTHORITY_EVENT_TYPES[kind]
      || event.domainSchemaVersion !== DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION
      || event.decisionTrace.projectId !== projectId
      || event.decisionTrace.commandKind !== DELIVERY_V2_AUTHORITY_COMMAND_KINDS[kind]) return false;
    const observed = decodeDeliveryV2AuthorityEvidenceRecord(event.payload);
    const bytes = encodeDeliveryV2AuthorityEvidenceRecord(expected);
    return observed !== undefined && expectedPrincipalId !== undefined
      && observed.bindingDigest === expected.bindingDigest
      && observed.kind === expected.kind && observed.projectId === expected.projectId
      && observed.qualificationId === expected.qualificationId
      && observed.recordDigest === expected.recordDigest
      && observed.subjectDigest === expected.subjectDigest
      && observed.subjectRef === expected.subjectRef
      && validateDeliveryV2EventProvenance(store, event, {
        aggregateId,
        commandKind: DELIVERY_V2_AUTHORITY_COMMAND_KINDS[kind],
        domainSchemaVersion: DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION,
        eventId: `${event.decisionTrace.commandId}:delivery-v2-authority`,
        eventType: DELIVERY_V2_AUTHORITY_EVENT_TYPES[kind],
        expectedPrincipalId,
        expectedProjectId: projectId,
        expectedVersion: 0,
        payloadBytes: bytes,
        requestBytes: bytes,
        resultBytes: bytes,
      });
  } catch { return false; }
}

/** A project-bound adapter with exactly the five methods trusted by the core resolver. */
export function createDeliveryProfileQualificationAuthority(
  store: ReadStore,
  projectId: string,
  principals: DeliveryV2AuthorityPrincipalBindings,
): DeliveryProfileQualificationAuthorityPort {
  const safeProjectId = admitDeliveryV2ProjectId(projectId);
  const safePrincipals = admitDeliveryV2AuthorityPrincipalBindings(principals);
  if (safeProjectId === undefined || safePrincipals === undefined) return CLOSED_AUTHORITY;
  const providers = new Map(safePrincipals.providerProfilePrincipals.map(
    (binding) => [binding.profileRef, binding.principalId],
  ));
  const builderPrincipal = (builder: DeliveryProfileBuilderIdentity): string | undefined =>
    safePrincipals.builderIdentityPrincipals.some((issuer) =>
      issuer.authorityRef === builder.authorityRef
      && issuer.capabilityId === builder.capabilityId
      && issuer.principalId === builder.principalRef) ? builder.principalRef : undefined;
  const verifierPrincipal = (receipt: DeliveryProfileIndependentVerifierReceipt):
  string | undefined => safePrincipals.verifierReceiptPrincipals.some((issuer) =>
    issuer.authorityRef === receipt.verifierAuthorityRef
    && issuer.capabilityId === receipt.verifierCapabilityId
    && issuer.principalId === receipt.verifierRef) ? receipt.verifierRef : undefined;
  const stillCurrent = (binding: DeliveryProfileQualificationStatusBinding): boolean =>
    readDeliveryV2QualificationStatus(store, safeProjectId, binding,
      safePrincipals.qualificationStatusPrincipalId)?.status
      === "CURRENT";
  return Object.freeze({
    readDurableQualificationStatus: (binding: DeliveryProfileQualificationStatusBinding) => {
      const safeBinding = admitDeliveryV2QualificationStatusBinding(binding);
      return safeBinding === undefined ? undefined : readDeliveryV2QualificationStatus(
        store, safeProjectId, safeBinding, safePrincipals.qualificationStatusPrincipalId,
      );
    },
    verifyDurableOperatorApproval: (binding: DeliveryProfileOperatorApprovalBinding) => {
      const safeBinding = admitDeliveryV2OperatorApprovalBinding(binding);
      if (safeBinding === undefined) return false;
      const bindingDigest = deliveryV2OperatorApprovalBindingDigest(safeBinding);
      const subjectDigest = bindingDigest === undefined ? undefined : deliveryV2Digest(
        "moe-delivery-v2-operator-approval-subject/1",
        safeBinding.operatorApprovalRef, safeBinding.qualificationDigest,
      );
      return evidenceExists(store, safeProjectId, "OPERATOR_APPROVAL", safeBinding.qualificationId,
        safeBinding.operatorApprovalRef, subjectDigest, bindingDigest,
        safePrincipals.operatorApprovalPrincipalId) && stillCurrent(safeBinding);
    },
    verifyDurableBuilderIdentity: (builder: DeliveryProfileBuilderIdentity,
      binding: DeliveryProfileQualificationEvidenceBinding) => {
      const safeBuilder = admitDeliveryV2BuilderIdentity(builder);
      const safeBinding = admitDeliveryV2EvidenceBinding(binding);
      return safeBuilder !== undefined && safeBinding !== undefined && evidenceExists(
        store, safeProjectId, "BUILDER_IDENTITY", safeBinding.qualificationId,
        safeBuilder.authorityRef, deliveryV2BuilderIdentityDigest(safeBuilder),
        deliveryV2EvidenceBindingDigest(safeBinding), builderPrincipal(safeBuilder),
      ) && stillCurrent(safeBinding);
    },
    verifyDurableProviderProfile: (profile: DeliveryProfileProviderProfileRef,
      binding: DeliveryProfileQualificationEvidenceBinding) => {
      const safeProfile = admitDeliveryV2ProviderProfile(profile);
      const safeBinding = admitDeliveryV2EvidenceBinding(binding);
      return safeProfile !== undefined && safeBinding !== undefined && evidenceExists(
        store, safeProjectId, "PROVIDER_PROFILE", safeBinding.qualificationId,
        safeProfile.profileRef, deliveryV2ProviderProfileDigest(safeProfile),
        deliveryV2EvidenceBindingDigest(safeBinding), providers.get(safeProfile.profileRef),
      ) && stillCurrent(safeBinding);
    },
    verifyDurableVerifierReceipt: (receipt: DeliveryProfileIndependentVerifierReceipt,
      binding: DeliveryProfileQualificationEvidenceBinding) => {
      const safeReceipt = admitDeliveryV2VerifierReceipt(receipt);
      const safeBinding = admitDeliveryV2EvidenceBinding(binding);
      return safeReceipt !== undefined && safeBinding !== undefined && evidenceExists(
        store, safeProjectId, "VERIFIER_RECEIPT", safeBinding.qualificationId,
        safeReceipt.receiptRef, deliveryV2VerifierReceiptDigest(safeReceipt),
        deliveryV2EvidenceBindingDigest(safeBinding), verifierPrincipal(safeReceipt),
      ) && stillCurrent(safeBinding);
    },
  });
}
