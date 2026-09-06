import { describe, expect, it } from "vitest";

import { frameOfSurface } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { deriveNeedsYou } from "../approvals/needs-you-model.js";
import { deriveGoalStatus } from "./goal-status.js";
import { AFTER_APPROVE_FRAME } from "./plan-approve-frame.fixture.js";
import { AFTER_COMPILE_FRAME, AFTER_REJECT_FRAME, RECORDED } from "./plan-reject-frames.fixture.js";
import { planSentBack } from "./plan-run-resolution.js";

/**
 * "PLAN SENT BACK" MUST NOT OUTLIVE THE APPROVAL THAT ENDED THE WAIT.
 *
 * THE DEFECT THIS FILE EXISTS TO CATCH, seen live on UnAI 2026-09-06 (goal
 * goal-c1d66d35-94ae-47c1-8ec5-4f5f44ddae34, two rejects then an approve): after the operator
 * approved the successor plan and four nodes were already working, the board header still read
 * "Plan sent back / Waiting for a new plan" and Needs you still held a card for a decision
 * nobody could make. `planSentBack` was two NEGATIVES - the goal is bound to a run other than
 * the immutable one, and that run is not offered for approval - and BOTH stay true forever
 * after an activation, because the daemon keeps the successor binding for the goal's whole life
 * and withdraws the approval offer at activation. The reject-frame arms in
 * plan-run-resolution.test.tsx could not see it: neither recorded frame is post-approval.
 *
 * Every frame here is decoded by the REAL decoder `frameOfSurface`, the same call the live
 * board feed makes on `POST /affordances/read`, so a fixture that drifted from the daemon's
 * shape fails at the decoder rather than at a softened assertion below.
 */

const AFTER_REJECT: SurfaceFrame = frameOfSurface(AFTER_REJECT_FRAME);
const AFTER_COMPILE: SurfaceFrame = frameOfSurface(AFTER_COMPILE_FRAME);
const AFTER_APPROVE: SurfaceFrame = frameOfSurface(AFTER_APPROVE_FRAME);

/** The catalog row as the browser holds it: the IMMUTABLE ref, which is the rejected run. */
const CATALOG: GoalCatalogFrame = Object.freeze({
  connection: "CONNECTED",
  detail: "",
  goals: Object.freeze([Object.freeze({
    binding: null,
    brief: Object.freeze({ instructions: "Build the widget", title: "The widget" }),
    goalId: RECORDED.goalId,
    planningRunRef: RECORDED.rejectedRunId,
    truthClass: "HUMAN_APPROVED" as const,
  })]),
  outcome: "GOALS",
});

const kindsOf = (frame: SurfaceFrame): readonly string[] =>
  deriveNeedsYou({ catalog: CATALOG, coverage: new Map(), surface: frame })
    .items.map((item) => item.kind);

describe("the recorded post-approve frame really is the state the defect lives in", () => {
  it("decodes as SURFACE, still binds the SUCCESSOR, and offers nothing at all", () => {
    expect(AFTER_APPROVE.outcome).toBe("SURFACE");
    // Entries, not the record: the decoder hands back a null-prototype map on purpose.
    expect(Object.entries(AFTER_APPROVE.planningGoalRefs ?? {})).toStrictEqual([
      [RECORDED.successorRunId, RECORDED.goalId],
    ]);
    // Not "no approval offer" - NO offer. Both negatives the old rule read are satisfied here,
    // which is exactly why it could not tell this state from a goal awaiting a new plan.
    expect(AFTER_APPROVE.offers).toStrictEqual([]);
  });

  it("differs from the post-reject frame only in the replan offer the daemon withdrew", () => {
    const replanOffers = AFTER_REJECT.offers.filter((offer) =>
      offer["commandKind"] === "planning.submit_decomposition"
      && offer["targetAggregateId"] === RECORDED.goalId);
    expect(replanOffers).toHaveLength(1);
    expect(Object.entries(AFTER_REJECT.planningGoalRefs ?? {}))
      .toStrictEqual(Object.entries(AFTER_APPROVE.planningGoalRefs ?? {}));
  });
});

describe("planSentBack", () => {
  it("is FALSE once the successor is approved, though both old negatives still hold", () => {
    expect(planSentBack(AFTER_APPROVE, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(false);
  });

  it("still answers the two states it was written for", () => {
    expect(planSentBack(AFTER_REJECT, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(true);
    expect(planSentBack(AFTER_COMPILE, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(false);
  });
});

describe("what the operator is told after the approval", () => {
  it("stops reading PLAN_REJECTED on the board header", () => {
    const approved = deriveGoalStatus({
      coverage: null, goalId: RECORDED.goalId, runId: RECORDED.rejectedRunId,
      surface: AFTER_APPROVE,
    });
    expect(approved.stage).toBe("UNKNOWN");
    // The same derivation on the frame the banner IS for, so the arm above cannot pass by the
    // stage having been deleted.
    const sentBack = deriveGoalStatus({
      coverage: null, goalId: RECORDED.goalId, runId: RECORDED.rejectedRunId,
      surface: AFTER_REJECT,
    });
    expect(sentBack.stage).toBe("PLAN_REJECTED");
    expect(sentBack.next.label).toBe("Waiting for a new plan");
  });

  it("drops the Needs you card, and keeps it while the re-plan is really pending", () => {
    expect(kindsOf(AFTER_APPROVE)).toStrictEqual([]);
    expect(kindsOf(AFTER_REJECT)).toStrictEqual(["PLAN_REJECTED"]);
    expect(kindsOf(AFTER_COMPILE)).toStrictEqual(["PLAN_APPROVAL"]);
  });
});
