import type { NextAllowedCommand } from "@moe/contracts";
import type { ProductContractRevisionRef } from "@moe/core";
import type { CompiledContractBinding } from "../planning/compiled-contract-binding.js";

export const CRITERION_SCHEMA_VERSION = "moe-criterion-evidence/1" as const;
export const CRITERION_APPROVE = "criterion_check.approve" as const;
export const CRITERION_VERIFY = "criterion_check.verify" as const;
export const CRITERION_PRINCIPAL = "daemon:criterion-verifier" as const;
export const CRITERION_APPROVE_KEYS = ["goalRef", "planningRunRef", "contractRef", "criterionId", "check"] as const;
export const CRITERION_VERIFY_KEYS = ["goalRef", "planningRunRef", "contractRef", "integratedSha", "approvals"] as const;
export interface CriterionCheck {
  readonly checkId: string;
  readonly checkVersion: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}
export interface CriterionApproval extends CriterionCheck {
  readonly approvalId: string;
  readonly executorDigest: string;
}
export interface CriterionApprovedRecord {
  readonly version: typeof CRITERION_SCHEMA_VERSION;
  readonly binding: CompiledContractBinding;
  readonly criterionId: string;
  readonly criterionDigest: string;
  readonly approval: CriterionApproval;
  readonly programSha256: string;
  readonly approvedBy: string;
}
export interface IntegratedCriterionArtifact {
  readonly root: string;
  readonly sha: string;
  readonly treeSha: string;
}
export interface CriterionResult {
  readonly receiptId: string;
  readonly runRef: string;
  readonly sha: string;
  readonly treeSha: string;
  readonly status: "PASSED" | "FAILED" | "UNKNOWN";
  readonly exitCode: number | null;
  readonly outputSha256: string;
  readonly byteCount: number;
  readonly finishedAt: string;
}
export interface CriterionReceipt {
  readonly version: typeof CRITERION_SCHEMA_VERSION;
  readonly binding: CompiledContractBinding;
  readonly approved: CriterionApprovedRecord;
  readonly artifact: IntegratedCriterionArtifact;
  readonly result: CriterionResult;
  readonly executorVersion: string;
}
export interface CriterionRun {
  readonly version: typeof CRITERION_SCHEMA_VERSION;
  readonly binding: CompiledContractBinding;
  readonly runRef: string;
  readonly artifact: IntegratedCriterionArtifact;
  readonly approvals: readonly CriterionApprovedRecord[];
  readonly status: "QUEUED" | "RUNNING" | "COMPLETED" | "BLOCKED";
}
export interface CriterionEvidenceView {
  readonly outcome: "CRITERION_EVIDENCE";
  readonly goalRef: string;
  readonly planningRunRef: string;
  readonly contractRef: ProductContractRevisionRef;
  readonly graphContentHash: string;
  readonly integratedArtifact: Readonly<{ sha: string; treeSha: string }> | null;
  readonly criteria: readonly Readonly<{
    criterionId: string; statement: string; approval: CriterionApproval | null;
    evidence: CriterionResult | null; approveOffer: NextAllowedCommand | null;
  }>[];
  readonly run: Readonly<{ runRef: string; status: CriterionRun["status"]; integratedSha: string }> | null;
  readonly verifyOffer: NextAllowedCommand | null;
}
export interface CriterionRefused { readonly ok: false; readonly code: string; readonly layer: "CRITERION_EVIDENCE"; }
export type CriterionEvidenceRead = CriterionEvidenceView
  | Readonly<{ outcome: "REFUSED"; code: string; layer: "CRITERION_EVIDENCE" }>;
export interface CriterionCommandInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly payload: unknown;
}
export type CriterionCommandResult = CriterionRefused | Readonly<{
  ok: true; commandId: string; disposition: "DECIDED" | "REPLAYED"; resultCode: string;
}>;
export const criterionRefused = (code: string): CriterionRefused => ({ ok: false, code, layer: "CRITERION_EVIDENCE" });
