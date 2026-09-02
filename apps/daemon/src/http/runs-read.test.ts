/**
 * The runs read over a REAL store: the goal side is the PRODUCTION `goal.create_with_source`
 * journey, the sealed graph the REAL compile. The four per-node facts (claims, review,
 * run, clock) are injected so each status arm flips exactly one of them; the default
 * readers are exercised by the empty-world arm, which walks the real ledgers.
 */
import { decodeGraphContent } from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import type { WorkClaimRecord } from "../work/work-claim-read-model.js";
import type { RunsView } from "./runs-read-contract.js";
import { createRunsReadPort } from "./runs-read.js";
import type { NodeReviewFacts, RunsReadOptions } from "./runs-read.js";

const PRD = "# Run me\n\n## 11. Evidence\nRows are immutable.\n";
const NOW = "2026-09-02T20:00:00.000Z";

afterEach(closeStores);

function boundWorld(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Build this PRD.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Runs goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

/** node-a (crit-1) then node-b (crit-2, depends on node-a): the REAL compile. */
function activeGraphFor(goalRef: string): ActiveCompiledGraph {
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler", completionNodeKey: "node-b",
    criteria: [
      { criterionId: "crit-1", statement: "Rows keep fields." },
      { criterionId: "crit-2", statement: "Rows cannot be edited." },
    ],
    graphRevisionRef: "graph-revision-runs-1", idPrefix: "runs-test", knownCapabilities: null,
    nodes: [
      { capability: "capability-implement", criterionIds: ["crit-1"], dependsOn: [], nodeKey: "node-a",
        objective: "Keep fields.", readScopes: ["src"], resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"], writeScopes: ["src/a"] },
      { capability: "capability-implement", criterionIds: ["crit-2"], dependsOn: ["node-a"], nodeKey: "node-b",
        objective: "Refuse edits.", readScopes: ["src"], resources: ["resource-b"],
        verificationRecipeRefs: ["recipe-b"], writeScopes: ["src/b"] },
    ],
  });
  if (!compiled.ok) throw new Error(`fixture compile refused: ${compiled.code}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("fixture graph did not decode");
  return Object.freeze({ content: decoded.value.content, goalRef });
}

const quiet: NodeReviewFacts = Object.freeze({
  accepted: undefined, escalated: false, lineage: { unsuccessfulRounds: 0 }, rounds: [],
  unreadable: false, version: 0,
});
const round = (route: string): NodeReviewFacts["rounds"][number] =>
  ({ routing: { route } } as unknown as NodeReviewFacts["rounds"][number]);
const claim = (nodeKey: string, expiresAt: string, status: "OPEN" | "RELEASED" = "OPEN"): [string, WorkClaimRecord] =>
  [`node.deliver@${nodeKey}`, { claimedBy: "sess-wrap-1", expiresAt, status, version: 1, workItemId: `node.deliver@${nodeKey}` }];

function portFor(
  store: SqliteEventStore, overrides: Partial<RunsReadOptions> = {},
) {
  return createRunsReadPort({
    clock: () => NOW,
    projectId: PROJECT_ID,
    readActive: () => [activeGraphFor(GOAL_ID)],
    readClaims: () => new Map(),
    readReview: () => quiet,
    readRun: (_s, _p, runId) => ({
      acceptance: null, approval: "BOUND", authority: null, lifecycle: "ACTIVATED",
      outcome: "RUN", plan: null, reviewable: false, runId, submissionHash: "h",
    }),
    store,
    ...overrides,
  });
}

function runs(result: ReturnType<ReturnType<typeof portFor>["readRuns"]>): RunsView {
  if (result.outcome !== "RUNS") throw new Error(`expected RUNS, got ${result.code}`);
  return result;
}

describe("createRunsReadPort", () => {
  it("walks the real ledgers for a plain bound goal: no plan, no nodes, honest run", () => {
    const store = boundWorld();
    const view = runs(createRunsReadPort({ projectId: PROJECT_ID, store }).readRuns({}));
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0]).toMatchObject({ goalId: GOAL_ID, lifecycle: "DRAFT", nodes: [], title: "Runs goal" });
    // A goal nothing has planned yet has no readable run: null, never an invented lifecycle.
    expect(view.goals[0]?.run).toBeNull();
    expect(view.totals).toMatchObject({ goals: 1, nodes: 0 });
  });

  it("refuses an unknown goal and reads one goal by ref", () => {
    const store = boundWorld();
    expect(portFor(store).readRuns({ goalRef: "goal-never" })).toMatchObject({ code: "RUNS_READ_GOAL_UNKNOWN" });
    expect(runs(portFor(store).readRuns({ goalRef: GOAL_ID })).goals.map((goal) => goal.goalId)).toEqual([GOAL_ID]);
  });

  it("lists the sealed nodes in plan order with their criteria and dependencies", () => {
    const store = boundWorld();
    const [goal] = runs(portFor(store).readRuns({})).goals;
    expect(goal?.nodes.map((node) => [node.nodeKey, node.objective, node.criterionIds, node.dependsOn, node.status]))
      .toEqual([
        ["node-a", "Keep fields.", ["crit-1"], [], "READY"],
        ["node-b", "Refuse edits.", ["crit-2"], ["node-a"], "READY"],
      ]);
    expect(goal?.run).toEqual({ approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: expect.any(String) });
    expect(runs(portFor(store).readRuns({})).totals).toMatchObject({ READY: 2, nodes: 2 });
  });

  it("derives each status from one fact, in the documented order", () => {
    const store = boundWorld();
    const facts: Record<string, NodeReviewFacts> = {
      "node-a": { ...quiet, accepted: { policyDecision: "ALLOW", reviewInputDigest: "r", reviewerCalibrationDigest: "c", verifierReceiptId: "receipt-a", verifierReceiptSha256: "s" }, rounds: [round("ACCEPT")], version: 3 },
      "node-b": { ...quiet, rounds: [round("ACCEPT")], version: 1 },
    };
    let view = runs(portFor(store, { readReview: (_s, _p, nodeRef) => facts[nodeRef] ?? quiet }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.accepted, node.review.latestRoute])).toEqual([
      ["node-a", "ACCEPTED", { verifierReceiptId: "receipt-a" }, "ACCEPT"],
      ["node-b", "DELIVERED", null, "ACCEPT"],
    ]);
    const rejected: NodeReviewFacts = { ...quiet, lineage: { unsuccessfulRounds: 1 }, rounds: [round("REJECT_IMPLEMENTATION")], version: 1 };
    view = runs(portFor(store, {
      readClaims: () => new Map([claim("node-a", "2026-09-02T21:00:00.000Z")]),
      readReview: (_s, _p, nodeRef) => (nodeRef === "node-b" ? rejected : quiet),
    }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.claim?.active ?? null, node.review.latestRoute])).toEqual([
      ["node-a", "IN_PROGRESS", true, null],
      ["node-b", "READY", null, "REJECT_IMPLEMENTATION"],
    ]);
    const exhausted: NodeReviewFacts = { ...quiet, lineage: { unsuccessfulRounds: 3 }, rounds: [round("REJECT_PLAN"), round("REJECT_PLAN"), round("ESCALATE")], version: 3 };
    view = runs(portFor(store, {
      readReview: (_s, _p, nodeRef) => (nodeRef === "node-a" ? exhausted : { ...exhausted, escalated: true }),
    }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.review.unsuccessfulRounds])).toEqual([
      ["node-a", "ESCALATION_REQUIRED", 3], ["node-b", "ESCALATED", 3],
    ]);
    view = runs(portFor(store, { readReview: () => ({ ...quiet, unreadable: true }) }).readRuns({}));
    expect(view.goals[0]?.nodes.every((node) => node.status === "BLOCKED")).toBe(true);
    expect(view.totals).toMatchObject({ BLOCKED: 2, READY: 0 });
  });

  it("reports a claim as inactive once expired or released, at the daemon's clock", () => {
    const store = boundWorld();
    const expired = runs(portFor(store, {
      readClaims: () => new Map([claim("node-a", "2026-09-02T19:00:00.000Z")]),
    }).readRuns({}));
    expect(expired.goals[0]?.nodes[0]).toMatchObject({
      claim: { active: false, claimedBy: "sess-wrap-1", status: "OPEN" }, status: "READY",
    });
    const released = runs(portFor(store, {
      readClaims: () => new Map([claim("node-a", "2026-09-02T21:00:00.000Z", "RELEASED")]),
    }).readRuns({}));
    expect(released.goals[0]?.nodes[0]).toMatchObject({ claim: { active: false, status: "RELEASED" }, status: "READY" });
  });

  it("carries a refused planning-run read as a null run and a thrown walk as UNREADABLE", () => {
    const store = boundWorld();
    const view = runs(portFor(store, {
      readRun: () => ({ code: "PLANNING_RUN_READ_RUN_UNKNOWN", layer: "PLANNING_RUN_READ", outcome: "REFUSED" }),
    }).readRuns({}));
    expect(view.goals[0]?.run).toBeNull();
    expect(portFor(store, { readActive: () => { throw new Error("walk exploded"); } }).readRuns({}))
      .toEqual({ code: "RUNS_READ_UNREADABLE", layer: "RUNS_READ", outcome: "REFUSED" });
  });
});
