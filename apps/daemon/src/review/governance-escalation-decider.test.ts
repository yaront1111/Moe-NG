import { afterEach, describe, expect, it } from "vitest";

import type { GovernancePolicy } from "./governance-policy-settings.js";
import { decideGovernanceEscalation } from "./governance-escalation-decider.js";
import type { GovernanceAdvisor } from "./governance-escalation-decider.js";
import { reviewContinuationAvailable } from "./review-continuation.js";
import { readReviewLedger } from "./review-read-model.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  driveRounds,
  openStore,
} from "./review-test-fixtures.js";

/**
 * The arms governance can reach WITHOUT funding an attempt: refusing to act, and replanning.
 *
 * Funding an attempt needs guidance that attests against a durable submission source — a real
 * approved plan, graph hash and bound criteria — which this lightweight fixture deliberately
 * does not build. Those arms are proven against the real world in
 * `governance-escalation-decider-live.test.ts` instead of being faked here.
 *
 * Every assertion reads the durable store back. A decider that returned the right word while
 * committing nothing would pass a return-value-only suite, and the durable decision is the
 * entire point of this seam.
 */

const OPEN: GovernancePolicy = Object.freeze({ kind: "AI_GOVERNOR", maxDecisions: 1 });
const CLOSED: GovernancePolicy = Object.freeze({ kind: "REQUIRE_HUMAN" });
const clock = (): string => "2026-09-16T00:00:00.000Z";

const answers: GovernanceAdvisor = (brief) => ({
  decisions: brief.questions.map((question) => ({
    answer: "shared.obligation.description is SET.",
    basis: "GOVERNANCE_DECIDED" as const,
    citation: null,
    criterionId: question.criterionId,
    findingId: question.findingId,
    question: question.detail,
    rationale: "The product record is silent, and SET is the lossless choice.",
    reviewVersion: brief.reviewVersion,
    subjectRef: brief.subjectRef,
    supersedes: null,
  })),
  guidance: "REGISTRY REVIEW - RECORDED DECISION. description is SET; record it in ADR 0011.",
});
const silent: GovernanceAdvisor = () => null;
const throws: GovernanceAdvisor = () => { throw new Error("the advisor died"); };

/**
 * `policy` is REQUIRED rather than defaulted. A default parameter applies to an explicitly
 * passed `undefined` too, so a defaulted helper silently turned the "no policy stated" case into
 * the open one — the exact case this suite most needs to be able to state.
 */
const depsFor = (
  store: ReturnType<typeof openStore>,
  advisor: GovernanceAdvisor,
  policy: GovernancePolicy | undefined,
) => ({ advisor, clock, policy, projectId: PROJECT_ID, store });

/** Three unsuccessful rounds with distinct findings: the round cap, not a stall. */
function exhausted(): ReturnType<typeof openStore> {
  const store = openStore();
  driveRounds(store, 3);
  return store;
}

afterEach(closeStores);

describe("when governance is not the one to answer", () => {
  it("is closed with no policy stated, so the human's button stays the only way", () => {
    const store = exhausted();

    expect(decideGovernanceEscalation(depsFor(store, answers, undefined), SUBJECT_REF))
      .toEqual({ kind: "CLOSED" });
    expect(decideGovernanceEscalation(depsFor(store, answers, CLOSED), SUBJECT_REF))
      .toEqual({ kind: "CLOSED" });

    // Nothing was decided on the way to saying no.
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.replanned).toBe(false);
    expect(reviewContinuationAvailable(ledger)).toBe(false);
  });

  it("does not decide before the review is actually exhausted", () => {
    const store = openStore();
    driveRounds(store, 1);

    expect(decideGovernanceEscalation(depsFor(store, answers, OPEN), SUBJECT_REF))
      .toEqual({ kind: "NOT_DUE" });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });
});

describe("governance stopping rather than retiring a node's work", () => {
  // Measured on UnAI 2026-09-16: these arms used to commit a REPLAN, which retires the node —
  // while successor CREATION lives in the control room, so nothing replaced it. Two nodes were
  // retired 22 ms apart, no successors appeared, and the failure being replanned was
  // environmental, so every successor would have hit the same wall. The `replanned` assertions
  // below are the pin: governance may stop, but it may not destroy work it cannot replace.
  it("stops when it has no answer, leaving the node for the human", () => {
    const store = exhausted();

    expect(decideGovernanceEscalation(depsFor(store, silent, OPEN), SUBJECT_REF))
      .toEqual({ kind: "HUMAN_NEEDED", why: "NO_ANSWER" });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("stops when the advisor throws, without retiring the node on a dead advisor", () => {
    const store = exhausted();

    expect(decideGovernanceEscalation(depsFor(store, throws, OPEN), SUBJECT_REF))
      .toEqual({ kind: "HUMAN_NEEDED", why: "NO_ANSWER" });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("stops once its bound is spent instead of funding attempts without end", () => {
    // The bound is the safety the policy cannot be constructed without. At zero, governance may
    // never fund an attempt at all — a stated stance, and the cheapest proof the arm is live.
    const store = exhausted();
    const bounded: GovernancePolicy = { kind: "AI_GOVERNOR", maxDecisions: 0 };

    expect(decideGovernanceEscalation(depsFor(store, answers, bounded), SUBJECT_REF))
      .toEqual({ kind: "HUMAN_NEEDED", why: "BOUND_SPENT" });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("does not ask the advisor at all once the bound is spent", () => {
    // Asking would spend a model call to reach a conclusion already fixed by the policy.
    const store = exhausted();
    let asked = 0;
    const counting: GovernanceAdvisor = (brief) => { asked += 1; return answers(brief); };

    decideGovernanceEscalation(
      depsFor(store, counting, { kind: "AI_GOVERNOR", maxDecisions: 0 }), SUBJECT_REF,
    );

    expect(asked).toBe(0);
  });
});
