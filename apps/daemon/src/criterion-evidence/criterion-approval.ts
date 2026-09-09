import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { SqliteEventStore } from "@moe/store";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { CRITERION_APPROVE, CRITERION_APPROVE_KEYS, CRITERION_SCHEMA_VERSION, criterionRefused } from "./criterion-contracts.js";
import type { CriterionApprovedRecord, CriterionCommandInput, CriterionCommandResult } from "./criterion-contracts.js";
import { criterionContractRef, criterionExact, criterionHash, criterionObject, criterionText, decodeCriterionApproved,
  decodeCriterionCheck, sameCriterionBinding, sameCriterionRef } from "./criterion-codec.js";
import { commitCriterionRecord, criterionCatalogId, criterionReplay, readCriterionRecords } from "./criterion-storage.js";
import { readCriterionGoal } from "./criterion-goal.js";
import type { CriterionGoal } from "./criterion-goal.js";

export const CRITERION_EXECUTOR_VERSION = "moe-criterion-check-executor/1";
export function measureCriterionProgram(path: string): Readonly<{ program: string; sha256: string }> | null {
  let fd: number | undefined;
  try {
    const program = realpathSync(path); fd = openSync(program, "r");
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 256 * 1024 * 1024) return null;
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(65536);
    for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (length === 0) break; hash.update(buffer.subarray(0, length)); }
    const after = fstatSync(fd);
    return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino
      ? { program, sha256: hash.digest("hex") } : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export function readCriterionApprovals(store: SqliteEventStore, goal: CriterionGoal): readonly CriterionApprovedRecord[] | null {
  const { binding } = goal;
  const rows = readCriterionRecords(store, binding.projectId, criterionCatalogId(binding.projectId, binding.goalRef, binding.planningRunRef));
  if (rows === null) return null;
  const latest = new Map<string, CriterionApprovedRecord>();
  for (const row of rows) {
    const approved = decodeCriterionApproved(row.value);
    if (row.event.eventType !== "CriterionCheckApproved" || row.event.decisionTrace?.commandKind !== CRITERION_APPROVE
      || approved === null || !sameCriterionBinding(approved.binding, binding)
      || approved.approvedBy !== row.event.decisionTrace.principalId
      || approved.approval.approvalId !== row.event.decisionTrace.commandId
      || !goal.criteria.some((criterion) => criterion.criterionId === approved.criterionId && criterion.contentDigest === approved.criterionDigest)
      || approved.approval.executorDigest !== criterionHash([CRITERION_EXECUTOR_VERSION, approved.approval.program,
        approved.programSha256, approved.approval.args, approved.approval.timeoutMs])) return null;
    latest.set(approved.criterionId, approved);
  }
  return [...latest.values()].sort((a, b) => a.criterionId.localeCompare(b.criterionId));
}
export function approveCriterionCheck(store: SqliteEventStore, projectId: string, input: CriterionCommandInput, decidedAt: string): CriterionCommandResult {
  try {
    const payload = input.payload;
    if (!criterionObject(payload) || !criterionExact(payload, CRITERION_APPROVE_KEYS)
      || !criterionText(payload["goalRef"]) || !criterionText(payload["planningRunRef"]) || !criterionText(payload["criterionId"])) {
      return criterionRefused("CRITERION_CHECK_MALFORMED");
    }
    const ref = criterionContractRef(payload["contractRef"]); const check = decodeCriterionCheck(payload["check"]);
    if (ref === null || check === null) return criterionRefused("CRITERION_CHECK_MALFORMED");
    if (!isDurableHumanPrincipal(store, input.principalId)) return criterionRefused("CRITERION_CHECK_HUMAN_REQUIRED");
    const replay = criterionReplay(store, projectId, CRITERION_APPROVE, input); if (replay !== null) return replay;
    const goal = readCriterionGoal(store, projectId, payload["goalRef"]); if (!goal.ok) return goal;
    if (goal.binding.planningRunRef !== payload["planningRunRef"] || !sameCriterionRef(goal.binding.contractRef, ref)) {
      return criterionRefused("CRITERION_CHECK_SCOPE_MISMATCH");
    }
    const criterion = goal.criteria.find((item) => item.criterionId === payload["criterionId"]);
    if (criterion === undefined) return criterionRefused("CRITERION_CHECK_SCOPE_MISMATCH");
    const program = measureCriterionProgram(check.program);
    if (program === null) return criterionRefused("CRITERION_CHECK_EXECUTABLE_UNREADABLE");
    const record: CriterionApprovedRecord = { version: CRITERION_SCHEMA_VERSION, binding: goal.binding,
      criterionId: criterion.criterionId, criterionDigest: criterion.contentDigest, approvedBy: input.principalId,
      programSha256: program.sha256, approval: { ...check, program: program.program, approvalId: input.commandId,
        executorDigest: criterionHash([CRITERION_EXECUTOR_VERSION, program.program, program.sha256, check.args, check.timeoutMs]) } };
    return commitCriterionRecord(store, projectId, CRITERION_APPROVE, input,
      criterionCatalogId(projectId, goal.binding.goalRef, goal.binding.planningRunRef), "CriterionCheckApproved", record, decidedAt);
  } catch { return criterionRefused("CRITERION_CHECK_UNREADABLE"); }
}
