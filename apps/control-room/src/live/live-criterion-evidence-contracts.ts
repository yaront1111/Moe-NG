import type { EffectReadFailure } from "./live-effect-read.js";

export interface CriterionContractRef { readonly contractId: string; readonly revisionId: string; readonly revisionDigest: string }
export interface CriterionCheckInput {
  readonly checkId: string; readonly checkVersion: string; readonly program: string;
  readonly args: readonly string[]; readonly timeoutMs: number;
}
export interface CriterionCheckApproval extends CriterionCheckInput { readonly approvalId: string; readonly executorDigest: string }
export interface CriterionCheckEvidence {
  readonly receiptId: string; readonly runRef: string; readonly sha: string; readonly treeSha: string;
  readonly status: "PASSED" | "FAILED" | "UNKNOWN"; readonly exitCode: number | null;
  readonly outputSha256: string; readonly byteCount: number; readonly finishedAt: string;
}
export interface CriterionEvidenceRow {
  readonly criterionId: string; readonly statement: string;
  readonly approval: CriterionCheckApproval | null; readonly evidence: CriterionCheckEvidence | null;
  readonly approveOffer: Readonly<Record<string, unknown>> | null;
}
export interface CriterionVerificationRun {
  readonly runRef: string; readonly status: "QUEUED" | "RUNNING" | "COMPLETED" | "BLOCKED"; readonly integratedSha: string;
}
export interface CriterionEvidenceView {
  readonly outcome: "CRITERION_EVIDENCE"; readonly goalRef: string; readonly planningRunRef: string;
  readonly contractRef: CriterionContractRef; readonly graphContentHash: string;
  readonly integratedArtifact: { readonly sha: string; readonly treeSha: string } | null;
  readonly criteria: readonly CriterionEvidenceRow[]; readonly run: CriterionVerificationRun | null;
  readonly verifyOffer: Readonly<Record<string, unknown>> | null;
}
export type CriterionEvidenceOutcome = EffectReadFailure | { readonly status: "CRITERION_EVIDENCE"; readonly view: CriterionEvidenceView };
