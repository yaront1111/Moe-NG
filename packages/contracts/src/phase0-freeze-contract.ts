import type { Phase0EvidenceManifest } from "./phase0-evidence-contract.js";

export const PHASE0_AUTHORIZATION_CLAIM_VERSION =
  "moe-phase0-authorization-claim/1" as const;
export const PHASE0_FREEZE_CANDIDATE_VERSION = "moe-phase0-freeze-candidate/1" as const;
export const PHASE0_FREEZE_SUBJECT = "moe-next-design-freeze" as const;
export const PHASE0_FREEZE_VERDICT = "FREEZE_READY" as const;
export const PHASE0_REVIEW_RECEIPT_VERSION = "moe-phase0-review-receipt/1" as const;
export const PHASE0_REVIEW_RECEIPT_PREFIX = "MOE_PHASE0_REVIEW_RECEIPT:" as const;
export const PHASE0_AUTHORIZATION_ASSURANCE = "UNAUTHENTICATED_EXTERNAL_RECORD" as const;
export const PHASE0_REVIEW_ASSURANCE = "CONTENT_BOUND_UNAUTHENTICATED_REVIEW" as const;
export const PHASE0_FREEZE_REQUIRED_ACTION = "REQUIRE_TRUSTED_ATTESTATIONS" as const;
export const PHASE0_FREEZE_MANIFEST_PATH = "docs/evidence/phase-0/manifest.json" as const;
export const PHASE0_FREEZE_DECISION_PATH =
  "docs/evidence/phase-0/freeze-decision.json" as const;

export interface Phase0ReviewReceipt {
  readonly inputSha256: Readonly<{
    readonly "benchmark-spec": string;
    readonly "control-room-spec": string;
    readonly "fable-review": string;
    readonly "rebuild-charter": string;
    readonly "rebuild-design": string;
  }>;
  readonly schemaVersion: typeof PHASE0_REVIEW_RECEIPT_VERSION;
  readonly verdict: typeof PHASE0_FREEZE_VERDICT;
}

export interface Phase0FreezeAuthorizationClaim {
  readonly claimedAt: string;
  readonly benchmarkSha256: string;
  readonly claimedActor: "yaron";
  readonly claimedDecision: "GO";
  readonly designSha256: string;
  readonly manifestSha256: string;
  readonly reviewSha256: string;
  readonly schemaVersion: typeof PHASE0_AUTHORIZATION_CLAIM_VERSION;
  readonly subject: typeof PHASE0_FREEZE_SUBJECT;
  readonly targetRepository: Phase0EvidenceManifest["targetRepository"];
  readonly assurance: typeof PHASE0_AUTHORIZATION_ASSURANCE;
}

export interface Phase0FreezeEvidenceReference {
  readonly byteLength: number;
  readonly objectPath: string;
  readonly sha256: string;
}

export interface Phase0FreezeCandidate {
  readonly authorizationClaim: Phase0FreezeEvidenceReference & {
    readonly assurance: typeof PHASE0_AUTHORIZATION_ASSURANCE;
    readonly claimedActor: Phase0FreezeAuthorizationClaim["claimedActor"];
    readonly claimedDecision: Phase0FreezeAuthorizationClaim["claimedDecision"];
  };
  readonly benchmarkSha256: string;
  readonly designSha256: string;
  readonly evaluatedAt: string;
  readonly evaluation: "EVIDENCE_CONSISTENT";
  readonly manifest: Phase0FreezeEvidenceReference;
  readonly requiredAction: typeof PHASE0_FREEZE_REQUIRED_ACTION;
  readonly reviewClaim: Phase0FreezeEvidenceReference & {
    readonly assurance: typeof PHASE0_REVIEW_ASSURANCE;
    readonly claimedVerdict: typeof PHASE0_FREEZE_VERDICT;
  };
  readonly schemaVersion: typeof PHASE0_FREEZE_CANDIDATE_VERSION;
  readonly sourceHead: string;
  readonly targetRepository: Phase0EvidenceManifest["targetRepository"];
}
