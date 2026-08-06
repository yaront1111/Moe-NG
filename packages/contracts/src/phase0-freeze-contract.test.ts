import { describe, expect, it } from "vitest";

import {
  PHASE0_AUTHORIZATION_ASSURANCE,
  PHASE0_AUTHORIZATION_CLAIM_VERSION,
  PHASE0_FREEZE_CANDIDATE_VERSION,
  PHASE0_FREEZE_DECISION_PATH,
  PHASE0_FREEZE_MANIFEST_PATH,
  PHASE0_FREEZE_REQUIRED_ACTION,
  PHASE0_FREEZE_SUBJECT,
  PHASE0_FREEZE_VERDICT,
  PHASE0_REVIEW_RECEIPT_PREFIX,
  PHASE0_REVIEW_RECEIPT_VERSION,
  PHASE0_REVIEW_ASSURANCE,
} from "./phase0-freeze-contract.js";

describe("Phase 0 freeze contract", () => {
  it("pins candidate namespaces and reserved artifact paths", () => {
    expect({
      authorizationAssurance: PHASE0_AUTHORIZATION_ASSURANCE,
      authorizationVersion: PHASE0_AUTHORIZATION_CLAIM_VERSION,
      candidateVersion: PHASE0_FREEZE_CANDIDATE_VERSION,
      decisionPath: PHASE0_FREEZE_DECISION_PATH,
      manifestPath: PHASE0_FREEZE_MANIFEST_PATH,
      requiredAction: PHASE0_FREEZE_REQUIRED_ACTION,
      reviewAssurance: PHASE0_REVIEW_ASSURANCE,
      reviewReceiptPrefix: PHASE0_REVIEW_RECEIPT_PREFIX,
      reviewReceiptVersion: PHASE0_REVIEW_RECEIPT_VERSION,
      subject: PHASE0_FREEZE_SUBJECT,
      verdict: PHASE0_FREEZE_VERDICT,
    }).toEqual({
      authorizationAssurance: "UNAUTHENTICATED_EXTERNAL_RECORD",
      authorizationVersion: "moe-phase0-authorization-claim/1",
      candidateVersion: "moe-phase0-freeze-candidate/1",
      decisionPath: "docs/evidence/phase-0/freeze-decision.json",
      manifestPath: "docs/evidence/phase-0/manifest.json",
      requiredAction: "REQUIRE_TRUSTED_ATTESTATIONS",
      reviewAssurance: "CONTENT_BOUND_UNAUTHENTICATED_REVIEW",
      reviewReceiptPrefix: "MOE_PHASE0_REVIEW_RECEIPT:",
      reviewReceiptVersion: "moe-phase0-review-receipt/1",
      subject: "moe-next-design-freeze",
      verdict: "FREEZE_READY",
    });
  });
});
