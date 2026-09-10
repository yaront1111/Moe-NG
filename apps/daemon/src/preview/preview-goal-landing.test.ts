import { afterEach, describe, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";

afterEach(closeStores);

describe("preview landing scope", () => {
  it("reads the scoped landing while retaining graph-local names for the preview", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
    const ref = compiledExecutionRef(PROJECT_ID, graph, "node-a");
    seedReviewAcceptance(store, ref);
    seedLandingReceipt(store, ref, "COMMITTED");
    expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID))
      .toEqual({ allLanded: true, missing: [], nodes: ["node-a"] });
  });

  it("cannot use a bare legacy landing to approve a scoped preview", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    seedReviewAcceptance(store, "node-a");
    seedLandingReceipt(store, "node-a", "COMMITTED");
    expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID))
      .toEqual({ allLanded: false, missing: ["node-a"], nodes: ["node-a"] });
  });
});
