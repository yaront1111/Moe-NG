import { isProxy } from "node:util/types";

import {
  admitDeliveryProfileQualification, admitDeliveryProfileRevision,
} from "./delivery-profile-admission.js";
import {
  encodeDeliveryProfileQualification, encodeDeliveryProfileRevision,
} from "./delivery-profile-codec.js";
import {
  deliveryProfileRefusal,
  type DeliveryProfileQualification,
  type DeliveryProfileQualificationAuthorityPort,
  type DeliveryProfileQualificationEvidenceBinding,
  type DeliveryProfileQualificationStatusBinding,
  type DeliveryProfileRefusal,
  type DeliveryProfileRevision,
} from "./delivery-profile-contract.js";
import {
  exact, readDeliveryProfileSnapshot, readText, validHex64,
} from "./delivery-profile-admission-primitives.js";

export type QualifiedDeliveryProfileResolution =
  | Readonly<{
    ok: true;
    profile: DeliveryProfileRevision;
    qualification: DeliveryProfileQualification;
  }>
  | DeliveryProfileRefusal;

const notQualified = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_NOT_QUALIFIED", "DELIVERY_PROFILE_QUALIFICATION",
);

function evidenceCoversEveryRecipe(
  profile: DeliveryProfileRevision,
  qualification: DeliveryProfileQualification,
): boolean {
  const expected = new Map(Object.values(profile.recipes).map(
    (recipe) => [recipe.recipeRef, recipe.recipeDigest],
  ));
  const observed = new Set<string>();
  if (qualification.independentVerifierReceipts.length !== expected.size) return false;
  for (const receipt of qualification.independentVerifierReceipts) {
    if (observed.has(receipt.recipeRef)
      || expected.get(receipt.recipeRef) !== receipt.recipeDigest
      || receipt.outcome !== "PASS"
      || receipt.profileRevisionDigest !== profile.revisionDigest
      || receipt.observedAtEpochMs > qualification.qualifiedAtEpochMs
      || receipt.verifierRef === qualification.builderIdentity.principalRef
      || receipt.verifierAuthorityRef === qualification.builderIdentity.authorityRef
      || receipt.verifierCapabilityId === qualification.builderIdentity.capabilityId) return false;
    observed.add(receipt.recipeRef);
  }
  return observed.size === expected.size;
}

function trustedAuthorityPort(
  value: DeliveryProfileQualificationAuthorityPort | undefined,
): DeliveryProfileQualificationAuthorityPort | undefined {
  try {
    if (value === undefined || value === null || typeof value !== "object" || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 5 || !keys.includes("readDurableQualificationStatus")
      || !keys.includes("verifyDurableOperatorApproval")
      || !keys.includes("verifyDurableBuilderIdentity")
      || !keys.includes("verifyDurableProviderProfile")
      || !keys.includes("verifyDurableVerifierReceipt")) return undefined;
    const status = Object.getOwnPropertyDescriptor(value, "readDurableQualificationStatus");
    const approval = Object.getOwnPropertyDescriptor(value, "verifyDurableOperatorApproval");
    const builder = Object.getOwnPropertyDescriptor(value, "verifyDurableBuilderIdentity");
    const provider = Object.getOwnPropertyDescriptor(value, "verifyDurableProviderProfile");
    const receipt = Object.getOwnPropertyDescriptor(value, "verifyDurableVerifierReceipt");
    if (status === undefined || approval === undefined || builder === undefined
      || provider === undefined || receipt === undefined || !("value" in status)
      || !("value" in approval) || !("value" in builder) || !("value" in provider)
      || !("value" in receipt)
      || typeof status.value !== "function" || typeof approval.value !== "function"
      || typeof builder.value !== "function" || typeof provider.value !== "function"
      || typeof receipt.value !== "function") return undefined;
    return Object.freeze({
      readDurableQualificationStatus: status.value as DeliveryProfileQualificationAuthorityPort[
        "readDurableQualificationStatus"
      ],
      verifyDurableOperatorApproval: approval.value as (
        binding: Parameters<DeliveryProfileQualificationAuthorityPort[
          "verifyDurableOperatorApproval"
        ]>[0],
      ) => boolean,
      verifyDurableBuilderIdentity: builder.value as DeliveryProfileQualificationAuthorityPort[
        "verifyDurableBuilderIdentity"
      ],
      verifyDurableProviderProfile: provider.value as DeliveryProfileQualificationAuthorityPort[
        "verifyDurableProviderProfile"
      ],
      verifyDurableVerifierReceipt: receipt.value as DeliveryProfileQualificationAuthorityPort[
        "verifyDurableVerifierReceipt"
      ],
    });
  } catch {
    return undefined;
  }
}

const STATUS_KEYS = Object.freeze([
  "qualificationDigest", "qualificationId", "status", "statusDigest", "statusRef",
]);

function isDurableCurrentStatus(
  value: unknown,
  binding: DeliveryProfileQualificationStatusBinding,
): boolean {
  const snapshot = readDeliveryProfileSnapshot(value); if (!snapshot.ok) return false;
  if (!exact(snapshot.value, STATUS_KEYS) || snapshot.value["status"] !== "CURRENT"
    || snapshot.value["qualificationDigest"] !== binding.qualificationDigest
    || snapshot.value["qualificationId"] !== binding.qualificationId
    || !validHex64(snapshot.value["statusDigest"])) return false;
  return readText(snapshot.value["statusRef"]).ok;
}

/**
 * Resolves authority without inventing qualification from the profile descriptor. Qualification
 * evidence and the operator approval are supplied as durable records by higher layers; this
 * function only validates their exact binding and current validity window.
 */
export function resolveQualifiedDeliveryProfile(
  profileValue: unknown,
  qualificationValue: unknown,
  atEpochMs: number,
  authorityValue: DeliveryProfileQualificationAuthorityPort | undefined,
): QualifiedDeliveryProfileResolution {
  const profile = admitDeliveryProfileRevision(profileValue);
  if (!profile.ok) return profile;
  const profileDigest = encodeDeliveryProfileRevision(profile.revision);
  if (!profileDigest.ok) return profileDigest;

  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0 || Object.is(atEpochMs, -0)) {
    return notQualified();
  }
  const qualification = admitDeliveryProfileQualification(qualificationValue);
  if (!qualification.ok) return notQualified();
  const qualificationDigest = encodeDeliveryProfileQualification(qualification.qualification);
  if (!qualificationDigest.ok) return notQualified();
  const authority = trustedAuthorityPort(authorityValue); if (authority === undefined) {
    return notQualified();
  }

  const record = qualification.qualification;
  const expectedImageDigests = [...new Set(
    profile.revision.imageRefs.map((item) => item.imageDigest),
  )].sort();
  if (record.operatorDecision !== "APPROVED" || record.operatorApprovalRef === null
    || record.benchmarkVerdict !== "PASSED" || record.validity !== "CURRENT"
    || record.invalidation !== null
    || record.profileFamilyId !== profile.revision.profileFamilyId
    || record.profileId !== profile.revision.profileId
    || record.profileRevisionId !== profile.revision.revisionId
    || record.profileRevisionDigest !== profile.revision.revisionDigest
    || record.benchmarkManifest.benchmarkCorpusRef
      !== profile.revision.qualificationBenchmarkCorpus.artifactRef
    || record.benchmarkManifest.benchmarkCorpusDigest
      !== profile.revision.qualificationBenchmarkCorpus.artifactDigest
    || record.observedDigests.imageDigests.length !== expectedImageDigests.length
    || !record.observedDigests.imageDigests.every(
      (digest, index) => digest === expectedImageDigests[index],
    )
    || atEpochMs < record.qualifiedAtEpochMs || atEpochMs >= record.expiresAtEpochMs
    || !evidenceCoversEveryRecipe(profile.revision, record)) return notQualified();

  const approvalBinding = Object.freeze({
    operatorApprovalRef: record.operatorApprovalRef,
    profileFamilyId: record.profileFamilyId,
    profileId: record.profileId,
    profileRevisionDigest: record.profileRevisionDigest,
    profileRevisionId: record.profileRevisionId,
    qualificationDigest: record.qualificationDigest,
    qualificationId: record.qualificationId,
  });
  const evidenceBinding: DeliveryProfileQualificationEvidenceBinding = Object.freeze({
    benchmarkManifest: record.benchmarkManifest, benchmarkVerdict: record.benchmarkVerdict,
    builderIdentity: record.builderIdentity, moeSourceCommit: record.moeSourceCommit,
    observedDigests: record.observedDigests,
    profileFamilyId: record.profileFamilyId, profileId: record.profileId,
    profileRevisionDigest: record.profileRevisionDigest,
    profileRevisionId: record.profileRevisionId, providerProfileRefs: record.providerProfileRefs,
    qualificationDigest: record.qualificationDigest, qualificationId: record.qualificationId,
    requiredModelProviderCapabilities: profile.revision.requiredModelProviderCapabilities,
  });
  const statusBinding: DeliveryProfileQualificationStatusBinding = Object.freeze({
    qualificationDigest: record.qualificationDigest, qualificationId: record.qualificationId,
  });
  try {
    if (!isDurableCurrentStatus(
      authority.readDurableQualificationStatus(statusBinding), statusBinding,
    ) || authority.verifyDurableOperatorApproval(approvalBinding) !== true
      || authority.verifyDurableBuilderIdentity(record.builderIdentity, evidenceBinding) !== true
      || record.providerProfileRefs.some(
        (provider) => authority.verifyDurableProviderProfile(provider, evidenceBinding) !== true,
      )
      || record.independentVerifierReceipts.some(
        (receipt) => authority.verifyDurableVerifierReceipt(receipt, evidenceBinding) !== true,
      )) return notQualified();
  } catch {
    return notQualified();
  }

  return Object.freeze({
    ok: true as const, profile: profile.revision, qualification: record,
  });
}
