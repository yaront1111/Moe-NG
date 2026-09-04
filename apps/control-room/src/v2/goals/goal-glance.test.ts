import { describe, expect, it } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { RunGoalView, RunNodeView } from "../../live/live-runs.js";
import { deriveGoalGlance } from "./goal-glance.js";

const NOW = Date.parse("2026-09-04T09:00:00.000Z");
const ENTRY: LiveGoalCatalogEntry = {
  binding: null, brief: { instructions: "Keep every anchor.", title: "Evidence ledger" },
  goalId: "goal-1", planningRunRef: "run-1", truthClass: "DAEMON_VERIFIED",
};

function node(nodeKey: string, status: RunNodeView["status"], extra: Partial<RunNodeView> = {}): RunNodeView {
  return {
    accepted: null, claim: null, criterionIds: [], dependsOn: [], landing: null, lastActivityAt: null, nodeKey,
    objective: `Objective of ${nodeKey}`, receipt: null,
    review: { escalated: false, findings: [], latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
    sharedKey: false, status, ...extra,
  };
}

function coverage(verified: number, criteria: number, lifecycle: string, gate1: "APPROVED" | "PENDING" = "APPROVED"): DocumentCoverageOutcome {
  return {
    contracts: [{
      contractId: "c-1", gate1, plane: "V1",
      requirements: [{
        criteria: [
          { criterionId: "crit-1", nodeKey: "n-1", statement: "s", status: "VERIFIED" },
          { criterionId: "crit-2", nodeKey: "n-2", statement: "s", status: "PLANNED" },
          { criterionId: "crit-3", nodeKey: "n-3", statement: "s", status: "PLANNED" },
        ],
        requirementId: "r-1", statement: "r",
      }],
      revisionDigest: "d".repeat(64), revisionId: "rev-1",
    }],
    document: { byteLength: 1, contentSha256: "c".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId: "goal-1", lastActivityAt: null, lifecycle, planningRunRef: "run-1", title: "Evidence ledger" }],
    sections: [],
    status: "COVERAGE",
    totals: { contracts: 1, criteria, goals: 1, planned: 0, requirements: 1, unattributable: 0, verified },
  };
}

function surface(offers: readonly Record<string, unknown>[], steps: readonly Record<string, unknown>[] = []): SurfaceFrame {
  return { connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", planningGoalRef: "goal-1", planningGoalRefs: { "run-1": "goal-1" }, steps } as unknown as SurfaceFrame;
}

const STEP = (key: string, status: string, claim: unknown = null, missing: readonly string[] = []): Record<string, unknown> =>
  ({ aggregateId: key, claim, kind: "node.deliver", missing, status, version: 1 });

function run(nodes: readonly RunNodeView[], lifecycle = "EXECUTION_ENABLED"): RunGoalView {
  return { goalId: "goal-1", lifecycle, nodes, publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Evidence ledger" };
}

describe("deriveGoalGlance", () => {
  it("says a plan is waiting, needs a human, and ranks first", () => {
    const glance = deriveGoalGlance({
      coverage: coverage(0, 10, "DRAFT"), entry: ENTRY, nowMs: NOW, run: undefined,
      surface: surface([{ commandKind: "approval.decide_intent", targetAggregateId: "run-1" }]),
    });
    expect(glance.headline).toBe("The plan is waiting for your approval.");
    expect(glance.needsYou).toBe(true);
    expect(glance.needsYouLabels).toEqual(["Plan to approve"]);
    expect(glance.state).toBe("DRAFT");
    expect(glance.rank).toBe(0);
    expect(glance.nodesLine).toBeNull();
  });

  it("counts the nodes in the board's words while agents work, and flags the stuck one on the headline", () => {
    const nodes = [
      node("n-1", "ACCEPTED", { accepted: { verifierReceiptId: "r" } }),
      node("n-2", "IN_PROGRESS", { claim: { active: true, claimedBy: "sess-wrap-1", expiresAt: "2026-09-04T09:20:00.000Z", status: "OPEN" } }),
      node("n-3", "READY", { review: { escalated: false, findings: [], latestRoute: "REJECT_IMPLEMENTATION", rounds: 1, unreadable: false, unsuccessfulRounds: 1, version: 2 } }),
    ];
    const glance = deriveGoalGlance({
      coverage: coverage(1, 3, "EXECUTION_ENABLED"), entry: ENTRY, nowMs: NOW, run: run(nodes),
      surface: surface([], [STEP("n-1", "COMMITTED"), STEP("n-2", "READY", { claimedBy: "sess-wrap-1", expiresAt: "x" }), STEP("n-3", "READY")]),
    });
    expect(glance.headline).toBe("Agents are working: 1 of 3 nodes accepted. · 1 stuck");
    expect(glance.nodesLine).toBe("3 nodes · 1 done · 1 working · 1 stuck");
    expect(glance.state).toBe("ACTIVE");
    expect(glance.needsYou).toBe(false);
    expect(glance.stuck).toBe(1);
    expect(glance.tone).toBe("danger");
    expect(glance.rank).toBe(1);
  });

  it("is BLOCKED and needs a human when a review is exhausted", () => {
    const nodes = [node("n-1", "ESCALATION_REQUIRED", { review: { escalated: false, findings: [], latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 5 } })];
    const glance = deriveGoalGlance({
      coverage: coverage(0, 1, "EXECUTION_ENABLED"), entry: ENTRY, nowMs: NOW, run: run(nodes),
      surface: surface([{ commandKind: "escalation.decide", targetAggregateId: "n-1" }], [STEP("n-1", "BLOCKED", null, ["escalation"])]),
    });
    expect(glance.state).toBe("BLOCKED");
    expect(glance.needsYouLabels).toEqual(["Review exhausted"]);
    expect(glance.rank).toBe(0);
    expect(glance.nodesLine).toBe("1 node · 1 stuck");
  });

  it("is DONE, ranks last and carries no chip once the goal is closed", () => {
    const glance = deriveGoalGlance({
      coverage: coverage(3, 3, "COMPLETED"), entry: ENTRY, nowMs: NOW,
      run: run([node("n-1", "ACCEPTED")], "COMPLETED"), surface: surface([]),
    });
    expect(glance.state).toBe("DONE");
    expect(glance.headline).toBe("This goal is closed.");
    expect(glance.needsYou).toBe(false);
    expect(glance.rank).toBe(4);
    expect(glance.tone).toBe("verified");
  });

  it("stays UNKNOWN, with a mid rank, before the daemon has said anything", () => {
    const glance = deriveGoalGlance({ coverage: undefined, entry: ENTRY, nowMs: NOW, run: undefined, surface: null });
    expect(glance.stage).toBe("UNKNOWN");
    expect(glance.state).toBe("DRAFT");
    expect(glance.needsYou).toBe(false);
    expect(glance.rank).toBe(3);
  });
});
