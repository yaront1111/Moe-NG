import { decodeGraphContent, encodeGraphContent } from "@moe/scheduler";
import { afterEach, describe, expect, it } from "vitest";
import { closeStores, GOAL_ID, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit }
  from "../planning/plan-reject-test-fixtures.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { compiledPlanContext } from "./compiled-plan-context.js";

afterEach(closeStores);

function graph(goalRef = "goal-context", run = "run-context", duplicate = false, large = false): ActiveCompiledGraph {
  const criteria = ["criterion-a", "criterion-b", "criterion-phase", ...(large
    ? Array.from({ length: 160 }, (_, index) => `criterion-${index}-${"x".repeat(180)}`) : [])].sort();
  const compiled = compiledPlanAuthority({ authorRef: "context-author", completionNodeKey: "phase-check",
    criteria: criteria.map((criterionId) => ({ criterionId, statement: `Required ${criterionId}` })),
    graphRevisionRef: `graph-${run}`, idPrefix: run, knownCapabilities: null,
    nodes: [
      { nodeKey: "part-a", criterionIds: [criteria[0]!], dependsOn: [] },
      { nodeKey: "part-b", criterionIds: [...(duplicate ? [criteria[0]!] : []), criteria[1]!], dependsOn: ["part-a"] },
      { nodeKey: "phase-check", criterionIds: criteria.slice(2), dependsOn: ["part-b"] },
    ].map((node) => ({ ...node, criterionIds: [...node.criterionIds].sort(), capability: "implement", objective: `Implement ${node.nodeKey}`,
      readScopes: ["src"], writeScopes: ["src"], resources: ["resource"], verificationRecipeRefs: ["test"] })),
  });
  if (!compiled.ok) throw new Error(`${compiled.code}: ${compiled.detail}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("CONTEXT_GRAPH_FIXTURE_INVALID");
  return { content: decoded.value.content, goalRef, planningRunRef: run };
}

function mission(selected: ActiveCompiledGraph, others: readonly ActiveCompiledGraph[] = []) {
  const nodeRef = compiledExecutionRef(PROJECT_ID, selected, "part-a");
  const source = createCompiledNodeSource({ projectId: PROJECT_ID, store: openStore(),
    readActive: () => [...others, selected], workspace: "D:/private/context", testCommand: "pnpm test" });
  const brief = source.mission(nodeRef);
  expect(brief).not.toBeNull();
  return brief!.instructions;
}

function context(text: string): Record<string, unknown> {
  const json = text.split("BEGIN SEALED PLAN CONTEXT\n")[1]?.split("\nEND SEALED PLAN CONTEXT")[0];
  expect(json, "coding mission must include its sealed ownership/dependency context").toBeDefined();
  return JSON.parse(json!) as Record<string, unknown>;
}

describe("compiled coding ownership context", () => {
  it("serves the actual durable approved plan read-only, with every assigned criterion unchanged", () => {
    const store = boundWorld(); const ref = committedRevision(store); approveGate1(store, ref);
    const sealed = submit(store, ref, { structure: structureOf([
      nodeOf("api", ["crit-api"]), nodeOf("ui", ["crit-ui"], ["api"]),
    ], "ui") });
    if (!sealed.ok) throw new Error(sealed.code);
    const source = createCompiledNodeSource({ projectId: PROJECT_ID, store,
      workspace: "D:/private/context", testCommand: "pnpm test" });
    expect(source.nodes()).toEqual([]);
    approvePlan(store, sealed.runId);
    const horizon = store.readEventHorizon();
    const api = source.nodes().find((node) => node.title === "Land the api slice.");
    expect(api).toBeDefined();
    const brief = source.mission(api!.nodeRef)!;
    expect(context(brief.instructions)).toEqual({ advisoryOnly: true, completeness: "COMPLETE",
      goalRef: GOAL_ID, planningRunRef: sealed.runId, graphContentHash: sealed.graphContentHash,
      assignedNodeKey: "api", nodes: [
        { nodeKey: "api", criterionIds: ["crit-api"], dependsOn: [] },
        { nodeKey: "ui", criterionIds: ["crit-ui"], dependsOn: ["api"] },
      ] });
    expect(brief.instructions).toContain("- [crit-api]");
    expect(brief.instructions).not.toContain("- [crit-ui]");
    expect(brief.test).toBe("pnpm test");
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("carries all exact criterion owners and dependency directions from the selected sealed graph", () => {
    const selected = graph();
    const encoded = encodeGraphContent(selected.content);
    if (!encoded.ok) throw new Error("CONTEXT_GRAPH_FIXTURE_INVALID");
    expect(context(mission(selected))).toEqual({ advisoryOnly: true, completeness: "COMPLETE",
      goalRef: selected.goalRef, planningRunRef: selected.planningRunRef,
      graphContentHash: encoded.value.graphContentHash, assignedNodeKey: "part-a",
      nodes: [
        { nodeKey: "part-a", criterionIds: ["criterion-a"], dependsOn: [] },
        { nodeKey: "part-b", criterionIds: ["criterion-b"], dependsOn: ["part-a"] },
        { nodeKey: "phase-check", criterionIds: ["criterion-phase"], dependsOn: ["part-b"] },
      ] });
  });

  it("keeps reused keys in another goal or prior graph out of this node's context", () => {
    const selected = graph();
    const foreign = graph("foreign-goal", "foreign-run");
    const prior = graph(selected.goalRef, "older-run");
    const text = mission(selected, [foreign, prior]);
    expect(context(text)).toMatchObject({ goalRef: selected.goalRef, planningRunRef: selected.planningRunRef });
    expect(text).not.toContain("foreign-goal");
    expect(text).not.toContain("foreign-run");
    expect(text).not.toContain("older-run");
  });

  it("labels ambiguous criterion ownership unknown without emitting a partial map", () => {
    expect(context(mission(graph("goal-context", "run-context", true)))).toMatchObject({
      advisoryOnly: true, completeness: "UNKNOWN", reason: "CRITERION_OWNER_AMBIGUOUS", nodes: [],
    });
  });

  it("labels a missing run join unknown instead of claiming an approved complete map", () => {
    const selected = graph();
    const { planningRunRef: _run, ...missing } = selected;
    expect(context(mission(missing))).toMatchObject({ advisoryOnly: true, completeness: "UNKNOWN",
      reason: "SEALED_PLAN_IDENTITY_MISSING", nodes: [] });
  });

  it("bounds the entire ownership map without silently truncating owners or identifiers", () => {
    const text = mission(graph("goal-context", "run-context", false, true));
    expect(context(text)).toMatchObject({ advisoryOnly: true, completeness: "UNKNOWN",
      reason: "SEALED_PLAN_CONTEXT_TOO_LARGE", nodes: [] });
    expect(text.length).toBeLessThan(16_000);
  });

  it("does not expose rows for a missing node or corrupt sealed definition join", () => {
    const selected = graph();
    expect(compiledPlanContext(selected, "not-in-graph")).toMatchObject({ completeness: "UNKNOWN", nodes: [] });
    const missing = { ...selected, content: { ...selected.content, nodeAuthority: {
      ...selected.content.nodeAuthority, definitions: selected.content.nodeAuthority.definitions.slice(1),
    } } };
    expect(compiledPlanContext(missing, "part-a")).toMatchObject({ completeness: "UNKNOWN", nodes: [] });
  });

  it("freezes advisory rows without mutating the sealed source or exposing commands", () => {
    const selected = graph(); const before = JSON.stringify(selected);
    const result = compiledPlanContext(selected, "part-a");
    expect(result.completeness).toBe("COMPLETE");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodes)).toBe(true);
    expect(Object.isFrozen(result.nodes[0])).toBe(true);
    expect(Object.isFrozen(result.nodes[0]?.criterionIds)).toBe(true);
    expect(Object.isFrozen(result.nodes[0]?.dependsOn)).toBe(true);
    expect(result).not.toHaveProperty("nextAllowedCommands");
    expect(JSON.stringify(selected)).toBe(before);
  });
});
