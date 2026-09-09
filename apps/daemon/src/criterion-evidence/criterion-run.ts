import type { SqliteEventStore } from "@moe/store";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { decodeCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { criterionBytes, criterionContractRef, criterionExact, criterionGitSha, criterionObject, criterionText,
  decodeCriterionApproved, sameCriterionBinding, sameCriterionRef } from "./criterion-codec.js";
import { CRITERION_SCHEMA_VERSION, CRITERION_VERIFY, CRITERION_VERIFY_KEYS, criterionRefused } from "./criterion-contracts.js";
import type { CriterionCommandInput, CriterionCommandResult, CriterionRun, IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { readCriterionApprovals } from "./criterion-approval.js";
import { readCriterionGoal } from "./criterion-goal.js";
import type { CriterionGoal } from "./criterion-goal.js";
import { commitCriterionRecord, criterionCatalogId, criterionReplay, criterionRunsId, readCriterionRecords } from "./criterion-storage.js";

export function decodeCriterionRun(value: unknown): CriterionRun | null {
  if (!criterionObject(value) || !criterionExact(value, ["version", "binding", "runRef", "artifact", "approvals", "status"])
    || value["version"] !== CRITERION_SCHEMA_VERSION || !criterionText(value["runRef"]) || !Array.isArray(value["approvals"])
    || !["QUEUED", "RUNNING", "COMPLETED", "BLOCKED"].includes(String(value["status"]))) return null;
  const binding = decodeCompiledContractBinding(criterionBytes(value["binding"])); const artifact = value["artifact"];
  const approvals = value["approvals"].map(decodeCriterionApproved);
  if (binding === null || !criterionObject(artifact) || !criterionExact(artifact, ["root", "sha", "treeSha"])
    || !criterionText(artifact["root"], 32768) || !criterionGitSha(artifact["sha"]) || !criterionGitSha(artifact["treeSha"])
    || approvals.length === 0 || approvals.some((item) => item === null || !sameCriterionBinding(item.binding, binding))) return null;
  return { version: CRITERION_SCHEMA_VERSION, binding, runRef: value["runRef"],
    artifact: { root: artifact["root"], sha: artifact["sha"], treeSha: artifact["treeSha"] },
    approvals: approvals as CriterionRun["approvals"], status: value["status"] as CriterionRun["status"] };
}
export function readCriterionRuns(store: SqliteEventStore, goal: CriterionGoal): readonly CriterionRun[] | null {
  const { binding } = goal;
  const rows = readCriterionRecords(store, binding.projectId, criterionRunsId(binding.projectId, binding.goalRef, binding.planningRunRef));
  if (rows === null) return null;
  const runs = new Map<string, CriterionRun>();
  for (const row of rows) {
    const run = decodeCriterionRun(row.value);
    if (run === null || !sameCriterionBinding(run.binding, binding)) return null;
    const previous = runs.get(run.runRef);
    if (previous === undefined ? run.status !== "QUEUED" || row.event.decisionTrace?.commandKind !== CRITERION_VERIFY
      : JSON.stringify({ ...previous, status: run.status }) !== JSON.stringify(run)) return null;
    if (previous !== undefined && (previous.status === "COMPLETED" || previous.status === "BLOCKED"
      || run.status === "QUEUED")) return null;
    runs.set(run.runRef, run);
  }
  return [...runs.values()];
}
export function queueCriterionVerification(store: SqliteEventStore, projectId: string, input: CriterionCommandInput, decidedAt: string,
  artifactFor: (goal: CriterionGoal) => IntegratedCriterionArtifact | null,
): CriterionCommandResult {
  try {
    const payload = input.payload;
    if (!criterionObject(payload) || !criterionExact(payload, CRITERION_VERIFY_KEYS)
      || !criterionText(payload["goalRef"]) || !criterionText(payload["planningRunRef"])
      || !criterionGitSha(payload["integratedSha"]) || !Array.isArray(payload["approvals"])) return criterionRefused("CRITERION_CHECK_MALFORMED");
    const ref = criterionContractRef(payload["contractRef"]); if (ref === null) return criterionRefused("CRITERION_CHECK_MALFORMED");
    if (!isDurableHumanPrincipal(store, input.principalId)) return criterionRefused("CRITERION_CHECK_HUMAN_REQUIRED");
    const replay = criterionReplay(store, projectId, CRITERION_VERIFY, input); if (replay !== null) return replay;
    const goal = readCriterionGoal(store, projectId, payload["goalRef"]); if (!goal.ok) return goal;
    if (goal.binding.planningRunRef !== payload["planningRunRef"] || !sameCriterionRef(goal.binding.contractRef, ref)) return criterionRefused("CRITERION_CHECK_SCOPE_MISMATCH");
    const catalogId = criterionCatalogId(projectId, goal.binding.goalRef, goal.binding.planningRunRef);
    const catalogVersion = store.getAggregateVersion(catalogId);
    const approved = readCriterionApprovals(store, goal); const runs = readCriterionRuns(store, goal);
    if (approved === null || runs === null) return criterionRefused("CRITERION_CHECK_UNREADABLE");
    if (runs.some((run) => run.status === "QUEUED" || run.status === "RUNNING" || run.status === "BLOCKED")) return criterionRefused("CRITERION_CHECK_RUN_PENDING");
    const selected = payload["approvals"];
    if (approved.length !== goal.criteria.length || selected.length !== approved.length
      || selected.some((row) => !criterionObject(row) || !criterionExact(row, ["criterionId", "approvalId"])
        || !criterionText(row["criterionId"]) || !criterionText(row["approvalId"]))
      || new Set(selected.map((row) => (row as Record<string, unknown>)["criterionId"])).size !== selected.length
      || approved.some((row) => !selected.some((item) => (item as Record<string, unknown>)["criterionId"] === row.criterionId
        && (item as Record<string, unknown>)["approvalId"] === row.approval.approvalId))) return criterionRefused("CRITERION_CHECK_APPROVAL_REQUIRED");
    const artifact = artifactFor(goal);
    if (artifact === null || artifact.sha !== payload["integratedSha"]) return criterionRefused("CRITERION_CHECK_INTEGRATED_ARTIFACT_CHANGED");
    const run: CriterionRun = { version: CRITERION_SCHEMA_VERSION, binding: goal.binding, runRef: input.commandId,
      artifact, approvals: approved, status: "QUEUED" };
    return commitCriterionRecord(store, projectId, CRITERION_VERIFY, input,
      criterionRunsId(projectId, goal.binding.goalRef, goal.binding.planningRunRef), "CriterionVerificationQueued", run, decidedAt,
      [{ aggregateId: catalogId, expectedVersion: catalogVersion, events: [] }]);
  } catch { return criterionRefused("CRITERION_CHECK_UNREADABLE"); }
}
