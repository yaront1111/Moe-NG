import { describe, expect, it } from "vitest";

import { mapGoalCatalogAnswer } from "../../live/live-goal-catalog.js";
import { mapDocumentCoverageAnswer } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import { deriveGoalStatus } from "./goal-status.js";
import { STAGE_WORDS } from "./goal-status-strip.js";
import { CATALOG_FRAME, COVERAGE_FRAME } from "./live-close-frames.fixture.js";

/** Historical coverage claimed all criteria VERIFIED from generic node tests. Keep its
 * recorded bytes intact and prove the current decoder rejects the old shape. The current
 * fixture below is an explicit conservative projection: old criterion facts are unattributable,
 * with no node test assertion or verified count. A separate hypothetical CLOSED lifecycle tests
 * rendering an already closed record without inventing criterion evidence or a live close. */

const GOAL = "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679";
const SIBLING = "goal-da4b8e1e-89df-46fe-9555-e58067af1f27";
const RUN = "run-c9d9850b-ccef-4c14-8893-a162e3aaf679";

function currentFrame() {
  const frame = structuredClone(COVERAGE_FRAME) as {
    contracts: { requirements: { criteria: Record<string, unknown>[] }[] }[];
    goals: Record<string, unknown>[];
    sections: unknown;
    totals: Record<string, unknown>;
  };
  for (const contract of frame.contracts) for (const requirement of contract.requirements) {
    for (const criterion of requirement.criteria) {
      criterion["nodeTestStatus"] = null;
      criterion["status"] = "UNATTRIBUTABLE";
    }
  }
  frame.totals["verified"] = 0;
  frame.totals["unattributable"] = 10;
  frame.sections = null;
  return frame;
}

function projected(closed = false): DocumentCoverageOutcome {
  const frame = currentFrame();
  if (closed) frame.goals = frame.goals.map((goal) => goal["goalId"] === GOAL
    ? { ...goal, lifecycle: "COMPLETED" } : goal);
  return mapDocumentCoverageAnswer(200, frame);
}

describe("legacy coverage and closed lifecycle remain separate facts", () => {
  it("rejects the recorded generic-test overclaim and accepts an explicitly unattributable projection", () => {
    expect(mapDocumentCoverageAnswer(200, COVERAGE_FRAME)).toMatchObject({
      code: "DOCUMENT_COVERAGE_RESPONSE_INVALID", status: "ERROR",
    });
    const coverage = projected();
    expect(coverage.status).toBe("COVERAGE");
    if (coverage.status !== "COVERAGE") return;
    expect(coverage.totals).toMatchObject({ criteria: 10, planned: 0, unattributable: 10, verified: 0 });
    expect(coverage.goals.find((goal) => goal.goalId === GOAL)?.lifecycle).toBe("EXECUTION_ENABLED");
    expect(coverage.contracts.every((contract) => contract.gate1 === "APPROVED")).toBe(true);

    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    expect(catalog.outcome).toBe("GOALS");
    expect(catalog.goals.some((goal) => goal.goalId === GOAL)).toBe(true);
  });

  it("withholds ready-to-close for legacy evidence while rendering an explicit closed lifecycle", () => {
    const legacy = deriveGoalStatus({ coverage: mapDocumentCoverageAnswer(200, COVERAGE_FRAME), goalId: GOAL, runId: RUN, surface: null });
    expect(legacy.stage).toBe("UNKNOWN");
    expect(legacy.progress).toBeNull();
    const before = deriveGoalStatus({ coverage: projected(), goalId: GOAL, runId: RUN, surface: null });
    expect(before.stage).toBe("UNKNOWN");
    expect(before.progress).toEqual({ criteria: 10, verified: 0 });

    const after = deriveGoalStatus({ coverage: projected(true), goalId: GOAL, runId: RUN, surface: null });
    expect(after.stage).toBe("CLOSED");
    expect(after.headline).toBe("This goal is closed.");
    // DoD 2's board-header clause: the stage word an operator actually reads.
    expect(STAGE_WORDS[after.stage]).toBe("Closed");
    expect(after.progress).toEqual({ criteria: 10, verified: 0 });
  });

  it("moves the goals-list card from Active to Done, and leaves its sibling alone", () => {
    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    const cardFor = (coverage: DocumentCoverageOutcome, goalId: string): string | undefined =>
      deriveGoalCatalog(catalog, new Map([[GOAL, coverage], [SIBLING, coverage]]))
        .goals.find((goal) => goal.goalId === goalId)?.state;

    expect(cardFor(projected(), GOAL)).toBe("ACTIVE");
    expect(cardFor(projected(true), GOAL)).toBe("DONE");
    // Only the goal that closed moves: the sibling shares the same recorded coverage answer and
    // must still read ACTIVE, so the assertion cannot be satisfied by a blanket state change.
    expect(cardFor(projected(true), SIBLING)).toBe("ACTIVE");
  });

  it("keeps a closed record's missing criterion evidence visible", () => {
    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    const card = deriveGoalCatalog(catalog, new Map([[GOAL, projected(true)]]))
      .goals.find((goal) => goal.goalId === GOAL);
    expect(card?.state).toBe("DONE");
    expect(card?.headline).toBe("0 of 10 acceptance criteria verified · contract approved");
    expect(card?.progress).toEqual({ done: 0, noun: "acceptance criteria verified", total: 10 });
  });
});
