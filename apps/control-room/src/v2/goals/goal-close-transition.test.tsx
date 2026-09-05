import { describe, expect, it } from "vitest";

import { mapGoalCatalogAnswer } from "../../live/live-goal-catalog.js";
import { mapDocumentCoverageAnswer } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import { deriveGoalStatus } from "./goal-status.js";
import { STAGE_WORDS } from "./goal-status-strip.js";
import { CATALOG_FRAME, COVERAGE_FRAME } from "./live-close-frames.fixture.js";

/**
 * THE READY -> CLOSED TRANSITION, DRIVEN THROUGH THE REAL DECODERS ON RECORDED DAEMON BYTES.
 *
 * Both frames come from the LIVE UnAI daemon (see `live-close-frames.fixture.ts` for the exact
 * capture and its one disclosed truncation), and both go through the SHIPPED decoders -
 * `mapDocumentCoverageAnswer` and `mapGoalCatalogAnswer` - before any assertion. Those decoders
 * are exact-key: a frame that had been typed by hand would be rejected there rather than
 * flattering a softened expectation, which is the whole reason this row records frames instead
 * of writing them.
 *
 * HOW THE CLOSED FRAME IS OBTAINED, STATED PLAINLY. The recorded goal is REAL and its criteria
 * are really 10/10 VERIFIED, but its lifecycle is EXECUTION_ENABLED because the live close was
 * REFUSED - `goal.close` demands a committed `approval.decide` (bootstrap-sequence.ts:22) that
 * the UnAI project has never had, so `bootstrap-services.ts:257-260` answered
 * BOOTSTRAP_PREREQUISITE_MISSING @ DAEMON_PREREQUISITE and nothing was committed. No
 * COMPLETED coverage frame therefore exists to record on this machine at HEAD.
 *
 * So `closed()` below takes the recorded frame and moves EXACTLY ONE FIELD - the target goal's
 * `lifecycle` - to "COMPLETED", which is the single field the daemon's own close handler writes
 * and the only one either derivation reads to decide CLOSED/DONE (goal-status.ts:130,
 * goal-catalog-model.ts:209-211). Every other byte, including the sibling goal's untouched
 * lifecycle, is the daemon's. The projection is named here so a reader can see precisely how far
 * it goes; it is not a fabricated close, and no test in this file claims a close was committed.
 */

const GOAL = "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679";
const SIBLING = "goal-da4b8e1e-89df-46fe-9555-e58067af1f27";
const RUN = "run-c9d9850b-ccef-4c14-8893-a162e3aaf679";

/** The recorded frame through the shipped decoder, with no edit at all. */
function recorded(): DocumentCoverageOutcome {
  return mapDocumentCoverageAnswer(200, COVERAGE_FRAME);
}

/** The recorded bytes with ONLY the target goal's lifecycle moved, then decoded. */
function closed(): DocumentCoverageOutcome {
  const raw = COVERAGE_FRAME as { readonly goals: readonly Record<string, unknown>[] };
  const moved = {
    ...(COVERAGE_FRAME as Record<string, unknown>),
    goals: raw.goals.map((goal) => (goal["goalId"] === GOAL ? { ...goal, lifecycle: "COMPLETED" } : goal)),
  };
  return mapDocumentCoverageAnswer(200, moved);
}

describe("the ready-to-close -> closed transition on recorded daemon frames", () => {
  it("decodes the recorded frames rather than trusting them", () => {
    const coverage = recorded();
    // A decoder refusal here means the fixture is not a real frame; fail loudly on that.
    expect(coverage.status).toBe("COVERAGE");
    if (coverage.status !== "COVERAGE") return;
    expect(coverage.totals).toMatchObject({ criteria: 10, planned: 0, verified: 10 });
    expect(coverage.goals.find((goal) => goal.goalId === GOAL)?.lifecycle).toBe("EXECUTION_ENABLED");
    expect(coverage.contracts.every((contract) => contract.gate1 === "APPROVED")).toBe(true);

    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    expect(catalog.outcome).toBe("GOALS");
    expect(catalog.goals.some((goal) => goal.goalId === GOAL)).toBe(true);
  });

  it("reads READY_TO_CLOSE before the close and CLOSED after it", () => {
    const before = deriveGoalStatus({ coverage: recorded(), goalId: GOAL, runId: RUN, surface: null });
    expect(before.stage).toBe("READY_TO_CLOSE");
    expect(before.headline).toBe("All 10 acceptance criteria are verified.");
    expect(STAGE_WORDS[before.stage]).toBe("Ready to close");

    const after = deriveGoalStatus({ coverage: closed(), goalId: GOAL, runId: RUN, surface: null });
    expect(after.stage).toBe("CLOSED");
    expect(after.headline).toBe("This goal is closed.");
    // DoD 2's board-header clause: the stage word an operator actually reads.
    expect(STAGE_WORDS[after.stage]).toBe("Closed");
    // The verified progress survives the close - a closed goal still shows what it delivered.
    expect(after.progress).toEqual({ criteria: 10, verified: 10 });
  });

  it("moves the goals-list card from Active to Done, and leaves its sibling alone", () => {
    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    const cardFor = (coverage: DocumentCoverageOutcome, goalId: string): string | undefined =>
      deriveGoalCatalog(catalog, new Map([[GOAL, coverage], [SIBLING, coverage]]))
        .goals.find((goal) => goal.goalId === goalId)?.state;

    expect(cardFor(recorded(), GOAL)).toBe("ACTIVE");
    expect(cardFor(closed(), GOAL)).toBe("DONE");
    // Only the goal that closed moves: the sibling shares the same recorded coverage answer and
    // must still read ACTIVE, so the assertion cannot be satisfied by a blanket state change.
    expect(cardFor(closed(), SIBLING)).toBe("ACTIVE");
  });

  it("keeps the closed goal's headline naming the verified work", () => {
    const catalog = mapGoalCatalogAnswer(200, CATALOG_FRAME);
    const card = deriveGoalCatalog(catalog, new Map([[GOAL, closed()]]))
      .goals.find((goal) => goal.goalId === GOAL);
    expect(card?.state).toBe("DONE");
    expect(card?.headline).toBe("All 10 acceptance criteria verified · contract approved");
    expect(card?.progress).toEqual({ done: 10, noun: "acceptance criteria verified", total: 10 });
  });
});
