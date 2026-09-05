import { decodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { createRunsReadPort } from "../http/runs-read.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import { goalHasLandedCommit } from "../repository/goal-landing-facts.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { recordHistoricalCompiledGraph as history } from "./compiled-node-identity-test-fixtures.js";

afterEach(closeStores);

function graph(goalRef: string, keys: readonly string[] = ["api"], runRef = `run-${goalRef}`) {
  const compiled = compiledPlanAuthority({
    authorRef: "compiler", completionNodeKey: keys.at(-1) ?? "", criteria: [{ criterionId: "crit-1", statement: "Works." }],
    graphRevisionRef: `revision-${runRef}`, idPrefix: `identity-${runRef}`, knownCapabilities: null,
    nodes: keys.map((nodeKey, index) => ({
      capability: "implement", criterionIds: ["crit-1"], dependsOn: index === 0 ? [] : [keys[index - 1]!],
      nodeKey, objective: `Build ${nodeKey}.`, readScopes: ["src"], resources: ["resource"],
      verificationRecipeRefs: ["recipe"], writeScopes: ["src"],
    })),
  });
  if (!compiled.ok) throw new Error(compiled.code);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("fixture graph failed to decode");
  return { content: decoded.value.content, encoded: decoded.value, goalRef, planningRunRef: runRef };
}

function source(store: SqliteEventStore, active: readonly ActiveCompiledGraph[]) {
  return createCompiledNodeSource({ projectId: PROJECT_ID, readActive: () => active, store,
    testCommand: "pnpm test", workspace: "D:/product" });
}

function boundStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const result = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Build.", source: { displayPath: "prd.md", mediaType: "text/markdown", text: "# Product\nBuild it.\n" },
    title: "Identity proof",
  }, GOAL_CREATE_COMMAND_ID));
  if (!result.ok) throw new Error(result.code);
  return store;
}

describe("compiled bare node identities fail closed", () => {
  it("withholds both colliding goals and their dependent chain while keeping independent work", () => {
    const store = openStore();
    const nodes = source(store, [graph("goal-a", ["api", "client", "finish"]), graph("goal-b"), graph("goal-c", ["unique"])]);
    expect(nodes.nodes().map((node) => node.nodeRef)).toEqual(["unique"]);
    for (const key of ["api", "client", "finish"]) expect(nodes.mission(key)).toBeNull();
    expect(nodes.mission("unique")?.title).toBe("Build unique.");
  });

  it("offers no dependent work when an ambiguous producer already has a legacy acceptance", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    seedReviewAcceptance(store, "api");
    const nodes = source(store, [graph("goal-a", ["api", "client", "finish"]), graph("goal-b"), graph("goal-c", ["unique"])]);
    const surface = createAffordancePort({ mintId: () => "identity-offer", nodes: nodes.nodes, projectId: PROJECT_ID, store })
      .readSurface();
    if (!("steps" in surface)) throw new Error("surface refused");
    expect(surface.steps.filter((step) => step.kind === "node.deliver").map((step) => step.aggregateId)).toEqual(["unique"]);
  });

  it("retains ambiguity after the other goal becomes terminal", () => {
    const store = openStore();
    history(store, graph("old-goal"));
    expect(source(store, [graph("new-goal")]).nodes()).toEqual([]);
    expect(source(store, [graph("new-goal")]).mission("api")).toBeNull();
  });

  it("does not inherit a previous run's bare-key identity within the same goal", () => {
    const store = openStore();
    history(store, graph("same-goal", ["api"], "old-run"));
    expect(source(store, [graph("same-goal", ["api"], "new-run")]).nodes()).toEqual([]);
  });

  it("counts repeated observations of one activated run only once", () => {
    const store = openStore();
    const plan = graph("same-goal");
    history(store, plan);
    expect(source(store, [plan]).nodes().map((node) => node.nodeRef)).toEqual(["api"]);
  });

  it("withholds execution if a historical activated graph cannot be read", () => {
    const store = openStore();
    history(store, graph("old-goal"), true);
    expect(source(store, [graph("new-goal", ["unique"])]).nodes()).toEqual([]);
  });

  it("withholds execution if a historical run no longer belongs to its recorded goal", () => {
    const store = openStore();
    history(store, graph("old-goal", ["api"], "reused-run"));
    history(store, graph("other-goal", ["other"], "reused-run"));
    expect(source(store, [graph("new-goal", ["unique"])]).nodes()).toEqual([]);
  });

  it("withholds landing credit for a key also owned by a terminal goal", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    seedReviewAcceptance(store, "node-a");
    seedLandingReceipt(store, "node-a", "COMMITTED");
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(true);
    history(store, graph("old-goal", ["node-a"]));
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("keeps historical ambiguity visible on the goal's existing Runs view", () => {
    const store = boundStore();
    history(store, graph("old-goal"));
    const result = createRunsReadPort({ projectId: PROJECT_ID, readActive: () => [graph(GOAL_ID)], store })
      .readRuns({ goalRef: GOAL_ID });
    expect(result.outcome).toBe("RUNS");
    if (result.outcome !== "RUNS") throw new Error(result.code);
    expect(result.goals[0]?.nodes[0]).toMatchObject({ sharedKey: true, status: "UNATTRIBUTABLE" });
  });
});
