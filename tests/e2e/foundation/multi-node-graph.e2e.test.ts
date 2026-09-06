/** Real HTTP planning, scoped agent processes, serial repository delivery, and criterion closure. */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { NODE_DELIVER_KIND } from "../../../apps/daemon/src/http/affordance-contract.js";
import { type J1Scratch, killTree, runWrapper, startDaemon } from "./j1-loop-harness.js";
import { ALPHA, BETA, CRITERIA, GOAL_ID, MULTI_NODE_KEYS, OMEGA, createMultiNodeScratch } from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { sealMultiNodeGraph } from "./multi-node-journey.js";
import { approveAndRunCriteria, closeCompletedGoal } from "./multi-node-criteria.js";
import { claimedWorkItems, closeReadiness, delivered, executionRefFor, goalAggregates,
  landedCommits, readCoverage, removeMultiNodeScratches, sealedNodes, withStore, workItemFor } from "./multi-node-reads.js";
import { daemonWire, readSurface, stepFor } from "./multi-node-wire.js";

// Select a separate guarded build without replacing a broker serving another caller.
vi.mock("../../../packages/runner/src/platform/windows/windows-broker-path.js", async (original) => {
  const actual = await original<{ resolveBrokerBinary(): unknown }>();
  return { ...actual, resolveBrokerBinary: () => process.env["MOE_TEST_APPROVED_BROKER"] ?? actual.resolveBrokerBinary() };
});
const JOURNEY_TIMEOUT_MS = 900_000;
const scratches: MultiNodeScratch[] = [];
afterAll(() => removeMultiNodeScratches(scratches));
const environment = (scratch: MultiNodeScratch, seats = 2) => ({ MOE_NODE_SPECS_DIR: "",
  MOE_NODE_WORKSPACE: scratch.workspace, MOE_NODE_TEST_COMMAND: "node test.mjs", MOE_WRAPPER_MAX_AGENTS: String(seats) });
function wrapperMustSucceed(label: string, run: { code: number | null; output: string }): void {
  if (run.code !== 0) throw new Error(`${label} exited ${String(run.code)}: ${run.output}`);
}
function dependsTokens(missing: unknown): readonly string[] {
  return (Array.isArray(missing) ? missing : []).filter((entry): entry is string =>
    typeof entry === "string" && entry.startsWith("depends:")).sort();
}

describe("one goal built to completion: a 3-node graph over real processes", () => {
  it("serializes independent nodes in one repository, withholds their consumer, and closes after exact criterion checks", async () => {
    const scratch = createMultiNodeScratch(); scratches.push(scratch);
    const daemon = await startDaemon(scratch, environment(scratch));
    const wire = daemonWire(daemon.origin, scratch.credential);
    try {
      const sealed = await sealMultiNodeGraph(scratch, daemon.origin, { nowIso: new Date().toISOString(), nowMs: Date.now() });
      expect(sealed.runId).toMatch(/^run-/u);
      expect(sealedNodes(scratch)).toEqual([
        { dependsOn: [], goalRef: GOAL_ID, nodeKey: ALPHA },
        { dependsOn: [], goalRef: GOAL_ID, nodeKey: BETA },
        { dependsOn: [ALPHA, BETA], goalRef: GOAL_ID, nodeKey: OMEGA },
      ]);
      const refs = Object.fromEntries(MULTI_NODE_KEYS.map((key) => [key, executionRefFor(scratch, key)]));
      const before = await readSurface(wire, scratch.projectId);
      for (const key of [ALPHA, BETA]) expect(stepFor(before, NODE_DELIVER_KIND, refs[key]!)?.["status"]).toBe("READY");
      expect(stepFor(before, NODE_DELIVER_KIND, refs[OMEGA]!)?.["status"]).toBe("BLOCKED");
      expect(dependsTokens(stepFor(before, NODE_DELIVER_KIND, refs[OMEGA]!)?.["missing"]))
        .toEqual([`depends:${refs[ALPHA]}`, `depends:${refs[BETA]}`].sort());

      const passes: { code: number | null; output: string }[] = [];
      for (let pass = 1; pass <= 2; pass++) {
        const run = await runWrapper(scratch, "multi-node", { environment: environment(scratch) });
        wrapperMustSucceed(`producer pass ${pass}`, run); passes.push(run);
        // Claims can precede a physical repository refusal. Spawned missions and committed
        // deliverables establish actual execution independently of those claim attempts.
        expect(run.output.match(/fake-agent: mission node=node:v1:/gu), run.output).toHaveLength(1);
        expect([ALPHA, BETA].filter((key) => delivered(scratch, key) !== null)).toHaveLength(pass);
        expect(delivered(scratch, OMEGA)).toBeNull();
        expect(claimedWorkItems(scratch)).not.toContain(workItemFor(refs[OMEGA]!));
      }
      const partial = await readCoverage(wire, GOAL_ID);
      expect(partial.totals).toEqual({ criteria: 3, planned: 1, verified: 0 });
      expect(partial.criteria.filter((row) => row["status"] === "EVIDENCE_REQUIRED")
        .map((row) => row["criterionId"]).sort()).toEqual(["crit-alpha", "crit-beta"]);
      expect(closeReadiness(scratch, GOAL_ID)).toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
      expect(stepFor(await readSurface(wire, scratch.projectId), NODE_DELIVER_KIND, refs[OMEGA]!)?.["status"]).toBe("READY");

      const third = await runWrapper(scratch, "multi-node", { environment: environment(scratch) });
      wrapperMustSucceed("consumer pass", third); passes.push(third);
      expect(third.output.match(/fake-agent: mission node=node:v1:/gu), third.output).toHaveLength(1);
      expect(delivered(scratch, OMEGA)).toContain('from "../node-alpha/math.mjs"');
      expect(delivered(scratch, OMEGA)).toContain('from "../node-beta/math.mjs"');
      for (const key of MULTI_NODE_KEYS) expect(landedCommits(scratch, key))
        .toEqual([`Moe landed node ${refs[key]} after the daemon verified it.`]);
      expect(goalAggregates(scratch)).toEqual([GOAL_ID]);
      expect([...new Set(sealedNodes(scratch).map((node) => node.goalRef))]).toEqual([GOAL_ID]);

      // All generic suites passed and all nodes landed; criterion authority is still absent.
      expect((await readCoverage(wire, GOAL_ID)).totals).toEqual({ criteria: 3, planned: 0, verified: 0 });
      expect(closeReadiness(scratch, GOAL_ID)).toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
      expect((await readSurface(wire, scratch.projectId)).nextAllowedCommands
        .map((offer) => offer["commandKind"])).not.toContain("goal.close");
      const integratedSha = execFileSync("git", ["-C", scratch.workspace, "rev-parse", "HEAD"],
        { encoding: "utf8", windowsHide: true }).trim();
      const evidence = await approveAndRunCriteria(scratch, wire, () => new Date().toISOString());
      expect(evidence.planningRunRef).toBe(sealed.runId);
      expect(evidence.contractRef).toEqual(sealed.gateRef);
      expect(evidence.integratedArtifact?.sha).toBe(integratedSha);
      expect(evidence.run).toMatchObject({ status: "COMPLETED", integratedSha });
      expect(evidence.criteria).toHaveLength(3);
      for (const row of evidence.criteria) expect(row.evidence).toMatchObject({ status: "PASSED",
        sha: integratedSha, treeSha: evidence.integratedArtifact?.treeSha, exitCode: 0 });
      const full = await readCoverage(wire, GOAL_ID);
      expect(full.totals).toEqual({ criteria: 3, planned: 0, verified: 3 });
      expect(full.criteria.map((row) => row["status"])).toEqual(CRITERIA.map(() => "VERIFIED"));
      expect(closeReadiness(scratch, GOAL_ID)).toEqual({ criteria: 3, kind: "READY" });
      await closeCompletedGoal(scratch, wire);
      expect(goalAggregates(scratch)).toEqual([GOAL_ID]);
      // eslint-disable-next-line no-console
      console.log(`MULTI-NODE PASS RECEIPT\n${passes.flatMap((pass) => pass.output.split("\n"))
        .filter((line) => /^\[(lander|verifier|wrapper)\]/u.test(line)).join("\n")}`);
    } finally { await killTree(daemon.child); }
  }, JOURNEY_TIMEOUT_MS);
});

it("one seat leaves the other independent node READY, offered and unclaimed", async () => {
  const scratch = createMultiNodeScratch(); scratches.push(scratch);
  const daemon = await startDaemon(scratch, environment(scratch, 1));
  const wire = daemonWire(daemon.origin, scratch.credential);
  try {
    await sealMultiNodeGraph(scratch, daemon.origin, { nowIso: new Date().toISOString(), nowMs: Date.now() });
    const refs = Object.fromEntries(MULTI_NODE_KEYS.map((key) => [key, executionRefFor(scratch, key)]));
    const pass = await runWrapper(scratch, "multi-node", { environment: environment(scratch, 1) });
    wrapperMustSucceed("one-seat pass", pass);
    const claimed = claimedWorkItems(scratch); expect(claimed).toHaveLength(1);
    expect([workItemFor(refs[ALPHA]!), workItemFor(refs[BETA]!)]).toContain(claimed[0]);
    const waiting = claimed[0] === workItemFor(refs[ALPHA]!) ? refs[BETA]! : refs[ALPHA]!;
    const surface = await readSurface(wire, scratch.projectId);
    expect(stepFor(surface, NODE_DELIVER_KIND, waiting)?.["status"]).toBe("READY");
    expect(surface.nextAllowedCommands.filter((offer) => offer["commandKind"] === "review.submit"
      && offer["targetAggregateId"] === waiting)).toHaveLength(1);
    const dependent = stepFor(surface, NODE_DELIVER_KIND, refs[OMEGA]!);
    expect(dependent?.["status"]).toBe("BLOCKED");
    expect(dependsTokens(dependent?.["missing"])).toEqual([`depends:${waiting}`]);
  } finally { await killTree(daemon.child); }
}, JOURNEY_TIMEOUT_MS);

it("uses a J1-shaped scratch with three module directories in one repository", () => {
  const scratch = createMultiNodeScratch(); scratches.push(scratch);
  const asJ1: J1Scratch = scratch;
  expect(asJ1.projectId).toBe(scratch.projectId);
  expect(Object.keys(scratch.workspaces).sort()).toEqual([...MULTI_NODE_KEYS].sort());
  expect(withStore(scratch, (store) => store.getAggregateVersion(GOAL_ID))).toBe(0);
});
