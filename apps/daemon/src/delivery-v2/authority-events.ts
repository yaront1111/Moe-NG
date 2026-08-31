import type { DeliveryV2AuthorityKind } from "./addresses.js";

export const DELIVERY_V2_AUTHORITY_EVENT_TYPES: Readonly<Record<
  DeliveryV2AuthorityKind, string
>> = Object.freeze({
  BUILDER_IDENTITY: "DeliveryV2BuilderIdentityAttested",
  OPERATOR_APPROVAL: "DeliveryV2OperatorApprovalAttested",
  PROVIDER_PROFILE: "DeliveryV2ProviderProfileAttested",
  QUALIFICATION_STATUS: "DeliveryV2QualificationStatusChanged",
  VERIFIER_RECEIPT: "DeliveryV2IndependentVerifierReceiptAttested",
});
export const DELIVERY_V2_AUTHORITY_COMMAND_KINDS: Readonly<Record<
  DeliveryV2AuthorityKind, string
>> = Object.freeze({
  BUILDER_IDENTITY: "delivery_v2.authority.builder_identity.append",
  OPERATOR_APPROVAL: "delivery_v2.authority.operator_approval.append",
  PROVIDER_PROFILE: "delivery_v2.authority.provider_profile.append",
  QUALIFICATION_STATUS: "delivery_v2.authority.qualification_status.append",
  VERIFIER_RECEIPT: "delivery_v2.authority.verifier_receipt.append",
});
