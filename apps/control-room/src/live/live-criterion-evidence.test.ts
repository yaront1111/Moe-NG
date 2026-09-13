import { describe, expect, it, vi } from "vitest";
import { mapCriterionEvidenceAnswer, readCriterionEvidence } from "./live-criterion-evidence.js";
const offer = (commandKind: string) => ({ commandEnvelopeVersion: "moe-runtime-command/1", commandId: commandKind,
  commandKind, expectedVersion: 3, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "criterion-catalog" });
const evidence = { receiptId: "receipt", runRef: "verify-run", sha: "a".repeat(40), treeSha: "b".repeat(40),
  status: "PASSED", exitCode: 0, outputSha256: "c".repeat(64), byteCount: 10, finishedAt: "2026-09-06T00:00:00.000Z" };
const criterion = { criterionId: "criterion-a", statement: "Shows the requested result", approveOffer: offer("criterion_check.approve"),
  approval: { approvalId: "approval", checkId: "result-test", checkVersion: "1", program: "C:\\tools\\node.exe",
    args: ["test.mjs", ""], timeoutMs: 60_000, executorDigest: "d".repeat(64) }, evidence };
export const CRITERION_FRAME = { outcome: "CRITERION_EVIDENCE", goalRef: "goal-a", planningRunRef: "plan-a",
  contractRef: { contractId: "contract-a", revisionId: "revision-a", revisionDigest: "e".repeat(64) },
  graphContentHash: "f".repeat(64), integratedArtifact: { sha: "a".repeat(40), treeSha: "b".repeat(40) }, criteria: [criterion],
  run: { runRef: "verify-run", status: "COMPLETED", integratedSha: "a".repeat(40) }, verifyOffer: offer("criterion_check.verify") };

describe("criterion evidence read", () => {
  it("carries the full contract, executor and integrated artifact evidence", () => {
    expect(mapCriterionEvidenceAnswer(200, CRITERION_FRAME)).toEqual({ status: "CRITERION_EVIDENCE", view: CRITERION_FRAME });
  });
  it.each([
    { ...CRITERION_FRAME, criteria: [criterion, criterion] },
    { ...CRITERION_FRAME, criteria: [{ ...criterion, evidence: { ...evidence, exitCode: 1 } }] },
    { ...CRITERION_FRAME, criteria: [{ ...criterion, approval: { ...criterion.approval, executorDigest: "unknown" } }] },
    { ...CRITERION_FRAME, integratedArtifact: { sha: "main", treeSha: "b".repeat(40) } },
    { ...CRITERION_FRAME, verifyOffer: offer("goal.close") },
    { ...CRITERION_FRAME, ownershipToken: "secret" },
    { ...CRITERION_FRAME, criteria: [{ ...criterion, evidence: { ...evidence, status: "VERIFIED" } }] },
    { ...CRITERION_FRAME, criteria: [{ ...criterion, approval: { ...criterion.approval, timeoutMs: 0 } }] },
  ])("rejects malformed or contradictory evidence", (frame) => {
    expect(mapCriterionEvidenceAnswer(200, frame)).toEqual({ status: "ERROR", code: "CRITERION_EVIDENCE_RESPONSE_INVALID", layer: "CONTROL_ROOM_CRITERIA" });
  });
  it("represents absent checks and evidence without manufacturing a pass", () => {
    const frame = { ...CRITERION_FRAME, integratedArtifact: null, verifyOffer: null, run: null,
      criteria: [{ ...criterion, approval: null, evidence: null }] };
    expect(mapCriterionEvidenceAnswer(200, frame)).toEqual({ status: "CRITERION_EVIDENCE", view: frame });
  });
  it("does not execute evidence getters", () => {
    const getter = vi.fn(() => "PASSED");
    const body = { ...CRITERION_FRAME, criteria: [{ ...criterion, evidence: { ...evidence, get status() { return getter(); } } }] };
    expect(mapCriterionEvidenceAnswer(200, body).status).toBe("ERROR"); expect(getter).not.toHaveBeenCalled();
  });
  it("posts the exact goal and keeps the daemon refusal layer", async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({ outcome: "REFUSED", code: "NO_BINDING", layer: "CRITERION_EVIDENCE" })));
    expect(await readCriterionEvidence({}, "goal-a", post)).toEqual({ status: "REFUSED", code: "NO_BINDING", layer: "CRITERION_EVIDENCE" });
    expect(post).toHaveBeenCalledWith('{"goalRef":"goal-a"}');
  });
});

/**
 * THE BOUNDS ARE CORE'S ADMISSION LIMITS, NOT THE EFFECT READER'S DEFAULTS. Core admits up to
 * 512 criteria per revision and 32_768 UTF-8 BYTES per statement
 * (packages/core/src/product-contract/product-contract-contract.ts:23,27; bytes measured at
 * product-contract-admission.ts:49), and the daemon serves every admitted criterion and
 * statement verbatim (apps/daemon/src/criterion-evidence/criterion-read.ts:64-67). A frame at
 * those bounds is one the daemon really answers for an admitted revision; one past them is not.
 */
describe("criteria and statements decode at core's admission bounds", () => {
  const INVALID = { status: "ERROR", code: "CRITERION_EVIDENCE_RESPONSE_INVALID", layer: "CONTROL_ROOM_CRITERIA" };
  const criteriaOf = (count: number) => Array.from({ length: count }, (_, index) => ({ ...criterion, criterionId: `criterion-${index}` }));
  const withStatement = (statement: string) => ({ ...CRITERION_FRAME, criteria: [{ ...criterion, statement }] });
  it("carries 512 criteria, the most core admits in one revision", () => {
    const frame = { ...CRITERION_FRAME, criteria: criteriaOf(512) };
    expect(mapCriterionEvidenceAnswer(200, frame)).toEqual({ status: "CRITERION_EVIDENCE", view: frame });
  });
  it("refuses 513 criteria, one more than core admits", () => {
    expect(mapCriterionEvidenceAnswer(200, { ...CRITERION_FRAME, criteria: criteriaOf(513) })).toEqual(INVALID);
  });
  it("carries a 32_768-byte statement, the longest core admits", () => {
    const frame = withStatement("s".repeat(32_768));
    expect(mapCriterionEvidenceAnswer(200, frame)).toEqual({ status: "CRITERION_EVIDENCE", view: frame });
  });
  it("refuses a 32_769-byte statement, one byte past core's bound", () => {
    expect(mapCriterionEvidenceAnswer(200, withStatement("s".repeat(32_769)))).toEqual(INVALID);
  });
  it("measures the statement in UTF-8 bytes as core does, not in UTF-16 code units", () => {
    // U+20AC is three UTF-8 bytes: 10_922 of them are 32_766 bytes (admitted) and 10_923 are
    // 32_769 bytes (refused), while both counts sit far below 32_768 code units.
    const admitted = withStatement("\u20AC".repeat(10_922));
    expect(mapCriterionEvidenceAnswer(200, admitted)).toEqual({ status: "CRITERION_EVIDENCE", view: admitted });
    expect(mapCriterionEvidenceAnswer(200, withStatement("\u20AC".repeat(10_923)))).toEqual(INVALID);
  });
});
