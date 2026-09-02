import { exact, materialDigest, record, text } from "./snapshot.js";

export type QualifiedResolutionRecord = Readonly<Record<string, unknown>> & {
  qualificationDigest: string;
  qualificationId: string;
};
export type QualifiedStatusRecord = Readonly<Record<string, unknown>> & {
  qualificationDigest: string;
  qualificationId: string;
  statusDigest: string;
  statusRef: string;
};
const STATUS_KEYS = Object.freeze([
  "qualificationDigest", "qualificationId", "status", "statusDigest", "statusRef",
]);

export function resolutionQualificationStatus(
  value: unknown,
  qualification: QualifiedResolutionRecord,
): QualifiedStatusRecord | undefined {
  if (!exact(value, STATUS_KEYS) || value["status"] !== "CURRENT"
    || value["qualificationId"] !== qualification.qualificationId
    || value["qualificationDigest"] !== qualification.qualificationDigest
    || !materialDigest(value["statusDigest"]) || !text(value["statusRef"])) return undefined;
  return value as QualifiedStatusRecord;
}

export function resolutionQualificationValid(
  value: Readonly<Record<string, unknown>>,
  atEpochMs: number,
  profile: Readonly<Record<string, unknown>>,
  builderId: string,
): value is QualifiedResolutionRecord {
  const identity = record(value["builderIdentity"]);
  return text(value["qualificationId"]) && materialDigest(value["qualificationDigest"])
    && value["profileId"] === profile["profileId"]
    && value["profileRevisionId"] === profile["revisionId"]
    && value["profileRevisionDigest"] === profile["revisionDigest"]
    && value["profileFamilyId"] === profile["profileFamilyId"]
    && value["operatorDecision"] === "APPROVED" && text(value["operatorApprovalRef"])
    && value["benchmarkVerdict"] === "PASSED" && value["validity"] === "CURRENT"
    && value["invalidation"] === null && identity !== undefined
    && identity["capabilityId"] === builderId && text(identity["authorityRef"])
    && text(identity["principalRef"]) && Number.isSafeInteger(value["qualifiedAtEpochMs"])
    && Number.isSafeInteger(value["expiresAtEpochMs"])
    && (value["qualifiedAtEpochMs"] as number) <= atEpochMs
    && atEpochMs < (value["expiresAtEpochMs"] as number);
}
