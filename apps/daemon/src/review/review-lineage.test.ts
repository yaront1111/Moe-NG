import { REVIEW_REASON_CODES } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";

import { readReviewLedger } from "./review-ledger.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  commitRaw,
  decisionCount,
  decisionRows,
  envelope,
  finding,
  hex64,
  openStore,
  send,
  submit,
  submitPayload,
  tamperedRoundResult,
} from "./review-test-fixtures.js";

/**
 * Append-only finding lineage (DoD 2) and the boundary between what the daemon validates and
 * what `@moe/review` decides.
 *
 * Split out of review-services.test.ts to keep both files in range; these cases are all about
 * what SURVIVES rather than about what one command returns.
 */

afterEach(closeStores);

describe("finding lineage is append-only and stays readable (DoD 2)", () => {
  it("leaves an earlier round byte-identical once a successor exists", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    const firstRow = decisionRows(store)[0];
    expect(firstRow).toBeDefined();

    expect(submit(store, 2, [
      finding({ ruleId: "rule-2", subject: { kind: "NODE", locator: "node-beta" } }),
    ]).ok).toBe(true);

    const rows = decisionRows(store);
    expect(rows).toHaveLength(2);
    // Byte identity, not "a new row appeared" — an update in place would satisfy the latter.
    expect(rows[0]).toEqual(firstRow);
  });

  it("keeps every earlier round retrievable in order after a successor", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    expect(submit(store, 2, [
      finding({ ruleId: "rule-2", subject: { kind: "NODE", locator: "node-beta" } }),
    ]).ok).toBe(true);

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect(ledger.rounds[0]?.lineage.records).toHaveLength(1);
    expect(ledger.lineage.records.map((record) => record.round)).toEqual([1, 2]);
  });

  it("identifies a repeat by typed subject and rule, not by wording", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);

    // Same typed subject and rule, completely different prose: the same finding.
    const outcome = submit(store, 2, [finding({ detail: "Reworded entirely. Still the same." })]);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.rounds[1]?.routing.route).toBe("REJECT_PLAN");
    expect(ledger.rounds[1]?.routing.repeatFingerprints).toHaveLength(1);
  });

  it("does not treat identical wording about a different subject as a repeat", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);

    const outcome = submit(store, 2, [finding({ subject: { kind: "NODE", locator: "node-beta" } })]);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.rounds[1]?.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(ledger.rounds[1]?.routing.repeatFingerprints).toEqual([]);
  });

  it("refuses a finding that names no required change", () => {
    const store = openStore();

    // A blank locator names nothing, so the finding links to no required change at all.
    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [
      finding({ subject: { kind: "NODE", locator: "" } }),
    ])));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(0);
  });

  it("refuses a finding whose subject kind is outside the kernel's vocabulary", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [
      finding({ subject: { kind: "WHATEVER", locator: "node-alpha" } }),
    ])));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
  });
});

describe("the stored lineage is never trusted more than the kernel trusts it", () => {
  it("fails closed on a stored round whose bytes do not parse as a lineage", () => {
    const store = openStore();
    // Staged through the production commit seam: no handler would ever write this.
    expect(commitRaw(store, envelope("review.submit", 0, submitPayload(1), "cmd-staged"), {
      lineage: "not-a-lineage",
      reviewInputDigest: hex64("a1"),
      round: 1,
      routing: { layer: "FINDINGS", reasonCodes: [], repeatFingerprints: [], route: "ACCEPT" },
    }).ok).toBe(true);
    const before = decisionCount(store);

    const outcome = send(store, envelope("review.submit", 1, submitPayload(2), "cmd-after-corrupt"));

    // Reading it as "no rounds yet" would silently reset the escalation counter, which is the
    // attack the kernel's digest attestation exists to stop. It must refuse instead.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_LINEAGE_UNREADABLE");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).unreadable).toBe(true);
  });

  it("lets the kernel refuse a shape-valid lineage whose digest does not attest it", () => {
    const store = openStore();
    expect(commitRaw(
      store,
      envelope("review.submit", 0, submitPayload(1), "cmd-tampered"),
      tamperedRoundResult(),
    ).ok).toBe(true);
    const before = decisionCount(store);

    const outcome = send(store, envelope("review.submit", 1, submitPayload(2), "cmd-after-tamper"));

    // The daemon validates SHAPE and the kernel validates TRUTH. This case pins that division:
    // the shape gate passes it through and @moe/review is what refuses, under its own code and
    // its own layer. If the daemon started re-deciding attestation, the layer here would flip.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("FINDING_LINEAGE_DIGEST_MISMATCH");
    expect(REVIEW_REASON_CODES).toContain(outcome.code);
    expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
    expect(outcome.kernelLayer).toBe("FINDINGS");
    expect(decisionCount(store)).toBe(before);
  });
});
