import { effectCount, effectHash, effectList, effectOffer, effectRecord, effectRefusal, effectSha, effectText, readEffect } from "./live-effect-read.js";
import type { CriterionCheckApproval, CriterionCheckEvidence, CriterionEvidenceOutcome, CriterionEvidenceRow, CriterionVerificationRun } from "./live-criterion-evidence-contracts.js";
export type { CriterionCheckInput, CriterionEvidenceOutcome, CriterionEvidenceView } from "./live-criterion-evidence-contracts.js";
const LAYER = "CONTROL_ROOM_CRITERIA";
const invalid = (): CriterionEvidenceOutcome => ({ status: "ERROR", code: "CRITERION_EVIDENCE_RESPONSE_INVALID", layer: LAYER });
const checkRef = (value: unknown): value is string => effectText(value) && value.length <= 128 && value.normalize("NFC") === value;

function approvalOf(value: unknown): CriterionCheckApproval | null {
  const row = effectRecord(value, ["approvalId", "checkId", "checkVersion", "program", "args", "timeoutMs", "executorDigest"]);
  if (row === null || !effectText(row.approvalId) || !checkRef(row.checkId) || !checkRef(row.checkVersion)
    || !effectText(row.program) || row.program.length > 260 || !effectHash(row.executorDigest)
    || !effectCount(row.timeoutMs) || row.timeoutMs < 1000 || row.timeoutMs > 1_800_000) return null;
  const args = effectList(row.args, (arg) => typeof arg === "string" && arg.length <= 4096
    && !arg.includes("\0") && arg.normalize("NFC") === arg ? arg : null, 128);
  return args === null ? null : Object.freeze({ approvalId: row.approvalId, checkId: row.checkId, checkVersion: row.checkVersion,
    program: row.program, args, timeoutMs: row.timeoutMs, executorDigest: row.executorDigest });
}
function evidenceOf(value: unknown): CriterionCheckEvidence | null {
  const row = effectRecord(value, ["receiptId", "runRef", "sha", "treeSha", "status", "exitCode", "outputSha256", "byteCount", "finishedAt"]);
  if (row === null || !effectText(row.receiptId) || !effectText(row.runRef) || !effectSha(row.sha) || !effectSha(row.treeSha)
    || !effectHash(row.outputSha256) || !effectCount(row.byteCount) || !effectText(row.finishedAt) || !Number.isFinite(Date.parse(row.finishedAt))
    || (row.exitCode !== null && (typeof row.exitCode !== "number" || !Number.isSafeInteger(row.exitCode)))
    || (row.status !== "PASSED" && row.status !== "FAILED" && row.status !== "UNKNOWN")
    || (row.status === "PASSED" && row.exitCode !== 0)) return null;
  return Object.freeze({ receiptId: row.receiptId, runRef: row.runRef, sha: row.sha, treeSha: row.treeSha, status: row.status,
    exitCode: row.exitCode, outputSha256: row.outputSha256, byteCount: row.byteCount, finishedAt: row.finishedAt });
}
function criterionOf(value: unknown): CriterionEvidenceRow | null {
  const row = effectRecord(value, ["criterionId", "statement", "approval", "evidence", "approveOffer"]);
  if (row === null || !effectText(row.criterionId) || !effectText(row.statement)) return null;
  const approval = row.approval === null ? null : approvalOf(row.approval);
  const evidence = row.evidence === null ? null : evidenceOf(row.evidence);
  const approveOffer = row.approveOffer === null ? null : effectOffer(row.approveOffer, "criterion_check.approve");
  if ((row.approval !== null && approval === null) || (row.evidence !== null && evidence === null)
    || (row.approveOffer !== null && approveOffer === null)) return null;
  return Object.freeze({ criterionId: row.criterionId, statement: row.statement, approval, evidence, approveOffer });
}
function runOf(value: unknown): CriterionVerificationRun | null {
  const row = effectRecord(value, ["runRef", "status", "integratedSha"]);
  if (row === null || !effectText(row.runRef) || !effectSha(row.integratedSha)
    || (row.status !== "QUEUED" && row.status !== "RUNNING" && row.status !== "COMPLETED" && row.status !== "BLOCKED")) return null;
  return Object.freeze({ runRef: row.runRef, status: row.status, integratedSha: row.integratedSha });
}
export function mapCriterionEvidenceAnswer(status: number, body: unknown): CriterionEvidenceOutcome {
  const refusal = effectRefusal(body); if (refusal !== null) return refusal;
  const row = effectRecord(body, ["outcome", "goalRef", "planningRunRef", "contractRef", "graphContentHash", "integratedArtifact", "criteria", "run", "verifyOffer"]);
  if (status !== 200 || row === null || row.outcome !== "CRITERION_EVIDENCE" || !effectText(row.goalRef)
    || !effectText(row.planningRunRef) || !effectHash(row.graphContentHash)) return invalid();
  const contract = effectRecord(row.contractRef, ["contractId", "revisionId", "revisionDigest"]);
  if (contract === null || !effectText(contract.contractId) || !effectText(contract.revisionId) || !effectHash(contract.revisionDigest)) return invalid();
  const artifact = row.integratedArtifact === null ? null : effectRecord(row.integratedArtifact, ["sha", "treeSha"]);
  if (row.integratedArtifact !== null && (artifact === null || !effectSha(artifact.sha) || !effectSha(artifact.treeSha))) return invalid();
  const criteria = effectList(row.criteria, criterionOf);
  const run = row.run === null ? null : runOf(row.run);
  const verifyOffer = row.verifyOffer === null ? null : effectOffer(row.verifyOffer, "criterion_check.verify");
  if (criteria === null || new Set(criteria.map((item) => item.criterionId)).size !== criteria.length
    || (row.run !== null && run === null) || (row.verifyOffer !== null && verifyOffer === null)) return invalid();
  if (verifyOffer !== null && (artifact === null || criteria.length === 0 || criteria.some((item) => item.approval === null)
    || run?.status === "QUEUED" || run?.status === "RUNNING")) return invalid();
  return Object.freeze({ status: "CRITERION_EVIDENCE", view: Object.freeze({ outcome: "CRITERION_EVIDENCE",
    goalRef: row.goalRef, planningRunRef: row.planningRunRef, graphContentHash: row.graphContentHash,
    contractRef: Object.freeze({ contractId: contract.contractId, revisionId: contract.revisionId, revisionDigest: contract.revisionDigest }),
    integratedArtifact: artifact === null ? null : Object.freeze({ sha: artifact.sha as string, treeSha: artifact.treeSha as string }),
    criteria, run, verifyOffer }) });
}
export async function readCriterionEvidence(headers: Readonly<Record<string, string>>, goalRef: string,
  post?: (body: string) => Promise<Response>): Promise<CriterionEvidenceOutcome> {
  return readEffect(headers, "/criteria/read", { goalRef }, mapCriterionEvidenceAnswer, LAYER, post);
}
