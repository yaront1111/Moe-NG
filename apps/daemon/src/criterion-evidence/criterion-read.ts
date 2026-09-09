import { randomUUID } from "node:crypto";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { readCriterionApprovals } from "./criterion-approval.js";
import { sameCriterionArtifact, readCriterionArtifact } from "./criterion-artifact.js";
import { readCriterionGoal } from "./criterion-goal.js";
import type { CriterionGoal } from "./criterion-goal.js";
import { readCriterionRuns } from "./criterion-run.js";
import { readCriterionReceipt } from "./criterion-receipt.js";
import { criterionCatalogId, criterionRunsId } from "./criterion-storage.js";
import { CRITERION_APPROVE, CRITERION_VERIFY, CRITERION_SCHEMA_VERSION } from "./criterion-contracts.js";
import type { CriterionApprovedRecord, CriterionEvidenceRead, CriterionReceipt, IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { sameCriterionBinding } from "./criterion-codec.js";

/** Compare decoded immutable approval facts; command ids alone are principal-scoped. */
function sameApprovedCheck(current: CriterionApprovedRecord | undefined, recorded: CriterionApprovedRecord): boolean {
  if (current === undefined) return false;
  const a = current.approval, b = recorded.approval;
  return current.version === recorded.version && sameCriterionBinding(current.binding, recorded.binding)
    && current.criterionId === recorded.criterionId && current.criterionDigest === recorded.criterionDigest
    && current.approvedBy === recorded.approvedBy && current.programSha256 === recorded.programSha256
    && a.approvalId === b.approvalId && a.executorDigest === b.executorDigest && a.checkId === b.checkId
    && a.checkVersion === b.checkVersion && a.program === b.program && a.timeoutMs === b.timeoutMs
    && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]);
}

/** Historical success remains a historical receipt; only the exact present integrated artifact is current evidence. */
export function currentCriterionReceipts(store: SqliteEventStore, goal: CriterionGoal,
  artifactRead: (root: string) => IntegratedCriterionArtifact | null = readCriterionArtifact,
): ReadonlyMap<string, CriterionReceipt> {
  const current = new Map<string, CriterionReceipt>();
  const runs = readCriterionRuns(store, goal); const approved = readCriterionApprovals(store, goal);
  if (runs === null || approved === null) return current;
  const latest = runs.at(-1);
  if (latest?.status !== "COMPLETED" || !sameCriterionArtifact(latest.artifact, artifactRead(latest.artifact.root))) return current;
  for (const criterion of goal.criteria) {
    const receipt = readCriterionReceipt(store, latest, criterion.criterionId);
    const approval = approved.find((item) => item.criterionId === criterion.criterionId);
    if (receipt !== null && receipt.result.status === "PASSED" && sameApprovedCheck(approval, receipt.approved)
      && receipt.approved.criterionDigest === criterion.contentDigest) current.set(criterion.criterionId, receipt);
  }
  return current;
}
export function readCriterionEvidence(store: SqliteEventStore, projectId: string, goalRef: string,
  artifactFor: (goal: CriterionGoal) => IntegratedCriterionArtifact | null,
): CriterionEvidenceRead {
  try {
    const goal = readCriterionGoal(store, projectId, goalRef);
    if (!goal.ok) return { outcome: "REFUSED", code: goal.code, layer: goal.layer };
    const approvals = readCriterionApprovals(store, goal); const runs = readCriterionRuns(store, goal);
    if (approvals === null || runs === null) return { outcome: "REFUSED", code: "CRITERION_CHECK_UNREADABLE", layer: "CRITERION_EVIDENCE" };
    const artifact = artifactFor(goal); const latest = runs.at(-1);
    const offer = (kind: typeof CRITERION_APPROVE | typeof CRITERION_VERIFY, aggregateId: string): NextAllowedCommand => ({
      commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, commandId: randomUUID(),
      commandKind: kind as NextAllowedCommand["commandKind"], expectedVersion: store.getAggregateVersion(aggregateId),
      inputSchemaVersion: CRITERION_SCHEMA_VERSION, targetAggregateId: aggregateId,
    });
    const { binding } = goal;
    const pending = latest !== undefined && latest.status !== "COMPLETED";
    return { outcome: "CRITERION_EVIDENCE", goalRef, planningRunRef: binding.planningRunRef,
      contractRef: binding.contractRef, graphContentHash: binding.graphContentHash,
      integratedArtifact: artifact === null ? null : { sha: artifact.sha, treeSha: artifact.treeSha },
      criteria: goal.criteria.map((criterion) => {
        const approval = approvals.find((item) => item.criterionId === criterion.criterionId);
        const receipt = latest === undefined ? null : readCriterionReceipt(store, latest, criterion.criterionId);
        return { criterionId: criterion.criterionId, statement: criterion.statement, approval: approval?.approval ?? null,
          evidence: receipt !== null && sameApprovedCheck(approval, receipt.approved) ? receipt.result : null,
          approveOffer: pending ? null : offer(CRITERION_APPROVE, criterionCatalogId(projectId, goalRef, binding.planningRunRef)),
        };
      }),
      run: latest === undefined ? null : { runRef: latest.runRef, status: latest.status, integratedSha: latest.artifact.sha },
      verifyOffer: artifact === null || pending || approvals.length !== goal.criteria.length ? null
        : offer(CRITERION_VERIFY, criterionRunsId(projectId, goalRef, binding.planningRunRef)),
    };
  } catch { return { outcome: "REFUSED", code: "CRITERION_CHECK_UNREADABLE", layer: "CRITERION_EVIDENCE" }; }
}
