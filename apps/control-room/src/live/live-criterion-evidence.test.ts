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
