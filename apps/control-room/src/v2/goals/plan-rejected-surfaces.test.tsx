import { describe, expect, it } from "vitest";

import { toneOf } from "../board/board-feed.js";
import type { ActivityEntryView } from "../../live/live-activity.js";
import { decisionWords } from "../ops/activity-words.js";
import { frameOfSurface } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { NEEDS_YOU_KINDS, deriveNeedsYou } from "../approvals/needs-you-model.js";
import { deriveGoalStatus } from "./goal-status.js";
import { STAGE_WORDS } from "./goal-status-strip.js";
import {
  AFTER_COMPILE_FRAME, AFTER_REJECT_FRAME, RECORDED,
} from "./plan-reject-frames.fixture.js";

/**
 * A SENT-BACK PLAN, wherever the operator looks for it: the Needs-you queue and the
 * opened goal's status strip. Both are driven off the SAME two recorded daemon frames
 * step 4 uses (see the fixture header), decoded by the REAL `frameOfSurface`.
 *
 * THE PAIR IS THE POINT. Every arm asserts the sent-back state AND the state after the
 * compiler replans, because an item or a stage that appears correctly but never CLEARS
 * is a queue that grows forever - and an arm that only asserted the appearance would
 * call that a pass.
 */

const AFTER_REJECT: SurfaceFrame = frameOfSurface(AFTER_REJECT_FRAME);
const AFTER_COMPILE: SurfaceFrame = frameOfSurface(AFTER_COMPILE_FRAME);

/**
 * The catalog entry as the daemon states it: `planningRunRef` is IMMUTABLE and still
 * names the run the operator rejected. That staleness is exactly the input under test.
 */
const CATALOG: GoalCatalogFrame = Object.freeze({
  detail: "",
  goals: Object.freeze([Object.freeze({
    brief: Object.freeze({ instructions: "", title: "Recovery goal" }),
    goalId: RECORDED.goalId,
    planningRunRef: RECORDED.rejectedRunId,
  })]),
  outcome: "GOALS",
}) as unknown as GoalCatalogFrame;

const NO_COVERAGE = new Map<string, never>();

function kindsOn(surface: SurfaceFrame): string[] {
  return deriveNeedsYou({ catalog: CATALOG, coverage: NO_COVERAGE, surface })
    .items.map((item) => item.kind);
}

describe("the Needs-you queue after a plan is sent back", () => {
  /**
   * BIDIRECTIONAL on the roster, not just membership: PLAN_REJECTED is advertised AND
   * every advertised kind is a distinct string in the declared order. A kind added to
   * the constant without a producing branch would advertise an item nothing can reach.
   */
  it("advertises PLAN_REJECTED once, beside PLAN_APPROVAL", () => {
    expect([...NEEDS_YOU_KINDS]).toEqual([
      "PLAN_APPROVAL", "PLAN_REJECTED", "PREVIEW", "RELEASE", "ESCALATION", "GATE_1",
      "READY_TO_CLOSE",
    ]);
    expect(new Set(NEEDS_YOU_KINDS).size).toBe(NEEDS_YOU_KINDS.length);
  });

  it("lists exactly one PLAN_REJECTED item while the successor is being compiled", () => {
    const data = deriveNeedsYou({ catalog: CATALOG, coverage: NO_COVERAGE, surface: AFTER_REJECT });
    // SET-EQUALITY over the whole item list, so a second stray item reddens too.
    expect(data.items.map((item) => item.kind)).toEqual(["PLAN_REJECTED"]);
    const item = data.items[0];
    if (item === undefined) throw new Error("expected the sent-back item");
    expect(item.headline).toBe("The plan you sent back is being re-planned");
    expect(item.detail).toContain("compiling a new plan from the reason you gave");
    expect(item.goalId).toBe(RECORDED.goalId);
    expect(data.countLabel).toBe("1 decision needs you");
  });

  /**
   * THE DISAPPEARANCE, on the frame that replaces it. Without this arm an item that
   * never cleared would pass every assertion above.
   */
  it("replaces it with PLAN_APPROVAL the moment the successor is offered, never both", () => {
    // CONTROL: the two frames really do differ in what they list.
    expect(kindsOn(AFTER_REJECT)).toEqual(["PLAN_REJECTED"]);
    // The successor's offer is bound to the SUCCESSOR run, while the catalog still names
    // the rejected one - so this arm also pins that the approval item follows the run the
    // daemon offers, not the ref the catalog froze.
    const after = deriveNeedsYou({
      catalog: CATALOG, coverage: NO_COVERAGE, surface: AFTER_COMPILE,
    });
    expect(after.items.map((item) => item.kind)).toEqual(["PLAN_APPROVAL"]);
  });

  it("lists nothing for a goal the surface says nothing about", () => {
    const other: GoalCatalogFrame = Object.freeze({
      detail: "",
      goals: Object.freeze([Object.freeze({
        brief: null, goalId: "goal-someone-else", planningRunRef: "run-unrelated",
      })]),
      outcome: "GOALS",
    }) as unknown as GoalCatalogFrame;
    expect(deriveNeedsYou({ catalog: other, coverage: NO_COVERAGE, surface: AFTER_REJECT })
      .items).toEqual([]);
  });
});

describe("the opened goal's status strip after a plan is sent back", () => {
  it("reads PLAN_REJECTED with the words 'Plan sent back' and 'Waiting for a new plan'", () => {
    const status = deriveGoalStatus({
      coverage: null, goalId: RECORDED.goalId, runId: RECORDED.rejectedRunId, surface: AFTER_REJECT,
    });
    expect(status.stage).toBe("PLAN_REJECTED");
    expect(STAGE_WORDS[status.stage]).toBe("Plan sent back");
    expect(status.next.label).toBe("Waiting for a new plan");
    expect(status.next.anchor).toBe("plan");
    expect(status.headline).toContain("sent this plan back");
  });

  it("returns to PLAN once the successor is offered, so the stage cannot outlive the wait", () => {
    const status = deriveGoalStatus({
      coverage: null, goalId: RECORDED.goalId, runId: RECORDED.rejectedRunId, surface: AFTER_COMPILE,
    });
    // The catalog ref is STILL the rejected run; the PLAN branch keys on the offer, which
    // names the successor, so this also pins that PLAN_REJECTED does not shadow a real
    // decision once one exists.
    expect(status.stage).not.toBe("PLAN_REJECTED");
  });

  /**
   * EVERY stage has a word. The Record is exhaustive by type, but a `Record` satisfied
   * with an empty string would typecheck and render a blank label, so the VALUES are
   * asserted nonempty and the roster is asserted to cover the union in both directions.
   */
  it("gives every stage a nonempty word, and advertises no word for a stage that does not exist", () => {
    const stages = Object.keys(STAGE_WORDS);
    expect(stages.length).toBeGreaterThan(0);
    expect(stages).toContain("PLAN_REJECTED");
    for (const stage of stages) {
      expect(STAGE_WORDS[stage as keyof typeof STAGE_WORDS]).not.toBe("");
    }
    // Both directions: the words roster and the stages the deriver can actually return.
    const produced = new Set<string>();
    for (const surface of [AFTER_REJECT, AFTER_COMPILE, null]) {
      produced.add(deriveGoalStatus({
        coverage: null, goalId: RECORDED.goalId, runId: RECORDED.rejectedRunId, surface,
      }).stage);
    }
    for (const stage of produced) expect(stages).toContain(stage);
  });
});

/** An `/activity/read` entry, in the daemon's exact SEVEN-key shape. */
function decision(verdict: string | null): ActivityEntryView {
  return Object.freeze({
    commandKind: "approval.decide_intent",
    decidedAt: "2026-09-06T04:00:00.000Z",
    disposition: "COMMITTED",
    principalId: "principal-1",
    targetAggregateId: RECORDED.rejectedRunId,
    verdict,
    version: 4,
  });
}

describe("the decision feed on a rejected plan", () => {
  it("says 'rejected the plan' and tints the line BAD, while an approve stays good", () => {
    expect(decisionWords("approval.decide_intent", "REJECT")).toBe("rejected the plan");
    expect(toneOf(decision("REJECT"))).toBe("bad");
    // THE CONTROL, and the defect this arm closes: `approval.decide_intent` sits in the
    // feed's GOOD_KINDS set, so reading the kind alone tinted a REJECT green - the tone
    // contradicting the words on its own line. Both verdicts are asserted, so a rule that
    // simply returned "bad" for the kind would redden here.
    expect(decisionWords("approval.decide_intent", "APPROVE")).toBe("approved the plan");
    expect(toneOf(decision("APPROVE"))).toBe("good");
    // The caller-authored wire commits the same two verdicts and must agree.
    expect(toneOf({ ...decision("REJECT"), commandKind: "approval.decide" })).toBe("bad");
    // A version conflict changed nothing, so it is neither good nor bad.
    expect(toneOf({ ...decision("REJECT"), disposition: "VERSION_CONFLICT" })).toBe("none");
  });

  /**
   * DISCLOSED GAP, measured not assumed: the daemon exposes NO rejection reason on any read
   * this browser can decode. `/activity/read` entries are an exact seven-key shape
   * (commandKind, decidedAt, disposition, principalId, targetAggregateId, verdict, version)
   * carrying a verdict WORD and no reason, and the plan-review read carries none either
   * (`grep -rn "decisionReason\|rejectionReason" apps/daemon/src/http/*.ts` -> 0). This arm
   * PINS that absence so the day a reason field lands, it reddens and is wired through
   * rather than silently ignored.
   */
  it("carries no reason field to render, and this pins that gap rather than inventing one", () => {
    expect(Object.keys(decision("REJECT")).sort()).toEqual([
      "commandKind", "decidedAt", "disposition", "principalId", "targetAggregateId",
      "verdict", "version",
    ]);
  });
});
