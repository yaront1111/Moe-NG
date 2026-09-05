import type { SqliteEventStore } from "@moe/store";
import type { LandingCommit } from "./landing-receipt-contracts.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { sameVerifiedWorkspace } from "./verified-workspace-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { readLandingBaseline, readLandingReceipt } from "./landing-ledger.js";
import { landingReceiptId, NODE_LANDER_PRINCIPAL_ID } from "./landing-receipt-contracts.js";
import { readRepositoryLandingEvidence } from "./repository-landing-intent.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
export interface RecoveryLandedEvidence {
  readonly binding: VerifiedWorkspaceBinding;
  readonly commit: LandingCommit;
  readonly verifierReceiptId: string;
  readonly receiptId: string;
  readonly needsLandingReceipt: boolean;
  readonly proof: { readonly kind: "LANDING_RECEIPT" | "LANDING_COMPLETION"; readonly id: string };
}
function sameWorkspace(workspace: string, handle: RepositoryExecutionHandle): boolean {
  if (workspace === handle.reservation.identity.root) return true;
  const resolved = resolveRepositoryExecutionIdentity(workspace);
  return resolved.ok && resolved.identity.root === handle.reservation.identity.root
    && resolved.identity.gitDirectory === handle.reservation.identity.gitDirectory;
}
const sameCommit = (left: LandingCommit, right: LandingCommit): boolean => left.sha === right.sha && left.branch === right.branch
  && left.parentSha === right.parentSha && left.message === right.message
  && JSON.stringify([...left.files].sort()) === JSON.stringify([...right.files].sort());

/** Durable positive completion is required; PID observations never enter this evidence join. */
export function readRecoveryLandingEvidence(store: SqliteEventStore, handle: RepositoryExecutionHandle): RepositoryRecoveryResult<{ evidence: RecoveryLandedEvidence }> {
  try {
    const { owner, reservation } = handle;
    if (/^(?:publish|criterion):/u.test(owner.nodeRef)) return recoveryRefusal("REPOSITORY_RECOVERY_WORKFLOW_UNSUPPORTED");
    if (!["LANDING", "BLOCKED"].includes(reservation.phase)) return recoveryRefusal("REPOSITORY_RECOVERY_PHASE_UNSUPPORTED");
    const journal = readRepositoryLandingEvidence(store, handle);
    if (!journal.ok && journal.code !== "REPOSITORY_RECOVERY_EVIDENCE_MISSING") return journal;
    if (reservation.phase === "BLOCKED" && (!journal.ok || journal.completion === null)) {
      return recoveryRefusal("REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN");
    }
    const review = readReviewLedger(store, owner.projectId, owner.nodeRef);
    if (review.unreadable || review.escalated || review.replanned) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    if (review.accepted === undefined || reservation.baselineId === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_MISSING");
    const verified = readVerifierReceipt(store, owner.projectId, review.accepted.verifierReceiptId);
    if (!verified.ok || verified.receipt.subjectRef !== owner.nodeRef || verified.receiptSha256 !== review.accepted.verifierReceiptSha256) {
      return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    }
    const binding = verified.receipt.execution.workspaceBinding;
    if (binding === undefined) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_MISSING");
    if (binding.root !== reservation.identity.root || !sameWorkspace(verified.receipt.execution.workspace, handle)) {
      return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    }
    const baseline = readLandingBaseline(store, owner.projectId, owner.nodeRef, reservation.baselineId);
    const baselineDecision = store.getCommandDecision({ projectId: owner.projectId, principalId: NODE_LANDER_PRINCIPAL_ID, commandId: reservation.baselineId });
    if (baseline === null || baselineDecision === null || !sameWorkspace(baseline.workspace, handle)
      || baselineDecision.decisionPosition >= verified.decision.decisionPosition) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    if (journal.ok && (journal.intent.verifierReceiptId !== verified.receipt.receiptId || !sameVerifiedWorkspace(journal.intent.binding, binding))) {
      return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
    }
    const receiptId = landingReceiptId(owner.projectId, owner.nodeRef, verified.receipt.receiptId);
    const landed = readLandingReceipt(store, owner.projectId, receiptId);
    if (!landed.ok && landed.code !== "LANDING_RECEIPT_NOT_FOUND") return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    if (landed.ok && (landed.receipt.outcome !== "COMMITTED" || landed.receipt.commit === null)) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
    const completion = journal.ok ? journal.completion : null;
    const commit = landed.ok ? landed.receipt.commit : completion?.commit;
    if (commit === null || commit === undefined) return recoveryRefusal("REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN");
    if (commit.parentSha !== binding.headSha || commit.branch !== binding.branchRef.slice(11)
      || (landed.ok && (!sameWorkspace(landed.receipt.workspace, handle) || landed.decision.decisionPosition <= verified.decision.decisionPosition))
      || (completion !== null && !sameCommit(commit, completion.commit))) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
    return { ok: true, evidence: { binding, commit, verifierReceiptId: verified.receipt.receiptId, receiptId, needsLandingReceipt: !landed.ok,
      proof: completion === null ? { kind: "LANDING_RECEIPT", id: receiptId } : { kind: "LANDING_COMPLETION", id: completion.intentId } } };
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID"); }
}
