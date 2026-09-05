import type { SqliteEventStore } from "@moe/store";
import { CRITERION_PRINCIPAL, CRITERION_SCHEMA_VERSION, criterionRefused } from "./criterion-contracts.js";
import type { CriterionCommandResult, CriterionReceipt, CriterionResult, CriterionRun } from "./criterion-contracts.js";
import { criterionBytes, criterionExact, criterionGitSha, criterionHex, criterionObject, criterionText,
  decodeCriterionApproved, sameCriterionBinding } from "./criterion-codec.js";
import { decodeCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { CRITERION_EXECUTOR_VERSION } from "./criterion-approval.js";
import { commitCriterionRecord, criterionReceiptId, readCriterionRecords } from "./criterion-storage.js";

export function decodeCriterionReceipt(value: unknown): CriterionReceipt | null {
  if (!criterionObject(value) || !criterionExact(value, ["version", "binding", "approved", "artifact", "result", "executorVersion"])
    || value["version"] !== CRITERION_SCHEMA_VERSION || value["executorVersion"] !== CRITERION_EXECUTOR_VERSION) return null;
  const binding = decodeCompiledContractBinding(criterionBytes(value["binding"]));
  const approved = decodeCriterionApproved(value["approved"]); const artifact = value["artifact"]; const result = value["result"];
  if (binding === null || approved === null || !sameCriterionBinding(binding, approved.binding)
    || !criterionObject(artifact) || !criterionExact(artifact, ["root", "sha", "treeSha"]) || !criterionText(artifact["root"], 32768)
    || !criterionGitSha(artifact["sha"]) || !criterionGitSha(artifact["treeSha"])
    || !criterionObject(result) || !criterionExact(result, ["receiptId", "runRef", "sha", "treeSha", "status", "exitCode", "outputSha256", "byteCount", "finishedAt"])
    || !criterionText(result["receiptId"]) || !criterionText(result["runRef"])
    || result["receiptId"] !== criterionReceiptId(result["runRef"], approved.criterionId)
    || result["sha"] !== artifact["sha"] || result["treeSha"] !== artifact["treeSha"]
    || !["PASSED", "FAILED", "UNKNOWN"].includes(String(result["status"])) || !criterionHex(result["outputSha256"])
    || !Number.isSafeInteger(result["byteCount"]) || (result["byteCount"] as number) < 0
    || !criterionText(result["finishedAt"]) || !Number.isFinite(Date.parse(result["finishedAt"]))
    || (result["exitCode"] !== null && (!Number.isSafeInteger(result["exitCode"]) || (result["exitCode"] as number) < 0))
    || (result["status"] === "PASSED" && result["exitCode"] !== 0)
    || (result["status"] === "FAILED" && (result["exitCode"] === null || result["exitCode"] === 0))) return null;
  return { version: CRITERION_SCHEMA_VERSION, binding, approved, executorVersion: CRITERION_EXECUTOR_VERSION,
    artifact: { root: artifact["root"], sha: artifact["sha"], treeSha: artifact["treeSha"] }, result: result as unknown as CriterionResult };
}
export function recordCriterionReceipt(store: SqliteEventStore, receipt: CriterionReceipt): CriterionCommandResult {
  if (decodeCriterionReceipt(receipt) === null) return criterionRefused("CRITERION_CHECK_RECEIPT_INVALID");
  return commitCriterionRecord(store, receipt.binding.projectId, "internal.criterion.receipt", {
    commandId: receipt.result.receiptId, correlationId: receipt.result.runRef, expectedVersion: 0,
    principalId: CRITERION_PRINCIPAL, payload: receipt,
  }, receipt.result.receiptId, "CriterionVerificationRecorded", receipt, receipt.result.finishedAt);
}
export function readCriterionReceipt(store: SqliteEventStore, run: CriterionRun, criterionId: string): CriterionReceipt | null {
  const receiptId = criterionReceiptId(run.runRef, criterionId);
  const rows = readCriterionRecords(store, run.binding.projectId, receiptId);
  if (rows === null || rows.length !== 1 || rows[0]!.event.eventType !== "CriterionVerificationRecorded"
    || rows[0]!.event.decisionTrace?.commandKind !== "internal.criterion.receipt") return null;
  const receipt = decodeCriterionReceipt(rows[0]!.value);
  const approved = run.approvals.find((item) => item.criterionId === criterionId);
  return receipt !== null && approved !== undefined && receipt.result.runRef === run.runRef
    && sameCriterionBinding(receipt.binding, run.binding) && receipt.artifact.root === run.artifact.root
    && receipt.artifact.sha === run.artifact.sha && receipt.artifact.treeSha === run.artifact.treeSha
    && receipt.approved.approval.approvalId === approved.approval.approvalId
    && receipt.approved.approval.executorDigest === approved.approval.executorDigest ? receipt : null;
}
