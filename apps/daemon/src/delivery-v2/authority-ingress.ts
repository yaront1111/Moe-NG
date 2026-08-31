import type {
  DeliveryProfileBuilderIdentity,
  DeliveryProfileIndependentVerifierReceipt,
  DeliveryProfileOperatorApprovalBinding,
  DeliveryProfileProviderProfileRef,
  DeliveryProfileQualificationEvidenceBinding,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  admitDeliveryV2BuilderIdentity,
  admitDeliveryV2BuilderPrincipal,
  admitDeliveryV2PrincipalId,
  admitDeliveryV2ProviderPrincipal,
  admitDeliveryV2ProviderProfile,
  admitDeliveryV2VerifierPrincipal,
  admitDeliveryV2VerifierReceipt,
} from "./authority-admission.js";
import {
  appendDeliveryProfileBuilderIdentity,
  appendDeliveryProfileOperatorApproval,
  appendDeliveryProfileProviderProfile,
  appendDeliveryProfileQualificationStatus,
  appendDeliveryProfileVerifierReceipt,
} from "./authority-persistence.js";
import {
  DELIVERY_V2_AUTHORITY_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2AppendResult,
  type DeliveryV2BuilderIdentityPrincipalBinding,
  type DeliveryV2ProviderProfilePrincipalBinding,
  type DeliveryV2QualificationStatusInput,
  type DeliveryV2Refusal,
  type DeliveryV2VerifierReceiptPrincipalBinding,
} from "./contracts.js";
import { snapshotDeliveryV2AppendContext } from "./snapshot.js";

const refuse = (): DeliveryV2Refusal => Object.freeze({
  code: "DELIVERY_V2_INPUT_INVALID",
  layer: DELIVERY_V2_AUTHORITY_LAYER,
  ok: false as const,
});
const authorized = (context: DeliveryV2AppendContext, principalId: string) => {
  const snapshot = snapshotDeliveryV2AppendContext(context);
  return snapshot?.principalId === principalId ? snapshot : undefined;
};

export function createDeliveryProfileOperatorApprovalIngress(
  store: SqliteEventStore,
  principalId: string,
) {
  const safePrincipalId = admitDeliveryV2PrincipalId(principalId);
  return Object.freeze((context: DeliveryV2AppendContext,
    binding: DeliveryProfileOperatorApprovalBinding) => {
    const safeContext = safePrincipalId === undefined ? undefined
      : authorized(context, safePrincipalId);
    return safeContext === undefined ? refuse()
      : appendDeliveryProfileOperatorApproval(store, safeContext, binding);
  });
}

export function createDeliveryProfileQualificationStatusIngress(
  store: SqliteEventStore,
  principalId: string,
) {
  const safePrincipalId = admitDeliveryV2PrincipalId(principalId);
  return Object.freeze((context: DeliveryV2AppendContext,
    input: DeliveryV2QualificationStatusInput) => {
    const safeContext = safePrincipalId === undefined ? undefined
      : authorized(context, safePrincipalId);
    return safeContext === undefined ? refuse()
      : appendDeliveryProfileQualificationStatus(store, safeContext, input);
  });
}

export function createDeliveryProfileBuilderIdentityIngress(
  store: SqliteEventStore,
  issuer: DeliveryV2BuilderIdentityPrincipalBinding,
) {
  const safeIssuer = admitDeliveryV2BuilderPrincipal(issuer);
  return Object.freeze((context: DeliveryV2AppendContext, builder: DeliveryProfileBuilderIdentity,
    binding: DeliveryProfileQualificationEvidenceBinding):
  DeliveryV2AppendResult<unknown> => {
    const safeBuilder = admitDeliveryV2BuilderIdentity(builder);
    const safeContext = safeIssuer === undefined ? undefined
      : authorized(context, safeIssuer.principalId);
    if (safeIssuer === undefined || safeContext === undefined || safeBuilder === undefined
      || safeBuilder.authorityRef !== safeIssuer.authorityRef
      || safeBuilder.capabilityId !== safeIssuer.capabilityId
      || safeBuilder.principalRef !== safeIssuer.principalId) return refuse();
    return appendDeliveryProfileBuilderIdentity(store, safeContext, safeBuilder, binding);
  });
}

export function createDeliveryProfileProviderProfileIngress(
  store: SqliteEventStore,
  issuer: DeliveryV2ProviderProfilePrincipalBinding,
) {
  const safeIssuer = admitDeliveryV2ProviderPrincipal(issuer);
  return Object.freeze((context: DeliveryV2AppendContext,
    profile: DeliveryProfileProviderProfileRef, binding: DeliveryProfileQualificationEvidenceBinding):
  DeliveryV2AppendResult<unknown> => {
    const safeProfile = admitDeliveryV2ProviderProfile(profile);
    const safeContext = safeIssuer === undefined ? undefined
      : authorized(context, safeIssuer.principalId);
    if (safeIssuer === undefined || safeContext === undefined || safeProfile === undefined
      || safeProfile.profileRef !== safeIssuer.profileRef) return refuse();
    return appendDeliveryProfileProviderProfile(store, safeContext, safeProfile, binding);
  });
}

export function createDeliveryProfileVerifierReceiptIngress(
  store: SqliteEventStore,
  issuer: DeliveryV2VerifierReceiptPrincipalBinding,
) {
  const safeIssuer = admitDeliveryV2VerifierPrincipal(issuer);
  return Object.freeze((context: DeliveryV2AppendContext,
    receipt: DeliveryProfileIndependentVerifierReceipt,
    binding: DeliveryProfileQualificationEvidenceBinding): DeliveryV2AppendResult<unknown> =>
    {
      const safeReceipt = admitDeliveryV2VerifierReceipt(receipt);
      const safeContext = safeIssuer === undefined ? undefined
        : authorized(context, safeIssuer.principalId);
      if (safeIssuer === undefined || safeContext === undefined || safeReceipt === undefined
        || safeReceipt.verifierAuthorityRef !== safeIssuer.authorityRef
        || safeReceipt.verifierCapabilityId !== safeIssuer.capabilityId
        || safeReceipt.verifierRef !== safeIssuer.principalId) return refuse();
      return appendDeliveryProfileVerifierReceipt(store, safeContext, safeReceipt, binding);
    });
}
