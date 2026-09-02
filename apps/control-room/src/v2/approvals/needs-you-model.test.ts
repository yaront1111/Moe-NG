import { describe, expect, it } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { deriveNeedsYou } from "./needs-you-model.js";

/**
 * The Needs-you derivation over the three daemon answers it reads. Every arm names the
 * ONE fact that puts a decision in the queue, and the negative arms show that the same
 * goal without that fact produces nothing: a plan approval exists only as a daemon OFFER,
 * a Gate 1 item only as a PENDING contract, ready-to-close only as full verification on an
 * open goal.
 */

function catalog(goals: GoalCatalogFrame["goals"]): GoalCatalogFrame {
  return { connection: "CONNECTED", detail: "", goals, outcome: "GOALS" };
}
const entry = (goalId: string, title: string): GoalCatalogFrame["goals"][number] => ({
  binding: null, brief: { instructions: "build", title }, goalId,
  planningRunRef: `run-${goalId}`, truthClass: "DAEMON_VERIFIED",
});
function surface(offers: readonly Record<string, unknown>[]): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", planningGoalRefs: {}, steps: [],
  };
}
const approvalOffer = (runId: string): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${runId}`,
  commandKind: "approval.decide_intent", expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: runId,
});
function coverage(
  goalId: string, verified: number, criteria: number,
  gate1: "APPROVED" | "PENDING", lifecycle: string,
): DocumentCoverageOutcome {
  return {
    contracts: [{
      contractId: `contract-${goalId}`, gate1,
      requirements: [{
        criteria: Array.from({ length: criteria }, (_, i) => ({
          criterionId: `crit-${String(i)}`, nodeKey: null, statement: "s",
          status: i < verified ? "VERIFIED" as const : "PLANNED" as const,
        })),
        requirementId: "req-1", statement: "r",
      }],
      revisionDigest: "d".repeat(64), revisionId: "rev-1",
    }],
    document: { byteLength: 10, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId, lastActivityAt: null, lifecycle, planningRunRef: `run-${goalId}`, title: "t" }],
    sections: null,
    status: "COVERAGE",
    totals: { contracts: 1, criteria, goals: 1, planned: criteria - verified, requirements: 1, verified },
  };
}

describe("deriveNeedsYou", () => {
  it("waits for the catalog and carries a catalog refusal as the note", () => {
    expect(deriveNeedsYou({ catalog: null, coverage: new Map(), surface: null })).toMatchObject({
      countLabel: "WAITING FOR THE GOAL CATALOG", items: [],
    });
    const refused = deriveNeedsYou({
      catalog: { connection: "CONNECTED", detail: "GOAL_CATALOG_READ_CAPABILITY_DENIED", goals: [], outcome: "REFUSED" },
      coverage: new Map(), surface: null,
    });
    expect(refused.items).toEqual([]);
    expect(refused.note).toContain("GOAL_CATALOG_READ_CAPABILITY_DENIED");
  });

  it("lists a plan approval only when the daemon offers approval.decide_intent for that run", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-a", "Alpha"), entry("goal-b", "Beta")]),
      coverage: new Map(),
      surface: surface([approvalOffer("run-goal-b")]),
    });
    expect(data.items.map((item) => [item.kind, item.goalId, item.actionLabel])).toEqual([
      ["PLAN_APPROVAL", "goal-b", "Review the plan"],
    ]);
    expect(data.countLabel).toBe("1 DECISION · NEEDS YOU");
    expect(data.note).toBeNull();
    expect(deriveNeedsYou({
      catalog: catalog([entry("goal-b", "Beta")]), coverage: new Map(),
      surface: surface([{ ...approvalOffer("run-goal-b"), commandKind: "approval.decide" }]),
    }).items).toEqual([]);
  });

  it("lists a Gate 1 item per PENDING contract and a ready-to-close item for a verified open goal", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-p", "Pending"), entry("goal-d", "Done"), entry("goal-c", "Closed")]),
      coverage: new Map([
        ["goal-p", coverage("goal-p", 0, 4, "PENDING", "DRAFT")],
        ["goal-d", coverage("goal-d", 3, 3, "APPROVED", "EXECUTION_ENABLED")],
        ["goal-c", coverage("goal-c", 3, 3, "APPROVED", "COMPLETED")],
      ]),
      surface: surface([]),
    });
    expect(data.items.map((item) => [item.kind, item.goalId])).toEqual([
      ["GATE_1", "goal-p"], ["READY_TO_CLOSE", "goal-d"],
    ]);
    expect(data.items[0]?.detail).toContain("contract-goal-p");
    expect(data.items[0]?.detail).toContain("4 acceptance criteria");
    expect(data.items[1]?.detail).toContain("All 3 acceptance criteria verified");
    expect(data.countLabel).toBe("2 DECISIONS · NEEDS YOU");
  });

  it("orders plans before contracts before closes, then by title", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-z", "Zulu"), entry("goal-a", "Alpha"), entry("goal-m", "Mike")]),
      coverage: new Map([
        ["goal-z", coverage("goal-z", 0, 1, "PENDING", "DRAFT")],
        ["goal-a", coverage("goal-a", 0, 1, "PENDING", "DRAFT")],
      ]),
      surface: surface([approvalOffer("run-goal-m")]),
    });
    expect(data.items.map((item) => `${item.kind}:${item.title}`)).toEqual([
      "PLAN_APPROVAL:Mike", "GATE_1:Alpha", "GATE_1:Zulu",
    ]);
  });

  it("does not invent a decision from partial verification or a refused coverage read", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-h", "Half"), entry("goal-r", "Refused")]),
      coverage: new Map<string, DocumentCoverageOutcome>([
        ["goal-h", coverage("goal-h", 2, 3, "APPROVED", "EXECUTION_ENABLED")],
        ["goal-r", { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED" }],
      ]),
      surface: null,
    });
    expect(data.items).toEqual([]);
    expect(data.note).toContain("offers have not arrived");
  });
});
