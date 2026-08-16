import { REVIEW_ESCALATION_ROUND_LIMIT } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";

import { readReviewLedger } from "./review-ledger.js";
import {
  NODE_VERIFIER_PRINCIPAL_ID,
  recordVerifierReceipt,
} from "./verifier-receipt-ledger.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  calibration,
  closeStores,
  decisionCount,
  driveRounds,
  envelope,
  escalationPayload,
  finding,
  openStore,
  packageItems,
  policyInput,
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
  receiptId: string,
  overrides: Record<string, unknown> = {},
  commandId = "cmd-accept",
): ReturnType<typeof send> {
  return send(
    store,
    envelope("integration.accept_output", expectedVersion, {
      receiptId,
      subjectRef: SUBJECT_REF,
      ...overrides,
    }, commandId),
  );
}

function cleanRound(store: ReturnType<typeof openStore>): void {
  const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  const round = ledger.lineage.highestRound + 1;
  const outcome = send(store, envelope(
    "review.submit",
    ledger.version,
    submitPayload(round, []),
    `cmd-clean-${String(round)}`,
  ));
  if (!outcome.ok) throw new Error(outcome.code);
}

function issueReceipt(
  store: ReturnType<typeof openStore>,
  overrides: Partial<{
    calibration: ReturnType<typeof calibration>;
    policy: ReturnType<typeof policyInput>;
  }> = {},
) {
  const latest = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1);
  if (latest === undefined) throw new Error("missing verifier receipt source round");
  const outcome = recordVerifierReceipt(store, {
    authority: {
      calibration: overrides.calibration ?? calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: overrides.policy ?? policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    },
    decidedAt: "2026-08-16T00:00:00.000Z",
    execution: {
      byteCount: 2,
      outputSha256: "a".repeat(64),
      test: "pnpm test",
      workspace: "/workspace",
    },
    projectId: PROJECT_ID,
    source: {
      aggregateVersion: latest.aggregateVersion,
      decisionId: latest.decisionId,
      resultSha256: latest.resultSha256,
    },
    subjectRef: SUBJECT_REF,
  });
  return outcome;
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

describe("acceptance consumes one exact daemon verifier receipt (DoD 6)", () => {
  it("qualifies a clean receipt and records its durable identity", () => {
    const store = openStore();
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);

    const outcome = accept(store, receipt.decision.currentVersion, receipt.receipt.receiptId);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const accepted = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted;
    expect(accepted?.policyDecision).toBe("ALLOW");
    expect(accepted?.reviewInputDigest).toBe(receipt.receipt.reviewInputDigest);
    expect(accepted?.verifierReceiptId).toBe(receipt.receipt.receiptId);
    expect(accepted?.verifierReceiptSha256).toBe(receipt.decision.resultSha256);
  });

  it("refuses a missing receipt and commits nothing", () => {
    const store = openStore();
    cleanRound(store);
    const before = decisionCount(store);

    const outcome = accept(store, 1, "f".repeat(64));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_VERIFIER_RECEIPT_NOT_FOUND");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  it("rejects the former caller-authored authority fields at ingress", () => {
    const store = openStore();
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);
    const before = decisionCount(store);

    const outcome = accept(store, receipt.decision.currentVersion, receipt.receipt.receiptId, {
      calibration: calibration(),
      packageItems: packageItems(),
      policy: policyInput(),
      proof: "PASSED",
      reviewer: { reviewer: "caller" },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a receipt after a newer clean round wins the aggregate", () => {
    const store = openStore();
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);
    cleanRound(store);
    const before = decisionCount(store);

    const outcome = accept(store, 3, receipt.receipt.receiptId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_VERIFIER_RECEIPT_STALE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a receipt selected for a different subject", () => {
    const store = openStore();
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);
    const before = decisionCount(store);

    const outcome = accept(store, 0, receipt.receipt.receiptId, {
      subjectRef: "node-other",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_VERIFIER_RECEIPT_STALE");
    expect(decisionCount(store)).toBe(before);
  });

  it("consumes one receipt at most once across different accept command ids", () => {
    const store = openStore();
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);
    expect(accept(store, 2, receipt.receipt.receiptId, {}, "cmd-accept-first").ok).toBe(true);
    const before = decisionCount(store);

    const second = accept(store, 3, receipt.receipt.receiptId, {}, "cmd-accept-second");

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected refusal");
    expect(second.code).toBe("REVIEW_ALREADY_ACCEPTED");
    expect(decisionCount(store)).toBe(before);
  });

  it("qualifies against the lineage durably recorded before the clean source", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    cleanRound(store);
    const receipt = issueReceipt(store);
    if (!receipt.ok) throw new Error(receipt.code);

    const outcome = accept(store, 3, receipt.receipt.receiptId);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.lineage.unsuccessfulRounds).toBe(1);
    expect(ledger.accepted).toBeDefined();
    expect(ledger.rounds).toHaveLength(2);
  });

  it("does not mint a receipt from stale calibration or a non-ALLOW policy", () => {
    for (const invalid of [
      { calibration: calibration({ staleness: "STALE" }) },
      { policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID, facts: [] }) },
    ]) {
      const store = openStore();
      cleanRound(store);
      const before = decisionCount(store);
      const receipt = issueReceipt(store, invalid);
      expect(receipt).toEqual({ code: "VERIFIER_AUTHORITY_REFUSED", ok: false });
      expect(decisionCount(store)).toBe(before);
      store.close();
    }
  });
});
