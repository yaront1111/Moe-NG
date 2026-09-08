import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { laneWorkspaceIdentity } from "./daemon-ports.js";
import { approveAndRunCriteria, closeCompletedGoal } from "../foundation/multi-node-criteria.js";
import type { MultiNodeScratch } from "../foundation/multi-node-graph-harness.js";
import { multiNodeIdentity } from "../foundation/multi-node-identity.js";
import type { MultiNodeIdentity } from "../foundation/multi-node-identity.js";
import { sealMultiNodeGraph } from "../foundation/multi-node-journey.js";
import { closeReadiness, delivered, executionRefFor, goalAggregates, landedCommits, readCoverage,
  sealedNodes, withStore } from "../foundation/multi-node-reads.js";
import type { CoverageTotals, SealedNodeView } from "../foundation/multi-node-reads.js";
import { daemonWire, command, readSurface, send, stepFor } from "../foundation/multi-node-wire.js";
import { multiNodeSeatDouble, prepareMultiNodeWorkspace } from "./lane-multi-node-workspace.js";
import { resolveLaneScratch, startWrapper, wrapperEnv, WRAPPER_INTERVAL_MS } from "./wrapper-lane.js";
import { killTree, running } from "./daemon-children.js";
import { landLaneNode, LANDING_BUDGET_MS } from "./lane-landing.js";

/** Seat report only: the wrapper's verifier, not these shape-only claims, earns acceptance. */
async function submitRound(lane: DaemonLane, scratch: MultiNodeScratch, key: string): Promise<void> {
  const nodeRef = executionRefFor(scratch, key);
  const expectedVersion = withStore(scratch, (store) => store.getAggregateVersion(nodeRef));
  const digest = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
  const packageItems = ["CRITERION", "DAEMON_RECEIPT", "GRAPH_HASH", "INTEGRATED_TREE", "PLAN_HASH", "RUBRIC"]
    .map((kind) => ({ kind, locator: `${kind}-${nodeRef}`, digest: digest(`${kind}:${nodeRef}`) }));
  packageItems.push({ kind: "SUBMITTED_BYTES", locator: `${key}/math.mjs`,
    digest: digest(readFileSync(join(scratch.workspace, key, "math.mjs"), "utf8")) });
  await send(daemonWire(lane.daemonOrigin, lane.credential, lane.csrfToken), command("lane-contract", {
    commandId: `lane-review-${nodeRef}`, commandKind: "review.submit", expectedVersion,
    targetAggregateId: nodeRef,
    payload: { findings: [], packageItems, round: expectedVersion + 1, subjectRef: nodeRef },
  }));
}

async function deliverPass(lane: DaemonLane, laneScratch: LaneScratch, scratch: MultiNodeScratch,
  keys: readonly string[], remaining: readonly string[]): Promise<{ key: string; pid: number }> {
  const seat = multiNodeSeatDouble(scratch.root, scratch.workspace, keys, true);
  const tracked: ChildProcess[] = [];
  const watched = startWrapper(lane.repoRoot, {
    ...wrapperEnv(laneScratch, seat.command, WRAPPER_INTERVAL_MS, true),
    MOE_WRAPPER_ONCE: "1", MOE_NODE_SPECS_DIR: "", MOE_NODE_WORKSPACE: scratch.workspace,
    MOE_NODE_TEST_COMMAND: "node test.mjs",
  }, tracked);
  try {
    const deadline = Date.now() + 60_000;
    while (!remaining.some((key) => delivered(scratch, key) !== null) && Date.now() < deadline
      && running(watched.child)) await delay(100);
    const written = remaining.filter((key) => delivered(scratch, key) !== null);
    assert.equal(written.length, 1, `SEAT_NEVER_WROTE_EXACTLY_ONE_NODE\n${watched.transcript()}`);
    const key = written[0]!;
    await submitRound(lane, scratch, key);
    writeFileSync(join(scratch.root, `${key}.reviewed`), "review recorded", "utf8");
    const committed = await watched.waitFor(/^\[lander\] (\S+): COMMITTED /mu, LANDING_BUDGET_MS);
    assert.equal(committed, executionRefFor(scratch, key), watched.transcript());
    assert.deepEqual(landedCommits(scratch, key), [`Moe landed node ${committed} after the daemon verified it.`]);
    assert.ok(watched.child.pid !== undefined);
    return { key, pid: watched.child.pid };
  } finally {
    for (const child of [...tracked].reverse()) { await killTree(child); assert.equal(running(child), false); }
  }
}

function laneIdentity(lane: DaemonLane): MultiNodeIdentity {
  const alpha = `node-alpha-${lane.projectId}`, beta = `node-beta-${lane.projectId}`;
  const omega = `node-omega-${lane.projectId}`;
  const keys = [alpha, beta, omega];
  return multiNodeIdentity({
    alpha, beta, omega, nodeKeys: keys, projectId: lane.projectId,
    operatorCredential: lane.credential, csrfToken: lane.csrfToken,
    goalCreateCommandId: `contract-${lane.projectId}`,
    criteria: keys.map((nodeKey, index) => ({ nodeKey, criterionId: `criterion-${index}`,
      statement: `${nodeKey}/math.mjs exports add and multiply and its own test passes.` })),
  });
}

async function deliverNodes(lane: DaemonLane, laneScratch: LaneScratch, scratch: MultiNodeScratch,
  identity: MultiNodeIdentity): Promise<readonly number[]> {
  const { alpha, beta, omega, nodeKeys: keys } = identity;
  const wire = daemonWire(lane.daemonOrigin, lane.credential, lane.csrfToken);
  const remaining = [...keys], pids: number[] = [];
  for (let pass = 0; pass < keys.length; pass++) {
    if (pass < 2) {
      assert.equal(delivered(scratch, omega), null);
      const surface = await readSurface(wire, lane.projectId);
      assert.equal(stepFor(surface, "node.deliver", executionRefFor(scratch, omega))?.["status"], "BLOCKED");
    }
    const result = await deliverPass(lane, laneScratch, scratch, keys, remaining);
    pids.push(result.pid);
    assert.ok(pass < 2 ? [alpha, beta].includes(result.key) : result.key === omega);
    remaining.splice(remaining.indexOf(result.key), 1);
    if (pass < 2) assert.equal(delivered(scratch, omega), null);
  }
  return pids;
}

/**
 * APPROVE EVERY CRITERION, VERIFY THEM AGAINST THE LANDED TREE, THEN CLOSE THE GOAL.
 *
 * `approveAndRunCriteria` opens `SqliteEventStore.openForProject` while the lane's daemon holds
 * the same file. That is the established WAL second-writer pattern `clearPause` in
 * `wrapper-lane.ts` already documents and relies on — not a hazard introduced here.
 *
 * The approvals, the verification offer and `goal.close` all ride the daemon's REAL HTTP edge
 * under the human session `sealMultiNodeGraph` opened. Only the criterion service's own
 * `advance()` runs in-process, exactly as the foundation journey runs it.
 */
async function verifyAndClose(lane: DaemonLane, scratch: MultiNodeScratch, identity: MultiNodeIdentity,
  runId: string): Promise<{ coverage: CoverageTotals; criterionStatuses: readonly string[] }> {
  const wire = daemonWire(lane.daemonOrigin, lane.credential, lane.csrfToken);
  const integratedSha = execFileSync("git", ["rev-parse", "HEAD"],
    { cwd: scratch.workspace, encoding: "utf8" }).trim();
  const evidence = await approveAndRunCriteria(scratch, wire, () => new Date().toISOString(), identity);
  assert.equal(evidence.planningRunRef, runId);
  assert.equal(evidence.criteria.length, identity.criteria.length);
  for (const row of evidence.criteria) {
    assert.equal(row.evidence?.status, "PASSED", JSON.stringify(row));
    assert.equal(row.evidence?.exitCode, 0, JSON.stringify(row));
    assert.equal(row.evidence?.sha, integratedSha, JSON.stringify(row));
  }
  const coverage = await readCoverage(wire, identity.goalId);
  assert.deepEqual(closeReadiness(scratch, identity.goalId), { criteria: identity.criteria.length, kind: "READY" });
  await closeCompletedGoal(scratch, wire, identity);
  assert.ok(goalAggregates(scratch).includes(identity.goalId));
  return { coverage: coverage.totals, criterionStatuses: coverage.criteria.map((row) => String(row["status"])) };
}

export interface LaneContractGoal {
  readonly coverage: CoverageTotals;
  readonly criterionStatuses: readonly string[];
  readonly goalRef: string;
  /**
   * DoD 3 — THE LANDED COMMIT OF *THIS* GOAL, read back off git after the last node landed.
   *
   * `landLaneNode` is composed below, but it lands the LEGACY graph and cannot be aimed at this
   * one: it calls `retireSpecNode` and then `laneCompiledNodeRef`, which resolve the lane's
   * SEEDED spec node, and it takes no goal or node argument. This goal is landed instead by the
   * SAME production lander, run by the real wrapper on each of the three delivery passes and
   * asserted there through `[lander] <ref>: COMMITTED` plus the lander's own commit message
   * (`landedCommits`). The sha here is the workspace head afterwards, read the way
   * `landLaneNode` reads its own — from the repository, never from a transcript.
   */
  readonly landedSha: string;
  readonly nodes: readonly SealedNodeView[];
  readonly runId: string;
  /** So a caller may open the daemon's store and read this goal with the production readers. */
  readonly scratch: MultiNodeScratch;
  readonly wrapperPids: readonly number[];
}

/** Requires the lane's existing release/deploy workspace configuration (e.g. fakeGh). */
export async function createLaneContractGoal(lane: DaemonLane): Promise<LaneContractGoal> {
  const laneScratch = resolveLaneScratch(lane);
  if (laneScratch === null) throw new Error("LANE_SCRATCH_UNRESOLVED");
  // landLaneNode targets the first (legacy) graph and retires its spec. Compose it BEFORE
  // adding the contract graph, not after criterion verification: an extra commit afterwards
  // would invalidate exact-SHA criterion evidence. The three passes below land OUR goal.
  const legacy = await landLaneNode(lane);
  assert.equal(legacy.ok, true, legacy.ok ? undefined : legacy.detail);
  assert.equal(execFileSync("git", ["status", "--porcelain"],
    { cwd: lane.workspace, encoding: "utf8" }), "", "legacy landing left a dirty baseline");
  const wrapperPids = legacy.wrapperPid === null ? [] : [legacy.wrapperPid];
  const identity = laneIdentity(lane);
  const { alpha, beta, omega, nodeKeys: keys } = identity;
  const scratch: MultiNodeScratch = {
    ...laneScratch, credential: lane.credential, specsDir: laneScratch.nodeSpecsDir,
    agentPidFile: join(laneScratch.root, "contract-agent.pid"),
    workspaces: prepareMultiNodeWorkspace(lane.workspace, keys),
  };
  const sealed = await sealMultiNodeGraph(scratch, lane.daemonOrigin,
    { nowIso: new Date().toISOString(), nowMs: Date.now() },
    { identity, preludeMode: "POLICY_VALIDATE_ONLY" });
  assert.match(sealed.runId, /^run-/u);
  const nodes = sealedNodes(scratch).filter((node) => node.goalRef === identity.goalId);
  assert.deepEqual(nodes, [
    { nodeKey: alpha, goalRef: identity.goalId, dependsOn: [] },
    { nodeKey: beta, goalRef: identity.goalId, dependsOn: [] },
    { nodeKey: omega, goalRef: identity.goalId, dependsOn: [alpha, beta] },
  ]);
  wrapperPids.push(...await deliverNodes(lane, laneScratch, scratch, identity));
  const landed = laneWorkspaceIdentity(laneScratch.root);
  assert.notEqual(landed, null, "the lane workspace head is unreadable after the three landings");
  assert.match(landed!.sha, /^[0-9a-f]{40}$/u);
  assert.notEqual(landed!.sha, lane.workspaceSha, "no node landed: the head never left the lane baseline");
  assert.notEqual(landed!.sha, legacy.sha, "this goal's nodes never landed: the head is still the legacy landing");
  const { coverage, criterionStatuses } = await verifyAndClose(lane, scratch, identity, sealed.runId);
  return { coverage, criterionStatuses, goalRef: identity.goalId, landedSha: landed!.sha,
    nodes, runId: sealed.runId, scratch, wrapperPids };
}
