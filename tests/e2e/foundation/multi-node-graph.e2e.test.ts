/**
 * A GOAL IS BUILT TO COMPLETION AS ONE GOAL — over REAL PROCESSES, with no fixtures.
 *
 * `daemon-main.ts` runs as its own OS process on an ephemeral port. The journey is driven over
 * that daemon's OWN HTTP routes with the SHIPPED command kinds. `agent-wrapper-main.ts` runs
 * as its own process and hosts the REAL MCP server; the scripted seat double talks to it over
 * the REAL MCP wire, learning which node it is on from the mission and nothing else.
 *
 * WHAT THIS TURNS INTO EVIDENCE, in the order the assertions read:
 *   1. ONE goal, ONE plan-approval decision, a sealed graph of exactly THREE nodes, with the
 *      hard chain the submitted structure asked for.
 *   2. On the FIRST staffing pass the two INDEPENDENT nodes are BOTH claimed while the
 *      dependent node's step is BLOCKED carrying `depends:<nodeKey>` for each unmet producer.
 *   3. The dependent node is staffed only on a pass AFTER its producers are ACCEPTED.
 *   4. All three deliver, verify, land, and belong to the SAME goalRef.
 *   5. The coverage read closes the goal only at 3 of 3 — and the NEGATIVE ARM in the same
 *      test pins 2 of 3 as NOT ready, so the gate is not vacuously green.
 *   6. Exactly ONE goal aggregate exists at the end: growth minted no successor goal.
 *
 * The wall-clock readings live HERE, in a `.test.ts` the harness determinism scan excludes,
 * and travel into the harness as parameters — the same discipline the shipped seed's `clock`
 * dependency states.
 */
import { afterAll, describe, expect, it } from "vitest";

import { NODE_DELIVER_KIND } from "../../../apps/daemon/src/http/affordance-contract.js";

import {
  type J1Scratch,
  killTree,
  runWrapper,
  startDaemon,
} from "./j1-loop-harness.js";
import {
  ALPHA,
  BETA,
  CRITERIA,
  GOAL_ID,
  MULTI_NODE_KEYS,
  OMEGA,
  createMultiNodeScratch,
} from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { sealMultiNodeGraph } from "./multi-node-journey.js";
import {
  claimedWorkItems,
  closeReadiness,
  delivered,
  goalAggregates,
  landedCommits,
  openClaimWatcher,
  readCoverage,
  removeMultiNodeScratches,
  sealedNodes,
  withStore,
  workItemFor,
} from "./multi-node-reads.js";
import { daemonWire, readSurface, stepFor } from "./multi-node-wire.js";

/** Two real wrapper passes over real child processes: a tight timeout is a flake, not a signal. */
const JOURNEY_TIMEOUT_MS = 420_000;

const scratches: MultiNodeScratch[] = [];
afterAll(() => {
  removeMultiNodeScratches(scratches);
});

/** The seat limit this journey needs: two seats, so a withheld node is withheld by the GRAPH. */
const TWO_SEATS = Object.freeze({ environment: Object.freeze({ MOE_WRAPPER_MAX_AGENTS: "2" }) });
/** The same graph under ONE seat — the control that tells a limit apart from a dependency. */
const ONE_SEAT = Object.freeze({ environment: Object.freeze({ MOE_WRAPPER_MAX_AGENTS: "1" }) });

/** The wrapper's own output is the only place a spawn refusal is stated. */
function wrapperMustSucceed(label: string, run: { code: number | null; output: string }): void {
  if (run.code !== 0) throw new Error(`${label} exited ${String(run.code)}: ${run.output}`);
}

/**
 * The wrapper's own per-node verdict lines, printed VERBATIM so a reader can see which node
 * each pass verified and landed without rerunning a 30-second journey. They are a REPORT, not
 * a verdict: every assertion in this file reads durable state instead.
 */
function printPassReceipt(passes: readonly { output: string }[]): void {
  const lines = passes.flatMap((pass) => pass.output.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[lander]") || line.startsWith("[verifier]")
      || line.startsWith("[wrapper]"));
  // eslint-disable-next-line no-console
  console.log(`MULTI-NODE PASS RECEIPT\n${lines.join("\n")}`);
}

/** The `depends:` tokens a BLOCKED step carries, which is how the surface names build order. */
function dependsTokens(missing: unknown): readonly string[] {
  return (Array.isArray(missing) ? missing : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("depends:"))
    .sort();
}

describe("one goal built to completion: a 3-node graph over real processes", () => {
  it("staffs two independent nodes at once, withholds the third, and closes on one goal",
    async () => {
      const scratch = createMultiNodeScratch();
      scratches.push(scratch);
      // THE DAEMON LISTS NODES FROM THE SEALED GRAPH ALONE, and that is the whole point of
      // this arm. A file-authored node spec carries NO build order by design
      // (`daemon-store-foundation-composition.ts:118-123`) and WINS on a nodeRef collision, so
      // a daemon that also read the spec dir would surface `dependsOn: []` for every node and
      // the dependency gate would read READY on a graph that says otherwise. The WRAPPER still
      // gets the spec dir — that is where each node's own workspace and test command come from,
      // which is what lets three seats deliver three separate repositories.
      const daemon = await startDaemon(scratch, { MOE_NODE_SPECS_DIR: "" });
      const wire = daemonWire(daemon.origin, scratch.credential);
      try {
        // ---- ONE goal, ONE plan-approval decision, a sealed 3-node graph ----
        const sealed = await sealMultiNodeGraph(scratch, daemon.origin, {
          nowIso: new Date().toISOString(), nowMs: Date.now(),
        });

        // The run is the DAEMON's own derivation off the goal, never a value this test chose.
        expect(sealed.runId).toMatch(/^run-/u);

        const graph = sealedNodes(scratch);
        expect(graph.map((node) => node.nodeKey)).toEqual([...MULTI_NODE_KEYS].sort());
        // The HARD chain, read off the sealed graph's own edges: two producers, one consumer.
        expect(graph).toEqual([
          { dependsOn: [], goalRef: GOAL_ID, nodeKey: ALPHA },
          { dependsOn: [], goalRef: GOAL_ID, nodeKey: BETA },
          { dependsOn: [ALPHA, BETA], goalRef: GOAL_ID, nodeKey: OMEGA },
        ]);

        // ---- BEFORE any staffing: the surface already withholds the dependent node ----
        const beforeSurface = await readSurface(wire, scratch.projectId);
        for (const nodeKey of [ALPHA, BETA]) {
          expect(stepFor(beforeSurface, NODE_DELIVER_KIND, nodeKey)?.["status"]).toBe("READY");
        }
        const blocked = stepFor(beforeSurface, NODE_DELIVER_KIND, OMEGA);
        expect(blocked?.["status"]).toBe("BLOCKED");
        // The tokens LITERALLY, with their node suffixes: a bare `depends:` prefix check would
        // stay green if the surface named the wrong producers.
        expect(dependsTokens(blocked?.["missing"]))
          .toEqual([`depends:${ALPHA}`, `depends:${BETA}`]);

        // ---- PASS 1: two seats, and the graph is what decides who gets them ----
        const watcher = openClaimWatcher(scratch);
        const running = runWrapper(scratch, "multi-node", TWO_SEATS);
        await watcher.watch(running);
        const first = await running;
        wrapperMustSucceed("wrapper pass 1", first);

        // AT THE SAME MOMENT, not merely both by the end: one sample of the durable claim
        // register held BOTH work items OPEN at once, which is the fact a loop that staffs,
        // waits and staffs again cannot produce. The sampler's own positive control comes
        // first — a watcher that only ever answered "nothing held" would satisfy nothing.
        expect(watcher.samples.filter((held) => held.length > 0).length).toBeGreaterThan(0);
        expect(watcher.observedTogether([workItemFor(ALPHA), workItemFor(BETA)])).toBe(true);

        // Claimed, from the DURABLE claim fold rather than the pass report: a claim is
        // committed before a spawn, so this is the falsifiable record of who was staffed.
        expect(claimedWorkItems(scratch)).toEqual([workItemFor(ALPHA), workItemFor(BETA)]);
        expect(claimedWorkItems(scratch)).not.toContain(workItemFor(OMEGA));
        // Both independent nodes really delivered; the dependent one wrote nothing.
        expect(delivered(scratch, ALPHA)).toContain("export const multiply");
        expect(delivered(scratch, BETA)).toContain("export const multiply");
        expect(delivered(scratch, OMEGA)).toBeNull();

        // ---- THE NEGATIVE ARM, in this same test so it cannot drift ----
        // At two of three accepted the goal is NOT ready to close, and the shortfall is
        // exactly the third node's criterion. Asserted as NUMBERS: a gate checked only in its
        // satisfied state is vacuous, and a boolean cannot tell 2-of-3 from 0-of-3.
        const partial = await readCoverage(wire, GOAL_ID);
        expect(partial.totals).toEqual({ criteria: 3, planned: 1, verified: 2 });
        expect(partial.criteria.filter((row) => row["status"] === "VERIFIED")
          .map((row) => row["criterionId"]).sort())
          .toEqual(["crit-alpha", "crit-beta"]);
        expect(closeReadiness(scratch, GOAL_ID))
          .toEqual({ criteria: 3, kind: "NOT_READY", verified: 2 });

        // ---- PASS 2: the producers are ACCEPTED, so the consumer is offered at last ----
        const readySurface = await readSurface(wire, scratch.projectId);
        expect(stepFor(readySurface, NODE_DELIVER_KIND, OMEGA)?.["status"]).toBe("READY");
        const second = await runWrapper(scratch, "multi-node", TWO_SEATS);
        wrapperMustSucceed("wrapper pass 2", second);
        expect(claimedWorkItems(scratch)).toContain(workItemFor(OMEGA));
        expect(delivered(scratch, OMEGA)).toContain("export const multiply");

        // ---- THE CLOSING GATE, satisfied ----
        const full = await readCoverage(wire, GOAL_ID);
        expect(full.totals).toEqual({ criteria: 3, planned: 0, verified: 3 });
        expect(full.criteria.map((row) => row["status"]))
          .toEqual(CRITERIA.map(() => "VERIFIED"));
        expect(closeReadiness(scratch, GOAL_ID)).toEqual({ criteria: 3, kind: "READY" });
        expect((await readSurface(wire, scratch.projectId)).nextAllowedCommands
          .map((offer) => offer["commandKind"])).toContain("goal.close");

        printPassReceipt([first, second]);
        // ---- ...AND LANDED. Literal: each node's OWN workspace carries the lander's commit ----
        for (const nodeKey of MULTI_NODE_KEYS) {
          expect(landedCommits(scratch, nodeKey))
            .toEqual([`Moe landed node ${nodeKey} after the daemon verified it.`]);
        }

        // ---- NO SUCCESSOR GOAL: counted from durable state, never inferred from silence ----
        expect(goalAggregates(scratch)).toEqual([GOAL_ID]);
        // Every accepted node belongs to that one goal.
        expect([...new Set(sealedNodes(scratch).map((node) => node.goalRef))]).toEqual([GOAL_ID]);
      } finally {
        await killTree(daemon.child);
      }
    }, JOURNEY_TIMEOUT_MS);
});

describe("the same graph with ONE seat", () => {
  /**
   * THE POSITIVE CONTROL FOR THE PARALLEL ARM, and the answer to "what does an operator see
   * when the seat limit is 1".
   *
   * Without it the two-seat arm above is indistinguishable from a serial loop that happened to
   * staff both nodes over the pass: this arm holds the GRAPH fixed and moves only the seat
   * limit, so exactly one independent node is claimed and the OTHER is left READY, OFFERED and
   * UNCLAIMED — work waiting on a SEAT, which is a different fact from the dependent node's
   * BLOCKED, which is work waiting on the GRAPH. Both are asserted here so the two cannot be
   * confused by a reader or collapsed by a later edit.
   */
  it("staffs one independent node and leaves the other READY, offered and unclaimed",
    async () => {
      const scratch = createMultiNodeScratch();
      scratches.push(scratch);
      const daemon = await startDaemon(scratch, { MOE_NODE_SPECS_DIR: "" });
      const wire = daemonWire(daemon.origin, scratch.credential);
      try {
        await sealMultiNodeGraph(scratch, daemon.origin, {
          nowIso: new Date().toISOString(), nowMs: Date.now(),
        });
        const pass = await runWrapper(scratch, "multi-node", ONE_SEAT);
        wrapperMustSucceed("wrapper one-seat pass", pass);

        const claimed = claimedWorkItems(scratch);
        expect(claimed).toHaveLength(1);
        const [staffed] = claimed;
        expect([workItemFor(ALPHA), workItemFor(BETA)]).toContain(staffed);
        const waiting = staffed === workItemFor(ALPHA) ? BETA : ALPHA;

        const surface = await readSurface(wire, scratch.projectId);
        // THE SEAT, NOT THE GRAPH: the unstaffed independent node is still READY and still
        // OFFERED a review.submit. A limit that had been mistaken for a dependency would show
        // it BLOCKED instead, which is exactly the confusion this arm exists to rule out.
        expect(stepFor(surface, NODE_DELIVER_KIND, waiting)?.["status"]).toBe("READY");
        expect(surface.nextAllowedCommands.filter((offer) =>
          offer["commandKind"] === "review.submit" && offer["targetAggregateId"] === waiting))
          .toHaveLength(1);
        // THE GRAPH, NOT THE SEAT: the dependent node is BLOCKED on BOTH producers even though
        // one of them has already been accepted this pass.
        const dependent = stepFor(surface, NODE_DELIVER_KIND, OMEGA);
        expect(dependent?.["status"]).toBe("BLOCKED");
        expect(dependsTokens(dependent?.["missing"])).toEqual([`depends:${waiting}`]);
      } finally {
        await killTree(daemon.child);
      }
    }, JOURNEY_TIMEOUT_MS);
});

/** Kept honest: the multi-node scratch really is the shape every harness function takes. */
it("hands the harness a J1-shaped scratch with one workspace per sealed node", () => {
  const scratch = createMultiNodeScratch();
  scratches.push(scratch);
  const asJ1: J1Scratch = scratch;
  expect(asJ1.projectId).toBe(scratch.projectId);
  expect(Object.keys(scratch.workspaces).sort()).toEqual([...MULTI_NODE_KEYS].sort());
  expect(withStore(scratch, (store) => store.getAggregateVersion(GOAL_ID))).toBe(0);
});
