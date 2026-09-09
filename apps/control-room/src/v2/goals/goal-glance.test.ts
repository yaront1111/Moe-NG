import { describe, expect, it } from "vitest";

import { frameOfSurface } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { RunGoalView, RunNodeView } from "../../live/live-runs.js";
import { deriveGoalGlance } from "./goal-glance.js";
import { AFTER_COMPILE_FRAME, AFTER_REJECT_FRAME, RECORDED } from "./plan-reject-frames.fixture.js";

const NOW = Date.parse("2026-09-04T09:00:00.000Z");
const ENTRY: LiveGoalCatalogEntry = {
  binding: null, brief: { instructions: "Keep every anchor.", title: "Evidence ledger" },
  goalId: "goal-1", planningRunRef: "run-1", truthClass: "DAEMON_VERIFIED",
};

function node(nodeKey: string, status: RunNodeView["status"], extra: Partial<RunNodeView> = {}): RunNodeView {
  return {
    accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], landing: null, lastActivityAt: null, nodeKey, nodeRef: `node-${nodeKey}`,
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
          { criterionId: "crit-1", nodeKey: "n-1", nodeTestStatus: null, statement: "s", status: "VERIFIED" },
          { criterionId: "crit-2", nodeKey: "n-2", nodeTestStatus: null, statement: "s", status: "PLANNED" },
          { criterionId: "crit-3", nodeKey: "n-3", nodeTestStatus: null, statement: "s", status: "PLANNED" },
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

  it.each([
    { frame: AFTER_COMPILE_FRAME, needsYou: true, stage: "PLAN" },
    { frame: AFTER_REJECT_FRAME, needsYou: false, stage: "PLAN_REJECTED" },
  ])("reports $stage from the successor without losing the original run identity", ({ frame, needsYou, stage }) => {
    const currentSurface = frameOfSurface(frame);
    expect(currentSurface.outcome).toBe("SURFACE");
    expect(RECORDED.successorRunId).not.toBe(RECORDED.rejectedRunId);
    expect(currentSurface.planningGoalRefs).toEqual({ [RECORDED.successorRunId]: RECORDED.goalId });
    const glance = deriveGoalGlance({
      coverage: undefined, entry: { ...ENTRY, goalId: RECORDED.goalId, planningRunRef: RECORDED.rejectedRunId },
      nowMs: NOW, run: undefined, surface: currentSurface,
    });
    expect(glance.stage).toBe(stage);
    expect(glance.needsYou).toBe(needsYou);
    expect(glance.needsYouLabels).toEqual(needsYou ? ["Plan to approve"] : []);
    expect(glance.rank).toBe(needsYou ? 0 : 3);
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
    expect(glance.nodesLine).toBe("3 nodes · 1 verified · 1 working · 1 stuck");
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

  it.each(["BLOCKED", "REPLANNED", "UNATTRIBUTABLE"] as const)(
    "keeps a %s node visibly blocked after the board adopts pipeline columns", (nodeStatus) => {
      const glance = deriveGoalGlance({
        coverage: coverage(0, 1, "EXECUTION_ENABLED"), entry: ENTRY, nowMs: NOW,
        run: run([node("n-1", nodeStatus)]), surface: surface([], [STEP("n-1", "READY")]),
      });
      expect(glance.state).toBe("BLOCKED");
      expect(glance.stuck).toBe(1);
      expect(glance.rank).toBe(1);
      expect(glance.nodesLine).toBe("1 node · 1 stuck");
    },
  );

  it("uses the actual published commit when folding the list card's pipeline", () => {
    const sha = "a".repeat(40);
    const published: RunGoalView = {
      ...run([node("n-1", "ACCEPTED", { landing: {
        branch: "main", code: null, files: ["src/index.ts"], outcome: "COMMITTED", sha,
      } })]),
      publish: { branch: "main", code: null, decisionId: "publish-1", outcome: "PUSHED",
        remoteUrl: "https://github.com/o/r.git", requestedAt: "2026-09-04T08:00:00.000Z", sha, url: null },
    };
    const glance = deriveGoalGlance({
      coverage: coverage(1, 1, "EXECUTION_ENABLED"), entry: ENTRY, nowMs: NOW,
      run: published, surface: surface([], [STEP("n-1", "COMMITTED")]),
    });
    expect(glance.nodesLine).toBe("1 node · 1 published");
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
