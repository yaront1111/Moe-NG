import { afterEach, describe, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { LANDING_RECEIPT_COMMAND_KIND, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { createNodeLander } from "./node-lander.js";
afterEach(closeStores);
describe("landing effect journal integration", () => {
  it("persists owner-bound intent before Git and positive completion before a failed landing receipt", async () => {
    const f = recoveryEvidenceFixture(); let commits = 0;
    const store = new Proxy(f.store, { get(target, key) {
      if (key === "commitExpectedVersionDecision") return (input: Parameters<typeof target.commitExpectedVersionDecision>[0]) => {
        if (input.commandKind === LANDING_RECEIPT_COMMAND_KIND) throw new Error("receipt disk unavailable");
        return target.commitExpectedVersionDecision(input);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const port = { capture: async () => ({ ok: true as const, binding: commits === 0 ? f.binding : { ...f.binding, headSha: f.commit.sha } }), commit: async () => {
      commits += 1;
      expect(readRepositoryLandingEvidence(f.store, f.handle)).toMatchObject({ ok: true, completion: null });
      return { ok: true as const, receipt: f.commit };
    } };
    const lander = createNodeLander({ store, projectId: f.handle.owner.projectId, reservationHandle: f.handle,
      baselineId: () => f.baseline.baselineId, nodes: () => [{ nodeRef: f.handle.owner.nodeRef }], verifiedWorkspace: port,
      nodeMission: () => ({ title: "land", instructions: "build", test: "approved-check", workspace: f.binding.root }),
      readText: () => null, git: { commit: port.commit, observe: async () => ({ ok: true as const,
        observation: { root: f.binding.root, entries: [{ path: "owned.txt", blobId: "f".repeat(40) }] } }) } });
    expect(await lander.landOnce()).toMatchObject([{ outcome: "LANDING_RECEIPT_INVALID" }]);
    expect(commits).toBe(1);
    expect(readRepositoryLandingEvidence(f.store, f.handle)).toMatchObject({ ok: true, completion: { commit: { sha: f.commit.sha } } });
    expect(readLandingReceipt(f.store, f.handle.owner.projectId,
      landingReceiptId(f.handle.owner.projectId, f.handle.owner.nodeRef, f.verified.receipt.receiptId))).toMatchObject({ ok: false, code: "LANDING_RECEIPT_NOT_FOUND" });
    expect(await lander.landOnce()).toMatchObject([{ outcome: "REPOSITORY_RECOVERY_REQUIRED" }]);
    expect(commits).toBe(1);
    expect(readLandingReceipt(f.store, f.handle.owner.projectId,
      landingReceiptId(f.handle.owner.projectId, f.handle.owner.nodeRef, f.verified.receipt.receiptId))).toMatchObject({ ok: false, code: "LANDING_RECEIPT_NOT_FOUND" });
  });
});
