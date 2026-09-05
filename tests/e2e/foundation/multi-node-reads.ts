/**
 * THE DURABLE READ SIDE of the multi-node journey.
 *
 * EVERY VERDICT COMES FROM DURABLE STATE, folded through the daemon's OWN read models. The
 * claim ledger, the goal fold and the close-readiness derivation are imported at their own
 * paths and never reimplemented here: a view that recomputed a fold would let a broken
 * production fold and a broken test agree.
 *
 * The one thing read over HTTP is the coverage answer, because `POST /documents/coverage/read`
 * IS the surface DoD 2 names — and it is asserted by its NUMBERS (verified over criteria), not
 * by a boolean, so the gate can be falsified in its unsatisfied state as well as its satisfied
 * one.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: `e2e-harness.test.ts` scans every non-test module here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

import { SqliteEventStore } from "@moe/store";

import {
  readDurableLedger, stateOf,
} from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  goalCloseReadinessFor,
} from "../../../apps/daemon/src/goals/goal-close-readiness.js";
import type { GoalCloseReadiness } from "../../../apps/daemon/src/goals/goal-close-readiness.js";
import { NODE_DELIVER_KIND } from "../../../apps/daemon/src/http/affordance-contract.js";
import { workItemIdFor } from "../../../apps/daemon/src/http/affordance-read.js";
import {
  activeCompiledGraphs,
} from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import {
  readWorkClaimLedger,
} from "../../../apps/daemon/src/work/work-claim-read-model.js";

import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { type DaemonWire, type Frame, answered, asObject } from "./multi-node-wire.js";

/** Opened after (or beside) the processes, and closed on every path. */
export function withStore<T>(
  scratch: MultiNodeScratch, read: (store: SqliteEventStore) => T,
): T {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

export const workItemFor = (nodeKey: string): string =>
  workItemIdFor(NODE_DELIVER_KIND, nodeKey);

/**
 * The work items that have EVER been claimed, from the durable claim fold.
 *
 * A claim is what the wrapper commits BEFORE it spawns, so this is the falsifiable record of
 * which nodes were staffed — the wrapper's own stdout is a report, and a report can be right
 * about a pass that never committed anything.
 */
export function claimedWorkItems(scratch: MultiNodeScratch): readonly string[] {
  return withStore(scratch, (store) =>
    [...readWorkClaimLedger(store, scratch.projectId).claims.keys()].sort());
}

/**
 * ONE INSTANT of the durable claim register, sampled WHILE a pass is running.
 *
 * "Both nodes were claimed by the end of the pass" is a weaker fact than "both were held AT
 * THE SAME MOMENT": only the second is impossible for a loop that staffs, waits and staffs
 * again. Sampling after the processes are dead cannot tell them apart, so this watcher runs
 * during the pass and each sample is read through the daemon's own claim fold.
 */
export interface ClaimWatcher {
  /** True when ONE sample held every named work item OPEN at the same instant. */
  observedTogether(workItemIds: readonly string[]): boolean;
  readonly samples: readonly (readonly string[])[];
  watch(running: Promise<unknown>): Promise<void>;
}

/**
 * Fast enough that a scripted seat's claim window cannot be stepped over: the whole staffed
 * lifetime of one of these agents is seconds, and the J1 lane measured a 750ms sampler missing
 * a 3.5s window under parallel load, so the cadence is the OBSERVER's problem to solve rather
 * than the assertion's to loosen.
 */
const SAMPLE_INTERVAL_MS = 40;

export function openClaimWatcher(scratch: MultiNodeScratch): ClaimWatcher {
  const samples: (readonly string[])[] = [];
  const sample = (): readonly string[] => {
    try {
      return withStore(scratch, (store) =>
        [...readWorkClaimLedger(store, scratch.projectId).claims.values()]
          .filter((claim) => claim.status === "OPEN")
          .map((claim) => claim.workItemId).sort());
    } catch {
      // The store file can be locked at any instant; a failed sample observes nothing rather
      // than being recorded as an observation of zero holders.
      return [];
    }
  };
  return {
    observedTogether: (workItemIds) => samples.some((held) =>
      workItemIds.every((workItemId) => held.includes(workItemId))),
    samples,
    watch: async (running) => {
      let settled = false;
      void running.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        samples.push(sample());
        await new Promise<void>((resolve) => { setTimeout(resolve, SAMPLE_INTERVAL_MS); });
      }
    },
  };
}

/** The sealed graph's execution-bearing nodes, with the build order the graph itself carries. */
export interface SealedNodeView {
  readonly dependsOn: readonly string[];
  readonly goalRef: string;
  readonly nodeKey: string;
}

export function sealedNodes(scratch: MultiNodeScratch): readonly SealedNodeView[] {
  return withStore(scratch, (store) => {
    const rows: SealedNodeView[] = [];
    for (const graph of activeCompiledGraphs(store, scratch.projectId)) {
      const { edges, nodes } = graph.content.snapshot;
      const bearing = new Set(nodes.filter((node) => node.executionBearing)
        .map((node) => node.nodeKey));
      for (const definition of graph.content.nodeAuthority.definitions) {
        if (!bearing.has(definition.nodeKey)) continue;
        rows.push(Object.freeze({
          dependsOn: edges.filter((edge) => edge.consumerNodeKey === definition.nodeKey)
            .map((edge) => edge.producerNodeKey).sort(),
          goalRef: graph.goalRef,
          nodeKey: definition.nodeKey,
        }));
      }
    }
    return rows.sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  });
}

/**
 * EVERY goal aggregate in the store, counted from the durable fold.
 *
 * This is the assertion that proves growth minted no successor goal, and it is counted rather
 * than inferred from the absence of a replan log line — an absence reads green on a store
 * where nothing ever ran.
 */
export function goalAggregates(scratch: MultiNodeScratch): readonly string[] {
  return withStore(scratch, (store) => {
    const ledger = readDurableLedger(store, scratch.projectId);
    const goals: string[] = [];
    for (const [aggregateId] of ledger.aggregates) {
      // The SAME shape `activeCompiledGraphs` uses to recognise a goal (a folded record whose
      // own `goalId` is its aggregate id, scoped to this project), so "one goal" here means
      // exactly what the production walk means by it.
      const data = asObject(stateOf(ledger, aggregateId));
      if (data?.["goalId"] === aggregateId && data["projectId"] === scratch.projectId) {
        goals.push(aggregateId);
      }
    }
    return goals.sort();
  });
}

/** The production close-readiness derivation, with its own numbers. */
export function closeReadiness(
  scratch: MultiNodeScratch, goalId: string,
): GoalCloseReadiness {
  return withStore(scratch, (store) =>
    goalCloseReadinessFor(store, scratch.projectId, goalId));
}

export interface CoverageTotals {
  readonly criteria: number;
  readonly planned: number;
  readonly verified: number;
}

export interface CoverageView {
  readonly criteria: readonly Frame[];
  readonly totals: CoverageTotals;
}

/** `POST /documents/coverage/read` — the closing gate DoD 2 names, read off the live daemon. */
export async function readCoverage(wire: DaemonWire, goalRef: string): Promise<CoverageView> {
  const frame = answered(
    "/documents/coverage/read", "COVERAGE",
    await wire.post("/documents/coverage/read", { goalRef }),
  );
  const totals = asObject(frame["totals"]);
  if (totals === null) throw new Error(`the coverage frame states no totals: ${JSON.stringify(frame)}`);
  const contracts = Array.isArray(frame["contracts"]) ? frame["contracts"] : [];
  const criteria: Frame[] = [];
  for (const contract of contracts.map(asObject)) {
    const requirements = Array.isArray(contract?.["requirements"]) ? contract["requirements"] : [];
    for (const requirement of requirements.map(asObject)) {
      const rows = Array.isArray(requirement?.["criteria"]) ? requirement["criteria"] : [];
      for (const row of rows.map(asObject)) if (row !== null) criteria.push(row);
    }
  }
  return {
    criteria,
    totals: Object.freeze({
      criteria: Number(totals["criteria"]),
      planned: Number(totals["planned"]),
      verified: Number(totals["verified"]),
    }),
  };
}

/** Whether a node's own workspace holds the deliverable its agent was asked to write. */
export function delivered(scratch: MultiNodeScratch, nodeKey: string): string | null {
  const workspace = scratch.workspaces[nodeKey];
  if (workspace === undefined) return null;
  try {
    return readFileSync(`${workspace}/math.mjs`, "utf8");
  } catch {
    return null;
  }
}

/**
 * The subjects of the Moe landing commits in one node's workspace.
 *
 * LANDING IS LITERAL HERE. This reads the workspace's own git history, so a lander that
 * recorded a receipt and committed nothing answers `[]`.
 *
 * `%B` and not `%s`: `landingMessage` (node-lander.ts:65-76) puts the node's TITLE on the
 * subject line and `Moe landed node <nodeRef> after the daemon verified it.` in the BODY, so a
 * subject-only read finds nothing on a workspace that really did land.
 */
export function landedCommits(scratch: MultiNodeScratch, nodeKey: string): readonly string[] {
  const cwd = scratch.workspaces[nodeKey];
  if (cwd === undefined) return [];
  return execFileSync("git", ["log", "--format=%B"], { cwd, encoding: "utf8" })
    .split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("Moe landed node "));
}

/** Removes every scratch a run registered. A held Windows handle is not a test verdict. */
export function removeMultiNodeScratches(sink: readonly MultiNodeScratch[]): void {
  for (const scratch of sink) {
    try {
      rmSync(scratch.root, { force: true, maxRetries: 3, recursive: true });
    } catch {
      // The OS reclaims the temp directory; failing teardown here would hide the verdict.
    }
  }
}
