/**
 * The runs read over a REAL store: the goal side is the PRODUCTION `goal.create_with_source`
 * journey, the sealed graph the REAL compile. The per-node facts (claims, reviews, run,
 * clock) are injected so each status arm flips exactly one of them; the default readers are
 * exercised by the empty-world arm, which walks the real ledgers.
 */
import { randomUUID } from "node:crypto";
import { decodeGraphContent } from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import type { WorkClaimRecord } from "../work/work-claim-read-model.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import type { RecordDeployReceiptInput } from "../deployment/deploy-ledger.js";
import { DEPLOY_ENGINE_PRINCIPAL_ID, DEPLOY_RECEIPT_COMMAND_KIND, deployAggregateId, deployReceiptId }
  from "../deployment/deploy-receipt-contracts.js";
import { DEPLOY_TARGET_BOUND_EVENT, deployTargetAggregateId } from "../deployment/deploy-target-contracts.js";
import type { RunsView } from "./runs-read-contract.js";
import { createRunsReadPort } from "./runs-read.js";
import type { NodeReviewFacts, NodeReviews, RunsReadOptions } from "./runs-read.js";

const PRD = "# Run me\n\n## 11. Evidence\nRows are immutable.\n";
const NOW = "2026-09-02T20:00:00.000Z";
const ref = (key: string): string => compiledExecutionRef(PROJECT_ID, activeGraphFor(GOAL_ID), key);

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
function activeGraphFor(goalRef: string, keys: readonly [string, string] = ["node-a", "node-b"]): ActiveCompiledGraph {
  const [first, second] = keys;
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler", completionNodeKey: second,
    criteria: [
      { criterionId: "crit-1", statement: "Rows keep fields." },
      { criterionId: "crit-2", statement: "Rows cannot be edited." },
    ],
    graphRevisionRef: `graph-revision-${goalRef}`, idPrefix: `runs-test-${goalRef}`, knownCapabilities: null,
    nodes: [
      { capability: "capability-implement", criterionIds: ["crit-1"], dependsOn: [], nodeKey: first,
        objective: "Keep fields.", readScopes: ["src"], resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"], writeScopes: ["src/a"] },
      { capability: "capability-implement", criterionIds: ["crit-2"], dependsOn: [first], nodeKey: second,
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
  accepted: undefined, escalated: false, lineage: { unsuccessfulRounds: 0 }, replanned: false, rounds: [],
  unreadable: false, version: 0,
});

const deploymentBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const DEPLOY_SHA = "a".repeat(40);
function bindTarget(store: SqliteEventStore, environment: string, id: string, target: Record<string, unknown>): void {
  const aggregateId = deployTargetAggregateId(PROJECT_ID, environment), bytes = deploymentBytes(target);
  const committed = store.commitExpectedVersionDecision({
    commandKind: "deployment.set_target", committedResultBytes: bytes, correlationId: id, decidedAt: NOW,
    expectedVersion: store.getAggregateVersion(aggregateId), targetAggregateId: aggregateId,
    key: { commandId: id, principalId: "principal-1", projectId: PROJECT_ID },
    requestBytes: deploymentBytes({ kind: "deployment.set_target", payload: { environment, ...target } }),
    events: [{ eventId: `${id}-${DEPLOY_TARGET_BOUND_EVENT}`, eventType: DEPLOY_TARGET_BOUND_EVENT, payload: bytes }],
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}
function deployment(store: SqliteEventStore, environment: string, id: string, overrides: Partial<RecordDeployReceiptInput> = {}): void {
  expect(recordDeployReceipt(store, { projectId: PROJECT_ID, environment, decisionId: id, decidedAt: NOW,
    sha: DEPLOY_SHA, imageDigest: `sha256:${"b".repeat(64)}`, refusal: null, releaseDecision: null, url: null,
    ...overrides }).ok).toBe(true);
}
function deploymentRows(store: SqliteEventStore) {
  const view = runs(portFor(store).readRuns({ goalRef: GOAL_ID }));
  expect(view.goals.length).toBe(1);
  const rows = view.goals[0]?.deployments;
  expect(Array.isArray(rows)).toBe(true);
  if (rows === undefined) throw new Error("deployment array missing");
  return rows;
}
function malformedDeploymentTip(store: SqliteEventStore, environment: string): void {
  const receiptId = deployReceiptId(PROJECT_ID, environment, "malformed-newer"), aggregateId = deployAggregateId(PROJECT_ID, environment);
  const committed = store.commitExpectedVersionDecision({
    commandKind: DEPLOY_RECEIPT_COMMAND_KIND, committedResultBytes: deploymentBytes({}),
    correlationId: "malformed-newer", decidedAt: NOW, expectedVersion: store.getAggregateVersion(aggregateId),
    targetAggregateId: aggregateId, key: { commandId: receiptId, principalId: DEPLOY_ENGINE_PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: deploymentBytes({ receiptId }), events: [{ eventId: `${receiptId}-DeployRecorded`,
      eventType: "EnvironmentDeployed", payload: deploymentBytes({ environment, outcome: "DEPLOYED", receiptId, sha: DEPLOY_SHA }) }],
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

it("unions three durable environments with omitted missing facts and detached target copies", () => {
  const store = boundWorld();
  bindTarget(store, "alpha", "alpha-bind", { network: "alpha-net", sshTarget: null, url: "https://binding-only.example" });
  deployment(store, "bravo", "bravo-deploy", { url: "https://bravo.example" });
  bindTarget(store, "charlie", "charlie-bind", { network: "charlie-net", sshTarget: "operator@charlie.example", url: null });
  deployment(store, "charlie", "charlie-deploy");
  const rows = deploymentRows(store);
  expect([...rows].sort((a, b) => a.environment.localeCompare(b.environment))).toStrictEqual([
    { environment: "alpha", target: { network: "alpha-net" } },
    { environment: "bravo", sha: DEPLOY_SHA, time: NOW, url: "https://bravo.example", status: "DEPLOYED" },
    { environment: "charlie", target: { network: "charlie-net", host: "charlie.example" },
      sha: DEPLOY_SHA, time: NOW, status: "DEPLOYED" },
  ]);
  expect(Object.isFrozen(rows) && rows.every((row) => Object.isFrozen(row)
    && (row.target === undefined || Object.isFrozen(row.target)))).toBe(true);
  const again = deploymentRows(store);
  expect(again.find((row) => row.environment === "alpha")?.target)
    .not.toBe(rows.find((row) => row.environment === "alpha")?.target);
});

it.each(["DEPLOY_BUILD_FAILED", "DEPLOY_DOCKER_UNAVAILABLE", "DEPLOY_HEALTH_TIMEOUT", "DEPLOY_TARGET_MISSING"] as const)(
  "carries the durable refusal code verbatim: %s", (code) => {
    const store = boundWorld();
    deployment(store, "refused", "refused-deploy", { imageDigest: null,
      refusal: { code, detail: "not projected", layer: "DAEMON_DEPLOY_ENGINE" } });
    expect(deploymentRows(store)).toStrictEqual([{ environment: "refused", sha: DEPLOY_SHA, time: NOW, status: "REFUSED", code }]);
  },
);

it("takes the last durable receipt rather than the greatest timestamp", () => {
  const store = boundWorld(), earlier = "2026-09-01T00:00:00.000Z", replacement = "c".repeat(40);
  deployment(store, "updated", "old", { url: "https://old.example" });
  deployment(store, "updated", "new", { decidedAt: earlier, sha: replacement, url: "https://new.example" });
  expect(deploymentRows(store)).toStrictEqual([
    { environment: "updated", sha: replacement, time: earlier, url: "https://new.example", status: "DEPLOYED" },
  ]);
});

it("withholds target usernames, private fields, diagnostics and authenticated receipt URLs", () => {
  const store = boundWorld(), privateUser = randomUUID(), privateMarker = randomUUID();
  const authenticatedUrl = `https://${privateUser}:${privateMarker}@private.example`;
  const target = { network: "safe-net", sshTarget: `${privateUser}@safe.example`,
    url: "https://binding-only.example", privateField: privateMarker };
  const userinfo = /:\/\/[^/@\s"]+@/u;
  expect([userinfo.test(authenticatedUrl), JSON.stringify(target).includes(privateUser),
    JSON.stringify(target).includes(privateMarker)]).toEqual([true, true, true]);
  bindTarget(store, "guarded", "guarded-bind", target);
  deployment(store, "guarded", "guarded-refusal", { imageDigest: null, url: authenticatedUrl,
    refusal: { code: "DEPLOY_BUILD_FAILED", detail: privateMarker, layer: "DAEMON_DEPLOY_ENGINE" } });
  const rows = deploymentRows(store), wire = JSON.stringify(rows);
  // Boolean-only guard runs before structural assertions, so a regression cannot dump private values.
  expect(wire.includes(privateUser) || wire.includes(privateMarker) || userinfo.test(wire)).toBe(false);
  expect(rows).toStrictEqual([{ environment: "guarded", target: { network: "safe-net", host: "safe.example" },
    sha: DEPLOY_SHA, time: NOW, status: "REFUSED", code: "DEPLOY_BUILD_FAILED" }]);
});

it.each(["target", "newer receipt"] as const)("drops only the environment with a malformed %s", (mode) => {
  const store = boundWorld();
  deployment(store, "healthy", "healthy-receipt");
  deployment(store, "broken", "initial-valid-receipt");
  if (mode === "target") {
    bindTarget(store, "broken", "old-target", { network: "valid-net", sshTarget: null, url: null });
    bindTarget(store, "broken", "bad-target", { network: "invalid network", sshTarget: null, url: null });
  } else malformedDeploymentTip(store, "broken");
  expect(deploymentRows(store)).toStrictEqual([
    { environment: "healthy", sha: DEPLOY_SHA, time: NOW, status: "DEPLOYED" },
  ]);
});
const round = (route: string, number = 1): NodeReviewFacts["rounds"][number] =>
  ({ round: number, routing: { route } } as unknown as NodeReviewFacts["rounds"][number]);
const claim = (nodeKey: string, expiresAt: string, status: "OPEN" | "RELEASED" = "OPEN"): [string, WorkClaimRecord] =>
  [`node.deliver@${ref(nodeKey)}`, { claimedBy: "sess-wrap-1", expiresAt, status, version: 1, workItemId: `node.deliver@${ref(nodeKey)}` }];
const reviewsOf = (
  facts: Record<string, NodeReviewFacts>, receipts: NodeReviews["receipts"] = new Map(),
  landings: NodeReviews["landings"] = new Map(),
) =>
  (_s: unknown, _p: unknown, keys: ReadonlySet<string>): NodeReviews => {
    const scoped = new Map(Object.entries(facts).map(([key, value]) => [ref(key), value]));
    return { landings: new Map([...landings].map(([key, value]) => [ref(key), value])),
      ledgers: new Map([...keys].map((key) => [key, scoped.get(key) ?? quiet])),
      receipts: new Map([...receipts].map(([key, value]) => [ref(key), value])) };
  };

function portFor(store: SqliteEventStore, overrides: Partial<RunsReadOptions> = {}) {
  return createRunsReadPort({
    clock: () => NOW,
    projectId: PROJECT_ID,
    readActive: () => [activeGraphFor(GOAL_ID)],
    readClaims: () => new Map(),
    readReviews: reviewsOf({}),
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
  it("always serves the deployment roster even when nothing is configured", () => {
    const view = runs(createRunsReadPort({ projectId: PROJECT_ID, store: boundWorld() }).readRuns({}));
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0]).toHaveProperty("deployments", []);
  });

  it("carries the receipt's tested tree identity without exposing its internal binding", () => {
    const store = boundWorld();
    const receipt = { byteCount: 2, evidenceSha256: "e".repeat(64), exitCode: 0 as const,
      outputSha256: "a".repeat(64), test: "node check.mjs", workspace: "/project",
      workspaceBinding: { version: "moe-verified-workspace/1" as const, root: "/project", branchRef: "refs/heads/main",
        headSha: "a".repeat(40), treeSha: "b".repeat(40), dirtySha256: "c".repeat(64) } };
    const view = runs(portFor(store, { readReviews: reviewsOf({}, new Map([["node-a", receipt]])) }).readRuns({}));
    expect(view.goals[0]?.nodes[0]?.receipt).toEqual({ byteCount: 2, exitCode: 0, outputSha256: "a".repeat(64),
      test: "node check.mjs", testedTreeSha: "b".repeat(40), workspace: "/project" });
  });
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
    expect(goal?.nodes.map((node) => [node.nodeKey, node.objective, node.criterionIds, node.dependsOn, node.status, node.sharedKey]))
      .toEqual([
        ["node-a", "Keep fields.", ["crit-1"], [], "READY", false],
        ["node-b", "Refuse edits.", ["crit-2"], ["node-a"], "READY", false],
      ]);
    expect(goal?.run).toEqual({ approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: expect.any(String) });
    expect(goal?.nodes[0]?.review.findings).toEqual([]);
    expect(goal?.nodes[0]?.receipt).toBeNull();
    expect(runs(portFor(store).readRuns({})).totals).toMatchObject({ READY: 2, nodes: 2 });
  });

  it("derives each status from one fact, in the documented order", () => {
    const store = boundWorld();
    const accepted: NodeReviewFacts = {
      ...quiet, accepted: { policyDecision: "ALLOW", reviewInputDigest: "r", reviewerCalibrationDigest: "c", verifierReceiptId: "receipt-a", verifierReceiptSha256: "s" },
      rounds: [round("ACCEPT")], version: 3,
    };
    const receipt = { byteCount: 120, evidenceSha256: "e".repeat(64), exitCode: 0 as const, outputSha256: "o".repeat(64), test: "pnpm test", workspace: "D:/unai" };
    let view = runs(portFor(store, {
      readReviews: reviewsOf({ "node-a": accepted, "node-b": { ...quiet, rounds: [round("ACCEPT")], version: 1 } }, new Map([["node-a", receipt]])),
    }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.accepted, node.review.latestRoute])).toEqual([
      ["node-a", "ACCEPTED", { verifierReceiptId: "receipt-a" }, "ACCEPT"],
      ["node-b", "DELIVERED", null, "ACCEPT"],
    ]);
    expect(view.goals[0]?.nodes[0]?.receipt).toEqual({ byteCount: 120, exitCode: 0, outputSha256: "o".repeat(64), test: "pnpm test", testedTreeSha: null, workspace: "D:/unai" });
    const rejected: NodeReviewFacts = {
      ...quiet, lineage: {
        records: [
          { finding: { detail: "Tests fail on empty input.", ruleId: "verifier-test-failed", severity: "MAJOR", subject: { kind: "NODE", locator: "node-b" } }, fingerprint: "f1", round: 1 },
          { finding: { detail: "Older finding.", ruleId: "rule-old", severity: "MINOR", subject: { kind: "NODE", locator: "node-b" } }, fingerprint: "f0", round: 0 },
        ],
        unsuccessfulRounds: 1,
      },
      rounds: [round("REJECT_IMPLEMENTATION", 1)], version: 1,
    };
    view = runs(portFor(store, {
      readClaims: () => new Map([claim("node-a", "2026-09-02T21:00:00.000Z")]),
      readReviews: reviewsOf({ "node-b": rejected }),
    }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.claim?.active ?? null, node.review.latestRoute])).toEqual([
      ["node-a", "IN_PROGRESS", true, null],
      ["node-b", "READY", null, "REJECT_IMPLEMENTATION"],
    ]);
    // Only the latest round's findings travel, in the reviewer's words.
    expect(view.goals[0]?.nodes[1]?.review.findings).toEqual([{
      detail: "Tests fail on empty input.", round: 1, ruleId: "verifier-test-failed", severity: "MAJOR", subject: "NODE node-b",
    }]);
    const exhausted: NodeReviewFacts = { ...quiet, lineage: { unsuccessfulRounds: 3 }, rounds: [round("REJECT_PLAN"), round("REJECT_PLAN"), round("ESCALATE")], version: 3 };
    view = runs(portFor(store, {
      readReviews: reviewsOf({ "node-a": exhausted, "node-b": { ...exhausted, escalated: true } }),
    }).readRuns({}));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.review.unsuccessfulRounds])).toEqual([
      ["node-a", "ESCALATION_REQUIRED", 3], ["node-b", "ESCALATED", 3],
    ]);
    // A REPLAN decision retires the node: its own status, counted in the totals.
    view = runs(portFor(store, {
      readReviews: reviewsOf({ "node-a": { ...exhausted, escalated: true, replanned: true } }),
    }).readRuns({}));
    expect(view.goals[0]?.nodes[0]?.status).toBe("REPLANNED");
    expect(view.totals).toMatchObject({ ESCALATED: 0, REPLANNED: 1 });
    view = runs(portFor(store, { readReviews: reviewsOf({ "node-a": { ...quiet, unreadable: true }, "node-b": { ...quiet, unreadable: true } }) }).readRuns({}));
    expect(view.goals[0]?.nodes.every((node) => node.status === "BLOCKED")).toBe(true);
    expect(view.totals).toMatchObject({ BLOCKED: 2, READY: 0 });
  });

  it("attributes scoped facts when another activated plan carries the same local key", () => {
    const store = boundWorld();
    const accepted: NodeReviewFacts = {
      ...quiet, accepted: { policyDecision: "ALLOW", reviewInputDigest: "r", reviewerCalibrationDigest: "c", verifierReceiptId: "receipt-a", verifierReceiptSha256: "s" },
      rounds: [round("ACCEPT")], version: 3,
    };
    // A second goal's plan (not selected, even a closed one) reuses "node-a": the review
    // ledger for "node-a" could be either plan's, so the acceptance is not this goal's fact.
    const view = runs(portFor(store, {
      readActive: () => [activeGraphFor(GOAL_ID), activeGraphFor("goal-other", ["node-a", "node-z"])],
      readReviews: reviewsOf({ "node-a": accepted }),
    }).readRuns({ goalRef: GOAL_ID }));
    expect(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.status, node.sharedKey, node.accepted !== null])).toEqual([
      ["node-a", "ACCEPTED", false, true],
      ["node-b", "READY", false, false],
    ]);
    expect(view.totals).toMatchObject({ ACCEPTED: 1, UNATTRIBUTABLE: 0, nodes: 2 });
    // Control: the same acceptance with a unique key IS this goal's.
    const unique = runs(portFor(store, { readReviews: reviewsOf({ "node-a": accepted }) }).readRuns({ goalRef: GOAL_ID }));
    expect(unique.goals[0]?.nodes[0]?.status).toBe("ACCEPTED");
  });

  it("carries the verifier's real receipt and a clean round through the default review reader", () => {
    const store = boundWorld();
    // The daemon's own receipt production: a clean round, then the receipt decision on the node.
    seedVerifierReceipt(store, ref("node-a"), PROJECT_ID);
    const view = runs(createRunsReadPort({
      clock: () => NOW, projectId: PROJECT_ID, readActive: () => [activeGraphFor(GOAL_ID)], readClaims: () => new Map(),
      readRun: (_s, _p, runId) => ({ acceptance: null, approval: "BOUND", authority: null, lifecycle: "ACTIVATED", outcome: "RUN", plan: null, reviewable: false, runId, submissionHash: "h" }),
      store,
    }).readRuns({}));
    const node = view.goals[0]?.nodes[0];
    expect(node?.status).toBe("DELIVERED");
    expect(node?.review).toMatchObject({ findings: [], latestRoute: "ACCEPT", rounds: 1 });
    expect(node?.receipt).toEqual({ byteCount: 2, exitCode: 0, outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/u), test: "pnpm test", testedTreeSha: null, workspace: "/fixture-workspace" });
    expect(node?.landing).toBeNull();
  });

  it("carries the lander's receipt per node: a commit's sha, branch and files, or a refusal code", () => {
    const store = boundWorld();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const landed = (outcome: "COMMITTED" | "REFUSED") => ({
      commit: outcome === "COMMITTED"
        ? { branch: "main", files: ["src/a.ts", "src/a.test.ts"], message: "Land\n", parentSha: null, sha } : null,
      decidedAt: NOW, outcome, projectId: PROJECT_ID, receiptId: "r".repeat(64),
      refusal: outcome === "REFUSED" ? { code: "NOTHING_TO_COMMIT", detail: "" } : null,
      subjectRef: "node-a", verifierReceiptId: "v".repeat(64), version: "moe-landing-receipt/1" as const,
      workspace: "/fixture-workspace",
    });
    const view = runs(portFor(store, {
      readReviews: reviewsOf({}, new Map(), new Map([["node-a", landed("COMMITTED")], ["node-b", landed("REFUSED")]])),
    }).readRuns({}));
    const byKey = new Map(view.goals[0]?.nodes.map((node) => [node.nodeKey, node.landing]));
    expect(byKey.get("node-a")).toEqual({ branch: "main", code: null, files: ["src/a.ts", "src/a.test.ts"], outcome: "COMMITTED", sha });
    expect(byKey.get("node-b")).toEqual({ branch: null, code: "NOTHING_TO_COMMIT", files: [], outcome: "REFUSED", sha: null });
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
