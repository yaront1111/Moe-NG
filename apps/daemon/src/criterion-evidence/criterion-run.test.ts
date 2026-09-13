import { afterEach, describe, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { criterionCatalogId, criterionRunsId } from "./criterion-storage.js";
import { commitCriterionRecord } from "./criterion-storage.js";
import { queueAutomaticCriterionVerification, readCriterionRuns } from "./criterion-run.js";
import { readCriterionGoal } from "./criterion-goal.js";
import { CRITERION_PRINCIPAL } from "./criterion-contracts.js";

afterEach(closeStores);
const artifact = { root: "D:\\fixture", sha: "1".repeat(40), treeSha: "2".repeat(40) };
const NOW = "2026-09-06T00:00:00.000Z";
const queue = (world: ReturnType<typeof criterionWorld>, read = () => artifact) =>
  queueAutomaticCriterionVerification(world.store, PROJECT_ID, GOAL_ID, NOW, read);
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

describe("automatic criterion queue", () => {
  it("queues readable daemon evidence without granting the daemon human-command authority", () => {
    const world = criterionWorld({ readIntegrated: () => artifact }); world.approveAll();
    expect(world.service.verify({ ...world.verifyInput(artifact.sha), principalId: CRITERION_PRINCIPAL }))
      .toEqual({ ok: false, code: "CRITERION_CHECK_HUMAN_REQUIRED", layer: "CRITERION_EVIDENCE" });
    const result = queue(world);
    expect(result).toMatchObject({ ok: true, disposition: "DECIDED", resultCode: "CRITERION_CHECK_QUEUED" });
    expect(world.service.read(GOAL_ID)).toMatchObject({ outcome: "CRITERION_EVIDENCE", run: { status: "QUEUED" },
      criteria: [{ criterionId: "crit-api", approval: { approvalId: "approve-crit-api" } },
        { criterionId: "crit-ui", approval: { approvalId: "approve-crit-ui" } }] });
    const records = world.store.readAggregateEvents(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID), 0, 10);
    expect(records.items).toHaveLength(1);
    expect(records.items[0]?.decisionTrace).toMatchObject({ commandKind: "internal.criterion.queued", principalId: CRITERION_PRINCIPAL });
    expect(world.service.verify(world.verifyInput(artifact.sha)))
      .toEqual({ ok: false, code: "CRITERION_CHECK_RUN_PENDING", layer: "CRITERION_EVIDENCE" });
  });
  it("refuses an absent integrated artifact without writing a run", () => {
    const world = criterionWorld(); world.approveAll();
    expect(queueAutomaticCriterionVerification(world.store, PROJECT_ID, GOAL_ID, NOW, () => null))
      .toEqual({ ok: false, code: "CRITERION_CHECK_INTEGRATED_ARTIFACT_CHANGED", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(0);
  });
  it("refuses a missing approval independently of artifact availability", () => {
    const world = criterionWorld({ readIntegrated: () => artifact });
    expect(world.service.approve(world.approvalInput("crit-api", 0))).toMatchObject({ ok: true });
    expect(queue(world)).toEqual({ ok: false, code: "CRITERION_CHECK_APPROVAL_REQUIRED", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(0);
  });
  it.each(["QUEUED", "RUNNING", "BLOCKED", "COMPLETED"] as const)("does not requeue a %s run at the same artifact", (status) => {
    const world = criterionWorld({ readIntegrated: () => artifact }); world.approveAll();
    expect(queue(world)).toMatchObject({ ok: true });
    const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID); if (!goal.ok) throw new Error(goal.code);
    const run = readCriterionRuns(world.store, goal)?.[0]; if (run === undefined) throw new Error("missing run");
    const aggregateId = criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID);
    if (status !== "QUEUED") expect(commitCriterionRecord(world.store, PROJECT_ID, "internal.criterion.run", {
      commandId: `${run.runRef}-${status}`, correlationId: run.runRef, expectedVersion: 1,
      principalId: CRITERION_PRINCIPAL, payload: { status } }, aggregateId,
    `CriterionVerification${status}`, { ...run, status }, NOW)).toMatchObject({ ok: true });
    const version = world.store.getAggregateVersion(aggregateId);
    expect(queue(world)).toEqual({ ok: false, code: status === "COMPLETED"
      ? "CRITERION_CHECK_ALREADY_COMPLETED" : "CRITERION_CHECK_RUN_PENDING", layer: "CRITERION_EVIDENCE" });
    expect(readCriterionRuns(world.store, goal)).toHaveLength(1);
    expect(world.store.getAggregateVersion(aggregateId)).toBe(version);
    if (status === "COMPLETED") {
      expect(queue(world, () => ({ ...artifact, sha: "a".repeat(40) }))).toMatchObject({ ok: true });
      expect(readCriterionRuns(world.store, goal)).toHaveLength(2);
    }
  });
  it.each(["human", "automatic"] as const)("loses the run CAS to a competing %s queue", (producer) => {
    const world = criterionWorld({ readIntegrated: () => artifact }); world.approveAll();
    const result = queue(world, () => {
      expect(producer === "human" ? world.service.verify(world.verifyInput(artifact.sha)) : queue(world))
        .toMatchObject({ ok: true }); return artifact;
    });
    expect(result).toEqual({ ok: false, code: "CRITERION_CHECK_VERSION_CONFLICT", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(1);
  });
  it("pins the approval catalog version across the artifact read", () => {
    const world = criterionWorld({ readIntegrated: () => artifact }); world.approveAll();
    const result = queue(world, () => {
      expect(world.service.approve({ ...world.approvalInput("crit-api", 2, ["--help"]), commandId: "replacement" }))
        .toMatchObject({ ok: true }); return artifact;
    });
    expect(result).toEqual({ ok: false, code: "CRITERION_CHECK_VERSION_CONFLICT", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(0);
  });
  it("contains artifact-reader failures without writing an unreadable run", () => {
    const world = criterionWorld(); world.approveAll();
    for (const read of [() => { throw new Error("artifact unavailable"); }, () => ({ ...artifact, treeSha: "invalid" })]) {
      expect(queue(world, read)).toEqual({ ok: false, code: "CRITERION_CHECK_UNREADABLE", layer: "CRITERION_EVIDENCE" });
    }
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(0);
  });
  it("preserves the absent-goal refusal without adding a run", () => {
    const world = criterionWorld();
    // A goalRef no goal carries is ABSENT, not the UNBOUND the board renders as "no checks yet".
    expect(queueAutomaticCriterionVerification(world.store, PROJECT_ID, "missing-goal", NOW, () => artifact))
      .toEqual({ ok: false, code: "CRITERION_CHECK_GOAL_ABSENT", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(0);
  });
  it.each(["approvals", "runs"] as const)("refuses an unreadable %s catalog", (catalog) => {
    const world = criterionWorld(); world.approveAll();
    const aggregateId = (catalog === "approvals" ? criterionCatalogId : criterionRunsId)(PROJECT_ID, GOAL_ID, RUN_ID);
    expect(commitCriterionRecord(world.store, PROJECT_ID, "internal.criterion.corrupt", { commandId: "corrupt",
      correlationId: "corrupt", expectedVersion: world.store.getAggregateVersion(aggregateId), principalId: CRITERION_PRINCIPAL,
      payload: {} }, aggregateId, "CorruptCriterionRecord", {}, NOW)).toMatchObject({ ok: true });
    const runsId = criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID); const before = world.store.getAggregateVersion(runsId);
    expect(queue(world)).toEqual({ ok: false, code: "CRITERION_CHECK_UNREADABLE", layer: "CRITERION_EVIDENCE" });
    expect(world.store.getAggregateVersion(runsId)).toBe(before);
  });
});
