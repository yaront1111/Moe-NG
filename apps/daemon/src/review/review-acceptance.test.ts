import { REVIEW_ESCALATION_ROUND_LIMIT } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";

import { readReviewLedger } from "./review-ledger.js";
import {
  AUTHOR,
  PROJECT_ID,
  REVIEWER,
  SUBJECT_REF,
  acceptancePayload,
  calibration,
  closeStores,
  decisionCount,
  driveRounds,
  envelope,
  escalationPayload,
  finding,
  openStore,
  policyInput,
  reviewerFacts,
  send,
  submit,
  submitPayload,
} from "./review-test-fixtures.js";

/**
 * The round counter and explicit escalation (DoD 4), and the acceptance gate (DoD 6).
 *
 * Every refusal here is proven by READING THE STORE BACK rather than by the returned value: a
 * handler that mutated and then refused would pass a return-value-only assertion, which is the
 * near-miss this board has hit before.
 */

afterEach(closeStores);

/**
 * Pinned in exactly ONE place. Everything else drives off the constant, so raising the limit
 * upstream reddens this single case — a conscious act — instead of silently changing what the
 * boundary cases mean.
 */
it("reads the escalation limit from @moe/review rather than a local copy", () => {
  expect(REVIEW_ESCALATION_ROUND_LIMIT).toBe(3);
});

function escalate(
  store: ReturnType<typeof openStore>,
  expectedVersion: number,
): ReturnType<typeof send> {
  return send(
    store,
    envelope("escalation.decide", expectedVersion, escalationPayload(), "cmd-escalate"),
  );
}

function accept(
  store: ReturnType<typeof openStore>,
  expectedVersion: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof send> {
  return send(
    store,
    envelope("integration.accept_output", expectedVersion, acceptancePayload(overrides), "cmd-accept"),
  );
}

describe("the three-round counter is durable and escalation is explicit (DoD 4)", () => {
  it("does not escalate below the limit", () => {
    const store = openStore();
    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT - 1);
    const before = decisionCount(store);

    const outcome = escalate(store, REVIEW_ESCALATION_ROUND_LIMIT - 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_ESCALATION_NOT_REACHED");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).escalated).toBe(false);
  });

  it("routes the round that reaches the limit to ESCALATE with the kernel's code", () => {
    const store = openStore();

    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT);

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.lineage.unsuccessfulRounds).toBe(REVIEW_ESCALATION_ROUND_LIMIT);
    const last = ledger.rounds[REVIEW_ESCALATION_ROUND_LIMIT - 1];
    expect(last?.routing.route).toBe("ESCALATE");
    expect(last?.routing.reasonCodes).toEqual(["REVIEW_ROUND_CAP_REACHED"]);
    // The round BEFORE the limit did not escalate: the boundary is at the limit, not near it.
    expect(ledger.rounds[REVIEW_ESCALATION_ROUND_LIMIT - 2]?.routing.route)
      .toBe("REJECT_IMPLEMENTATION");
    expect(ledger.escalated).toBe(false);
  });

  it("records an explicit escalation once the limit is reached", () => {
    const store = openStore();
    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT);

    const outcome = escalate(store, REVIEW_ESCALATION_ROUND_LIMIT);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).escalated).toBe(true);
  });

  it("refuses a further round that would proceed as if unescalated", () => {
    const store = openStore();
    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT);
    const before = decisionCount(store);

    const outcome = send(store, envelope("review.submit", REVIEW_ESCALATION_ROUND_LIMIT,
      submitPayload(REVIEW_ESCALATION_ROUND_LIMIT + 1, [
        finding({ ruleId: "rule-4", subject: { kind: "NODE", locator: "node-4" } }),
      ]), "cmd-round-past-cap"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_ESCALATION_REQUIRED");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds)
      .toHaveLength(REVIEW_ESCALATION_ROUND_LIMIT);
  });

  it("admits the further round once the escalation is durably recorded", () => {
    const store = openStore();
    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT);
    expect(escalate(store, REVIEW_ESCALATION_ROUND_LIMIT).ok).toBe(true);

    const outcome = send(store, envelope("review.submit", REVIEW_ESCALATION_ROUND_LIMIT + 1,
      submitPayload(REVIEW_ESCALATION_ROUND_LIMIT + 1, [
        finding({ ruleId: "rule-4", subject: { kind: "NODE", locator: "node-4" } }),
      ]), "cmd-round-after-escalation"));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds)
      .toHaveLength(REVIEW_ESCALATION_ROUND_LIMIT + 1);
  });
});

describe("acceptance is qualified by @moe/review and commits nothing when refused (DoD 6)", () => {
  it("qualifies a clean acceptance and records it durably", () => {
    const store = openStore();

    const outcome = accept(store, 0);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    const accepted = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted;
    expect(accepted?.policyDecision).toBe("ALLOW");
    expect(accepted?.reviewInputDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  const REFUSALS = [
    {
      code: "REVIEWER_IS_AUTHOR",
      layer: "ELIGIBILITY",
      name: "a reviewer who authored the subject",
      overrides: { reviewer: reviewerFacts({ authors: [AUTHOR, REVIEWER] }) },
    },
    {
      code: "REVIEWER_HELD_MUTATING_LEASE",
      layer: "ELIGIBILITY",
      name: "a reviewer who held a mutating lease over the subject",
      overrides: {
        reviewer: reviewerFacts({
          leaseHistory: [{ kind: "MUTATING", principal: REVIEWER, subjectRef: SUBJECT_REF }],
        }),
      },
    },
    {
      code: "UNKNOWN_REVIEWER_INDEPENDENCE",
      layer: "ELIGIBILITY",
      name: "an independence fact that could not be resolved",
      overrides: { reviewer: reviewerFacts({ authorshipResolved: false }) },
    },
    {
      code: "REVIEWER_CALIBRATION_STALE",
      layer: "ELIGIBILITY",
      name: "a reviewer whose calibration is stale",
      overrides: { calibration: calibration({ staleness: "STALE" }) },
    },
    {
      code: "REVIEWER_CALIBRATION_UNPROVEN",
      layer: "ELIGIBILITY",
      name: "a reviewer whose calibration was never proven",
      overrides: { calibration: calibration({ sentinelPassed: false }) },
    },
    // PROOF_FAILED and PROOF_UNKNOWN are SEPARATE fixtures on purpose: "we checked and it
    // failed" and "we could not tell" are different facts, and only one of them might later
    // become provable. A single "not passed" fixture would collapse them.
    {
      code: "PROOF_FAILED",
      layer: "ACCEPTANCE",
      name: "proof that was checked and failed",
      overrides: { proof: "FAILED" },
    },
    {
      code: "PROOF_UNKNOWN",
      layer: "ACCEPTANCE",
      name: "proof that could not be determined",
      overrides: { proof: "UNKNOWN" },
    },
  ] as const;

  it("declares every acceptance refusal case it sweeps", () => {
    expect(REFUSALS).toHaveLength(7);
    expect(new Set(REFUSALS.map((entry) => entry.code)).size).toBe(7);
  });

  it.each(REFUSALS.map((entry) => [entry.name, entry] as const))(
    "refuses %s and commits nothing",
    (_name, entry) => {
      const store = openStore();
      const before = decisionCount(store);

      const outcome = accept(store, 0, entry.overrides);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.code).toBe(entry.code);
      expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
      expect(outcome.kernelLayer).toBe(entry.layer);
      expect(outcome.authority).toBe("NONE");
      // Read the store back. A handler that mutated and then refused would pass every
      // assertion above this line.
      expect(decisionCount(store)).toBe(before);
      expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted).toBeUndefined();
    },
  );

  it("refuses when the core's policy verdict is not ALLOW, and commits nothing", () => {
    const store = openStore();
    const before = decisionCount(store);

    // No classified fact, so `evaluatePolicy` cannot derive a risk tier and answers HOLD_UNKNOWN.
    // Unclassified risk must never auto-approve, and the review layer must not talk past that.
    const outcome = accept(store, 0, { policy: policyInput({ facts: [] }) });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("ACCEPTANCE_POLICY_REFUSED");
    expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
    expect(outcome.kernelLayer).toBe("ACCEPTANCE");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted).toBeUndefined();
  });

  it("never auto-accepts a subject that has reached the round cap", () => {
    const store = openStore();
    driveRounds(store, REVIEW_ESCALATION_ROUND_LIMIT);
    const before = decisionCount(store);

    const outcome = accept(store, REVIEW_ESCALATION_ROUND_LIMIT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_ROUND_CAP_REACHED");
    expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
    expect(outcome.kernelLayer).toBe("FINDINGS");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted).toBeUndefined();
  });

  it("qualifies an acceptance against the lineage that is actually stored", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);

    // One unsuccessful round is below the cap, so the acceptance is qualified — but it is
    // qualified against the DURABLE lineage, not an empty one handed in by the caller.
    const outcome = accept(store, 1);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.lineage.unsuccessfulRounds).toBe(1);
    expect(ledger.accepted).toBeDefined();
    // The earlier round survives the acceptance untouched.
    expect(ledger.rounds).toHaveLength(1);
  });
});
