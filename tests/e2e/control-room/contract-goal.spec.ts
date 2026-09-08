import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { readCriterionGoal } from "../../../apps/daemon/src/criterion-evidence/criterion-goal.js";
import { activeCompiledGraphs } from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { readReleaseDossierInput } from "../../../apps/daemon/src/release/release-durable-facts.js";
import { withStore } from "../foundation/multi-node-reads.js";
import { createLaneScratch, laneWorkspaceIdentity, lanePids, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import { resolveLaneScratch } from "./wrapper-lane.js";
import { multiNodeSeatDouble, prepareMultiNodeWorkspace } from "./lane-multi-node-workspace.js";
import { createLaneContractGoal } from "./lane-contract-goal.js";

/** The lifecycles `readCriterionGoal` itself considers; stated once so both arms read alike. */
const READABLE_LIFECYCLES = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);

test("multi-node workspace commits tests, leaving implementation to the mission's seat", () => {
  const scratch = createLaneScratch(true);
  const keys = ["alpha-lane", "beta-lane", "omega-lane"];
  try {
    const workspaces = prepareMultiNodeWorkspace(scratch.workspace, keys);
    expect(Object.keys(workspaces)).toEqual(keys);
    expect(laneWorkspaceIdentity(scratch.root)?.sha).not.toBe(scratch.workspaceSha);
    for (const key of keys) {
      expect(existsSync(join(scratch.workspace, key, "test.mjs"))).toBe(true);
      expect(existsSync(join(scratch.workspace, key, "math.mjs"))).toBe(false);
    }
    const seat = multiNodeSeatDouble(scratch.root, scratch.workspace, keys);
    expect(seat.command).toBe(join(scratch.root,
      process.platform === "win32" ? "multi-node-seat.cmd" : "multi-node-seat.sh"));
    for (const extension of ["js", "cmd", "sh"]) {
      expect(existsSync(join(scratch.root, `multi-node-seat.${extension}`))).toBe(true);
    }
    for (const key of keys) {
      execFileSync(process.execPath, [join(scratch.root, "multi-node-seat.js")],
        { cwd: scratch.workspace, input: `Implement ${key}/math.mjs` });
      expect(readFileSync(join(scratch.workspace, key, "math.mjs"), "utf8")).toContain("export");
      expect(execFileSync(process.execPath, [`${key}/test.mjs`],
        { cwd: scratch.workspace, encoding: "utf8" })).toContain("math.mjs passes");
    }
  } finally {
    rmSync(scratch.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("contract lane drives a goal to contract-bound, criterion-verified and landed", async () => {
  test.setTimeout(900_000);
  const outcome = await withDaemonBackedControlRoom({ liveCredentials: "ABSENT", fakeGh: "SUCCESS" }, async (lane) => {
    const goal = await createLaneContractGoal(lane);
    expect(goal.runId).toMatch(/^run-/u);
    const [alpha, beta, omega] = ["alpha", "beta", "omega"].map((key) => `node-${key}-${lane.projectId}`);
    expect(goal.nodes).toEqual([
      { nodeKey: alpha, goalRef: goal.goalRef, dependsOn: [] },
      { nodeKey: beta, goalRef: goal.goalRef, dependsOn: [] },
      { nodeKey: omega, goalRef: goal.goalRef, dependsOn: [alpha, beta] },
    ]);
    expect(goal.wrapperPids).toHaveLength(4);
    for (const key of [alpha, beta, omega]) {
      expect(existsSync(join(lane.workspace, key!, "math.mjs"))).toBe(true);
    }
    // DoD 3. The commit the LANDER actually made for this goal's nodes, read back off git,
    // not parsed from a transcript — and it has to have moved off the lane's own baseline.
    expect(goal.landedSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(goal.landedSha).not.toBe(lane.workspaceSha);
    // DoD 1, read through the PRODUCTION readers rather than through anything this lane wrote.
    // Both are pure reads over the daemon's own store; nothing here seeds a durable fact.
    const read = withStore(goal.scratch, (store) => ({
      criterion: readCriterionGoal(store, lane.projectId, goal.goalRef),
      dossier: readReleaseDossierInput(store, lane.projectId, goal.goalRef),
    }));
    expect(read.criterion.ok ? "ok" : read.criterion.code).toBe("ok");
    expect(read.dossier).not.toBeNull();
    expect(read.dossier?.criteria.map((row) => row.criterionId)).toEqual(["criterion-0", "criterion-1", "criterion-2"]);
    // NO GAPS: the coverage denominator is the criteria count, and every one of them is VERIFIED.
    expect(goal.coverage).toEqual({ criteria: 3, planned: 0, verified: 3 });
    expect(goal.criterionStatuses).toEqual(["VERIFIED", "VERIFIED", "VERIFIED"]);
    return [...lanePids(lane), ...goal.wrapperPids];
  });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (outcome.ok) expect(await survivingPids(outcome.value)).toEqual([]);
});

/**
 * DoD 4 — THE NEGATIVE THIS ROW EXISTS TO CLOSE, on a lane seeded ONLY by the shipped demo seed.
 *
 * That seed drives planning.create_draft/ready/claim/finalize_submission and never reaches
 * runSubmitDecomposition, the one place `compile-dispatcher.ts` mints the compiled contract
 * binding — so the criterion reader refuses. The refusal's CODE and its LAYER are both pinned:
 * "it failed" alone would stay green if some other layer started answering first.
 *
 * This runs on a DIFFERENT LANE from the positive arm above, not the same lane read twice —
 * `withDaemonBackedControlRoom` builds a fresh scratch, store and project id per call.
 */
test("the shipped-seed lane's goal is refused COMPILED_CONTRACT_BINDING_ABSENT at CRITERION_EVIDENCE", async () => {
  test.setTimeout(300_000);
  const outcome = await withDaemonBackedControlRoom({ liveCredentials: "ABSENT" }, async (lane) => {
    const scratch = resolveLaneScratch(lane);
    expect(scratch, "LANE_SCRATCH_UNRESOLVED").not.toBeNull();
    const store = SqliteEventStore.openForProject(scratch!.storePath, lane.projectId);
    try {
      // THE CASE WAS ACTUALLY GENERATED: a sweep that silently found no goal would pass here
      // if it only filtered, so the seeded roster is asserted by set-equality first.
      const graphs = activeCompiledGraphs(store, lane.projectId, READABLE_LIFECYCLES);
      expect(graphs.map((graph) => graph.goalRef)).toEqual(["goal-live-1"]);
      const goalRef = graphs[0]!.goalRef;
      expect(readCriterionGoal(store, lane.projectId, goalRef)).toEqual({
        ok: false, code: "COMPILED_CONTRACT_BINDING_ABSENT", layer: "CRITERION_EVIDENCE",
      });
      // The dossier reader is gated on the same binding, so it is inert on this lane too.
      expect(readReleaseDossierInput(store, lane.projectId, goalRef)).toBeNull();
    } finally { store.close(); }
    return lanePids(lane);
  });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (outcome.ok) expect(await survivingPids(outcome.value)).toEqual([]);
});
