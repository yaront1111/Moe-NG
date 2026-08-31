import {
  DELIVERY_PROFILE_QUALIFICATION_VERSION, deliveryProfileRefusal,
  type DeliveryProfileQualificationAdmission, type DeliveryProfileQualificationDraft,
  type DeliveryProfileQualificationDraftAdmission,
} from "./delivery-profile-contract.js";
import {
  badReference, deepFreeze, exact, isBenchmarkVerdict, isFamily, isOperatorDecision,
  isQualificationValidity, malformed, readDeliveryProfileSnapshot, readNullableRef, readText,
  success, unsupportedFamily, validHex64, type ReadResult,
} from "./delivery-profile-admission-primitives.js";
import {
  readBenchmarkManifest, readBuilderIdentity, readIndependentVerifierReceipts, readInvalidation,
  readObservedDigests, readProviderProfileRefs, validEpoch,
} from "./delivery-profile-qualification-evidence-admission.js";

type ParsedQualification = Readonly<{
  body: DeliveryProfileQualificationDraft;
  qualificationDigest?: string;
}>;
const DRAFT_KEYS = Object.freeze([
  "benchmarkManifest", "benchmarkVerdict", "builderIdentity", "expiresAtEpochMs",
  "independentVerifierReceipts", "invalidation", "moeSourceCommit", "observedDigests",
  "operatorApprovalRef", "operatorDecision", "profileFamilyId", "profileId",
  "profileRevisionDigest", "profileRevisionId", "providerProfileRefs", "qualificationId",
  "qualifiedAtEpochMs", "validity",
]);
const FULL_KEYS = Object.freeze([...DRAFT_KEYS, "qualificationDigest", "version"]);
const COMMIT40 = /^[a-f0-9]{40}$/u;

function parseQualification(value: unknown, full: boolean): ReadResult<ParsedQualification> {
  const snapshot = readDeliveryProfileSnapshot(value); if (!snapshot.ok) return snapshot;
  if (!exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== DELIVERY_PROFILE_QUALIFICATION_VERSION) {
    return deliveryProfileRefusal(
      "DELIVERY_PROFILE_VERSION_UNSUPPORTED", "DELIVERY_PROFILE_VERSION",
    );
  }
  const family = record["profileFamilyId"]; if (!isFamily(family)) return unsupportedFamily();
  const qualificationId = readText(record["qualificationId"]);
  const profileId = readText(record["profileId"]);
  const revisionId = readText(record["profileRevisionId"]);
  const approvalRef = readNullableRef(record["operatorApprovalRef"]);
  const receipts = readIndependentVerifierReceipts(record["independentVerifierReceipts"]);
  const builderIdentity = readBuilderIdentity(record["builderIdentity"]);
  const manifest = readBenchmarkManifest(record["benchmarkManifest"]);
  const observed = readObservedDigests(record["observedDigests"]);
  const providers = readProviderProfileRefs(record["providerProfileRefs"]);
  const invalidation = readInvalidation(record["invalidation"]);
  if (!qualificationId.ok) return qualificationId; if (!profileId.ok) return profileId;
  if (!revisionId.ok) return revisionId; if (!approvalRef.ok) return approvalRef;
  if (!receipts.ok) return receipts; if (!builderIdentity.ok) return builderIdentity;
  if (!manifest.ok) return manifest;
  if (!observed.ok) return observed; if (!providers.ok) return providers;
  if (!invalidation.ok) return invalidation;
  if (!validHex64(record["profileRevisionDigest"])
    || typeof record["moeSourceCommit"] !== "string"
    || !COMMIT40.test(record["moeSourceCommit"])) return malformed();
  const operatorDecision = record["operatorDecision"];
  const benchmarkVerdict = record["benchmarkVerdict"]; const validity = record["validity"];
  if (!isOperatorDecision(operatorDecision) || !isBenchmarkVerdict(benchmarkVerdict)
    || !isQualificationValidity(validity)) return malformed();
  const qualifiedAt = record["qualifiedAtEpochMs"]; const expiresAt = record["expiresAtEpochMs"];
  if (!validEpoch(qualifiedAt) || !validEpoch(expiresAt) || expiresAt <= qualifiedAt) {
    return malformed();
  }
  if ((operatorDecision === "APPROVED") !== (approvalRef.value !== null)
    || (validity === "CURRENT") !== (invalidation.value === null)
    || (invalidation.value !== null && invalidation.value.invalidatedAtEpochMs < qualifiedAt)
    || (benchmarkVerdict === "PASSED" && receipts.value.length === 0)) return malformed();
  if (receipts.value.some((item) => item.profileRevisionDigest !== record["profileRevisionDigest"]
    || item.observedAtEpochMs > qualifiedAt)) return badReference();
  const body: DeliveryProfileQualificationDraft = Object.freeze({
    benchmarkManifest: manifest.value, benchmarkVerdict,
    builderIdentity: builderIdentity.value, expiresAtEpochMs: expiresAt,
    independentVerifierReceipts: receipts.value, invalidation: invalidation.value,
    moeSourceCommit: record["moeSourceCommit"], observedDigests: observed.value,
    operatorApprovalRef: approvalRef.value, operatorDecision, profileFamilyId: family,
    profileId: profileId.value, profileRevisionDigest: record["profileRevisionDigest"],
    profileRevisionId: revisionId.value, providerProfileRefs: providers.value,
    qualificationId: qualificationId.value, qualifiedAtEpochMs: qualifiedAt, validity,
  });
  if (!full) return success(Object.freeze({ body }));
  return validHex64(record["qualificationDigest"])
    ? success(Object.freeze({ body, qualificationDigest: record["qualificationDigest"] }))
    : malformed();
}

export function admitDeliveryProfileQualificationDraft(
  value: unknown,
): DeliveryProfileQualificationDraftAdmission {
  const parsed = parseQualification(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const }) : parsed;
}

export function admitDeliveryProfileQualification(
  value: unknown,
): DeliveryProfileQualificationAdmission {
  const parsed = parseQualification(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({ ok: true as const, qualification: deepFreeze({
    ...parsed.value.body, qualificationDigest: parsed.value.qualificationDigest!,
    version: DELIVERY_PROFILE_QUALIFICATION_VERSION,
  }) });
}
