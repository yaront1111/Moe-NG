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
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { recordLandingBaseline } from "../repository/landing-ledger.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { recordHistoricalCompiledGraph as history } from "./compiled-node-identity-test-fixtures.js";

afterEach(closeStores);

function graph(goalRef: string, keys: readonly string[] = ["api"], runRef = `run-${goalRef}`, objective = "Build") {
  const compiled = compiledPlanAuthority({
    authorRef: "compiler", completionNodeKey: keys.at(-1) ?? "", criteria: [{ criterionId: "crit-1", statement: "Works." }],
    graphRevisionRef: `revision-${runRef}`, idPrefix: `identity-${runRef}`, knownCapabilities: null,
    nodes: keys.map((nodeKey, index) => ({
      capability: "implement", criterionIds: ["crit-1"], dependsOn: index === 0 ? [] : [keys[index - 1]!],
      nodeKey, objective: `${objective} ${nodeKey}.`, readScopes: ["src"], resources: ["resource"],
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

describe("compiled execution identities are scoped", () => {
  it("executes both colliding goals with separate dependencies and missions", () => {
    const store = openStore();
    const nodes = source(store, [graph("goal-a", ["api", "client", "finish"]), graph("goal-b", ["api"], "run-goal-b", "Second goal builds"), graph("goal-c", ["unique"])]);
    const listed = nodes.nodes();
    expect(listed).toHaveLength(5);
    expect(new Set(listed.map((node) => node.nodeRef)).size).toBe(5);
    expect(listed.every((node) => /^node:v1:[0-9a-f]{64}$/u.test(node.nodeRef))).toBe(true);
    expect(listed.map((node) => node.dependsOn)).toEqual([[], [listed[0]!.nodeRef], [listed[1]!.nodeRef], [], []]);
    for (const key of ["api", "client", "finish"]) expect(nodes.mission(key)).toBeNull();
    expect(nodes.mission(listed[4]!.nodeRef)?.title).toBe("Build unique.");
    expect(nodes.mission(listed[3]!.nodeRef)?.title).toBe("Second goal builds api.");
  });

  it("offers no dependent work when an ambiguous producer already has a legacy acceptance", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    seedReviewAcceptance(store, "api");
    const nodes = source(store, [graph("goal-a", ["api", "client", "finish"]), graph("goal-b"), graph("goal-c", ["unique"])]);
    const surface = createAffordancePort({ mintId: () => "identity-offer", nodes: nodes.nodes, projectId: PROJECT_ID, store })
      .readSurface();
    if (!("steps" in surface)) throw new Error("surface refused");
    expect(surface.steps.filter((step) => step.kind === "node.deliver").map((step) => step.aggregateId))
      .toEqual([compiledExecutionRef(PROJECT_ID, graph("goal-c", ["unique"]), "unique")]);
  });

  it("does not confuse a terminal goal with a fresh scoped execution", () => {
    const store = openStore();
    history(store, graph("old-goal"));
    expect(source(store, [graph("new-goal")]).nodes()).toHaveLength(1);
    expect(source(store, [graph("new-goal")]).mission("api")).toBeNull();
  });

  it("does not inherit a previous run's bare-key identity within the same goal", () => {
    const store = openStore();
    history(store, graph("same-goal", ["api"], "old-run"));
    const old = source(store, [graph("same-goal", ["api"], "old-run")]).nodes()[0]!.nodeRef;
    const successor = source(store, [graph("same-goal", ["api"], "new-run")]).nodes()[0]!.nodeRef;
    expect(successor).not.toBe(old);
  });

  it("counts repeated observations of one activated run only once", () => {
    const store = openStore();
    const plan = graph("same-goal");
    history(store, plan);
    expect(source(store, [plan]).nodes().map((node) => node.nodeRef))
      .toEqual([compiledExecutionRef(PROJECT_ID, plan, "api")]);
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
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
    history(store, graph("old-goal", ["node-a"]));
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("keeps historical ambiguity visible on the goal's existing Runs view", () => {
    const store = boundStore();
    seedReviewAcceptance(store, "api");
    history(store, graph("old-goal"));
    const result = createRunsReadPort({ projectId: PROJECT_ID, readActive: () => [graph(GOAL_ID)], store })
      .readRuns({ goalRef: GOAL_ID });
    expect(result.outcome).toBe("RUNS");
    if (result.outcome !== "RUNS") throw new Error(result.code);
    expect(result.goals[0]?.nodes[0]).toMatchObject({ sharedKey: true, status: "UNATTRIBUTABLE" });
    expect(result.goals[0]?.nodes[0]?.accepted).toBeNull();
  });

  it("binds every identity dimension without ambiguous string concatenation", () => {
    const original = graph("goal-a", ["api"], "run-a");
    const ref = compiledExecutionRef(PROJECT_ID, original, "api");
    expect(compiledExecutionRef(PROJECT_ID, original, "api")).toBe(ref);
    const variants = [
      compiledExecutionRef("other-project", original, "api"),
      compiledExecutionRef(PROJECT_ID, { ...original, goalRef: "goal-b" }, "api"),
      compiledExecutionRef(PROJECT_ID, { ...original, planningRunRef: "run-b" }, "api"),
      compiledExecutionRef(PROJECT_ID, { ...original, content: { ...original.content, author: "changed-author" } }, "api"),
      compiledExecutionRef(PROJECT_ID, original, "client"),
    ];
    expect(new Set([ref, ...variants]).size).toBe(6);
    expect(compiledExecutionRef("a:b", { ...original, goalRef: "c" }, "api"))
      .not.toBe(compiledExecutionRef("a", { ...original, goalRef: "b:c" }, "api"));
  });

  it("reads one goal's scoped acceptance without granting its sibling any credit", () => {
    const store = boundStore();
    const own = graph(GOAL_ID);
    const other = graph("other-goal");
    const nodeRef = compiledExecutionRef(PROJECT_ID, own, "api");
    seedReviewAcceptance(store, nodeRef);
    const view = createRunsReadPort({ projectId: PROJECT_ID, readActive: () => [own, other], store })
      .readRuns({ goalRef: GOAL_ID });
    expect(view.outcome).toBe("RUNS");
    if (view.outcome !== "RUNS") throw new Error(view.code);
    expect(view.goals[0]?.nodes[0]).toMatchObject({ nodeKey: "api", nodeRef, status: "ACCEPTED", sharedKey: false });
    const nodes = source(store, [own, other]).nodes();
    expect(nodes).toHaveLength(2);
    expect(nodes[1]!.nodeRef).not.toBe(nodeRef);
    // The staffing surface additionally needs the real bootstrap admission substrate.
    const executionStore = openStore();
    driveThrough(executionStore, "goal.close");
    seedReviewAcceptance(executionStore, nodeRef);
    const surface = createAffordancePort({ mintId: () => "scoped-offer", nodes: () => nodes,
      projectId: PROJECT_ID, store: executionStore }).readSurface();
    if (!("steps" in surface)) throw new Error("surface refused");
    expect(surface.steps.filter((step) => step.kind === "node.deliver")
      .map((step) => [step.aggregateId, step.status])).toEqual([[nodeRef, "COMMITTED"], [nodes[1]!.nodeRef, "READY"]]);
  });

  it("credits one scoped landing to exactly its goal when both goals carry api", () => {
    const store = boundStore();
    const own = graph(GOAL_ID);
    const sibling = graph("goal-other");
    history(store, own, false, "EXECUTION_ENABLED");
    history(store, sibling, false, "EXECUTION_ENABLED");
    const ref = compiledExecutionRef(PROJECT_ID, own, "api");
    seedReviewAcceptance(store, ref);
    seedLandingReceipt(store, ref, "COMMITTED");
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(true);
    expect(goalHasLandedCommit(store, PROJECT_ID, sibling.goalRef)).toBe(false);
  });

  it("withholds legacy baseline bytes from a newly scoped attempt", () => {
    const store = openStore();
    expect(recordLandingBaseline(store, { entries: [], observedAt: "2026-09-05T12:00:00.000Z",
      projectId: PROJECT_ID, subjectRef: "api", workspace: "D:/product" }).ok).toBe(true);
    expect(source(store, [graph("goal-a")]).nodes()).toEqual([]);
  });

  it("withholds an old child even after its staffing record is retired", () => {
    const store = openStore();
    const fence = createAgentSessionFence({ isProcessAlive: () => true, projectId: PROJECT_ID, store });
    expect(fence.recordLiveChild({ childPid: 12345, claimAggregateVersion: 1,
      sessionId: "legacy-seat", workItemId: "node.deliver@api" })).toEqual([]);
    expect(source(store, [graph("goal-a")]).nodes()).toEqual([]);
    expect(fence.retireLiveChild("node.deliver@api")).toEqual([]);
    expect(source(store, [graph("goal-a")]).nodes()).toEqual([]);
  });
});
