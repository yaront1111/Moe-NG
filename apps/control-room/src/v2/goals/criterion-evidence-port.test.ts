import { describe, expect, it, vi } from "vitest";
import { createCriterionEvidencePort } from "./criterion-evidence-port.js";
import type { OfferWire } from "../approvals/offer-wire.js";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
const approveOffer = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "approval", commandKind: "criterion_check.approve",
  expectedVersion: 3, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "catalog" };
const verifyOffer = { ...approveOffer, commandId: "run", commandKind: "criterion_check.verify", expectedVersion: 1, targetAggregateId: "runs" };
const check = { checkId: "shows-result", checkVersion: "2", program: "C:\\tools\\node.exe", args: ["check.mjs", ""], timeoutMs: 60000 };
const view: CriterionEvidenceView = { outcome: "CRITERION_EVIDENCE", goalRef: "goal", planningRunRef: "plan",
  contractRef: { contractId: "contract", revisionId: "revision", revisionDigest: "a".repeat(64) }, graphContentHash: "b".repeat(64),
  integratedArtifact: { sha: "c".repeat(40), treeSha: "d".repeat(40) }, criteria: [{ criterionId: "result", statement: "Result appears",
    approval: { ...check, approvalId: "approved-check", executorDigest: "e".repeat(64) }, evidence: null, approveOffer }], run: null, verifyOffer };
describe("criterion command port", () => {
  it("approves an exact check and queues only the exact complete approved roster", async () => {
    const approve = vi.fn((_offer: unknown, input: { payload: unknown }) => ({ ok: true, envelope: { commandId: "approval", payload: input.payload } }));
    const verify = vi.fn((_offer: unknown, input: { payload: unknown }) => ({ ok: true, envelope: { commandId: "run", payload: input.payload } }));
    const wire = { client: { commands: { "criterion_check.approve": approve, "criterion_check.verify": verify } },
      sessionCredential: "session", transport: { sendCommand: async () => ({ delivered: true, response: { ok: true } }) } } as unknown as OfferWire;
    const port = createCriterionEvidencePort(wire);
    expect(await port.approve(view, view.criteria[0]!, check)).toEqual({ ok: true, commandId: "approval" });
    expect(approve).toHaveBeenCalledWith(approveOffer, expect.objectContaining({ payload: { goalRef: "goal", planningRunRef: "plan",
      contractRef: view.contractRef, criterionId: "result", check } }));
    expect(await port.verify(view)).toEqual({ ok: true, commandId: "run" });
    expect(verify).toHaveBeenCalledWith(verifyOffer, expect.objectContaining({ payload: { goalRef: "goal", planningRunRef: "plan",
      contractRef: view.contractRef, integratedSha: "c".repeat(40), approvals: [{ criterionId: "result", approvalId: "approved-check" }] } }));
  });
  it("cannot queue missing check approvals or an unoffered check", async () => {
    const wire = { client: { commands: {} }, sessionCredential: "session", transport: {} } as unknown as OfferWire;
    const port = createCriterionEvidencePort(wire);
    expect(await port.verify({ ...view, criteria: [{ ...view.criteria[0]!, approval: null }] }))
      .toEqual({ ok: false, code: "CRITERION_VERIFICATION_NOT_OFFERED", layer: "CONTROL_ROOM_CRITERIA" });
    expect(await port.approve({ ...view, criteria: [] }, view.criteria[0]!, check))
      .toEqual({ ok: false, code: "CRITERION_APPROVAL_NOT_OFFERED", layer: "CONTROL_ROOM_CRITERIA" });
  });
});
