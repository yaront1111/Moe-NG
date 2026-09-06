import { afterEach, expect, it } from "vitest";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { readApprovedExecutionScope } from "../goals/goal-approved-execution-scope.js";
import { approvePlan, closeStores, nodeOf, PROJECT_ID, rejectedWorld, structureOf, submit }
  from "../planning/plan-reject-test-fixtures.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { activeCompiledGraphs } from "./compiled-node-source.js";

afterEach(closeStores);

it("reads the approved successor graph and execution scope after rejecting the initial plan", () => {
  const world = rejectedWorld("Split the implementation");
  expect(submit(world.store, world.ref, { structure: structureOf([
    nodeOf("revised-api", ["crit-api"]), nodeOf("revised-ui", ["crit-ui"], ["revised-api"]),
  ], "revised-ui") }).ok).toBe(true);
  expect(activeCompiledGraphs(world.store, PROJECT_ID)).toEqual([]);
  approvePlan(world.store, world.successorRunId);
  const graphs = activeCompiledGraphs(world.store, PROJECT_ID);
  expect(graphs).toHaveLength(1);
  const graph = graphs[0]!;
  expect(graph.planningRunRef).toBe(world.successorRunId);
  expect(graph.content.snapshot.nodes.filter((node) => node.executionBearing)
    .map((node) => node.nodeKey)).toEqual(["revised-api", "revised-ui"]);
  expect(readCriterionGoal(world.store, PROJECT_ID, world.goalId)).toMatchObject({
    ok: true, binding: { planningRunRef: world.successorRunId },
  });
  expect(readApprovedExecutionScope(world.store, PROJECT_ID, world.goalId)).toMatchObject({
    requiresFoundation: false,
    scope: ["revised-api", "revised-ui"].map((key) => compiledExecutionRef(PROJECT_ID, graph, key)),
  });
});
