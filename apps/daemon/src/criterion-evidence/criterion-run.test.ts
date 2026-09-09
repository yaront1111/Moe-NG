import { afterEach, describe, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { criterionCatalogId, criterionRunsId } from "./criterion-storage.js";

afterEach(closeStores);
const artifact = { root: "D:\\fixture", sha: "1".repeat(40), treeSha: "2".repeat(40) };
describe("criterion verification queue", () => {
  it("offers current catalog versions and queues the exact complete approved criterion roster", () => {
    const { service, store, approveAll, verifyInput } = criterionWorld({ readIntegrated: () => artifact });
    expect(service.read(GOAL_ID)).toMatchObject({ outcome: "CRITERION_EVIDENCE", verifyOffer: null,
      criteria: [{ approveOffer: { expectedVersion: 0 } }, { approveOffer: { expectedVersion: 0 } }] });
    approveAll();
    expect(service.read(GOAL_ID)).toMatchObject({ verifyOffer: { expectedVersion: 0,
      targetAggregateId: criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID) },
      criteria: [{ approveOffer: { expectedVersion: 2 } }, { approveOffer: { expectedVersion: 2 } }] });
    const input = verifyInput(artifact.sha);
    expect(service.verify(input)).toMatchObject({ ok: true, disposition: "DECIDED" });
    expect(service.verify(input)).toMatchObject({ ok: true, disposition: "REPLAYED" });
    expect(store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(1);
    expect(store.getAggregateVersion(criterionCatalogId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(2);
    expect(service.read(GOAL_ID)).toMatchObject({ verifyOffer: null, run: { status: "QUEUED", integratedSha: artifact.sha } });
  });
  it("refuses stale check selection, duplicate criterion ids, and caller-provided passing outcomes", () => {
    const { service, approveAll, verifyInput } = criterionWorld({ readIntegrated: () => artifact }); approveAll();
    const input = verifyInput(artifact.sha);
    for (const approvals of [[input.payload.approvals[0]], [input.payload.approvals[0], input.payload.approvals[0]],
      input.payload.approvals.map((row) => ({ ...row, approvalId: "other" }))]) {
      expect(service.verify({ ...input, payload: { ...input.payload, approvals } })).toMatchObject({ ok: false, code: "CRITERION_CHECK_APPROVAL_REQUIRED" });
    }
    expect(service.verify({ ...input, payload: { ...input.payload, status: "PASSED" } })).toMatchObject({ ok: false, code: "CRITERION_CHECK_MALFORMED" });
  });
  it("requires all durable landings and the unchanged final integrated SHA before queueing", () => {
    const { service, approveAll, verifyInput } = criterionWorld(); approveAll();
    expect(service.verify(verifyInput(artifact.sha))).toMatchObject({ ok: false, code: "CRITERION_CHECK_INTEGRATED_ARTIFACT_CHANGED" });
    const other = criterionWorld({ readIntegrated: () => artifact }); other.approveAll();
    expect(other.service.verify(other.verifyInput("a".repeat(40)))).toMatchObject({ ok: false, code: "CRITERION_CHECK_INTEGRATED_ARTIFACT_CHANGED" });
  });
});
