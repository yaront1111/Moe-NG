import { describe, expect, it } from "vitest";

import type { ReviewFinding, ReviewLineage } from "./review-contract.js";
import { EMPTY_REVIEW_LINEAGE, recordReviewRound } from "./review-findings.js";
import type { ReviewRoundInput } from "./review-findings.js";

/**
 * Admission of the round NUMBER itself, which the append-only ordering comparison cannot police.
 * `NaN <= lastRound` is false like every other comparison against NaN, so before this guard the
 * ordering check simply did not fire and a record carrying `round: NaN` was appended.
 *
 * Fixtures are hand-transcribed; nothing at module scope dereferences a module under test,
 * because that aborts collection and reports `(0 test)` instead of naming the broken assertion.
 */
const MISSING_ORACLE: ReviewFinding = {
  detail: "the acceptance recipe asserts nothing about the criterion",
  ruleId: "rule:oracle-adequacy",
  severity: "CRITICAL",
  subject: { kind: "CRITERION", locator: "criterion:oracle" },
};

/** A distinct typed subject, so its fingerprint cannot collide with MISSING_ORACLE's. */
const OTHER_SUBJECT: ReviewFinding = {
  detail: "the acceptance recipe asserts nothing about the criterion",
  ruleId: "rule:oracle-adequacy",
  severity: "CRITICAL",
  subject: { kind: "CRITERION", locator: "criterion:scope" },
};

/** Builds the input without letting TypeScript reject the deliberately ill-typed shapes. */
function roundInput(round: unknown): ReviewRoundInput {
  return { findings: [MISSING_ORACLE], round } as ReviewRoundInput;
}

/** Names the refusing code when a round that was meant to land does not, rather than hiding it. */
function recorded(lineage: ReviewLineage, round: number, findings: readonly ReviewFinding[]) {
  const result = recordReviewRound(lineage, { findings, round });
  if (!result.ok) throw new Error(`expected a recorded round, refused with ${result.code}`);
  return result.value;
}

/**
 * Both the digest gate and the round-admission gate can refuse here, so every assertion pins the
 * exact code. `ok: false` alone would stay green if the wrong guard began answering first.
 *
 * `not.toThrow` is load-bearing rather than decorative. Without admission most of these shapes
 * reached `canonicalDigest` and died there with an unstructured `TypeError` — measured, e.g.
 * `canonical JSON supports safe integers only` for NaN. A crash is not a refusal: it names no
 * reason code, so the caller cannot tell a malformed round from a broken digest.
 */
function expectRoundInvalid(round: unknown): void {
  expect(() => recordReviewRound(EMPTY_REVIEW_LINEAGE, roundInput(round))).not.toThrow();

  const result = recordReviewRound(EMPTY_REVIEW_LINEAGE, roundInput(round));

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got an accepted round");
  expect(result.code).toBe("FINDING_ROUND_INVALID");
  expect(result.layer).toBe("FINDINGS");
}

describe("review round number admission", () => {
  it("refuses a NaN round instead of letting it slip past the ordering comparison", () => {
    expectRoundInvalid(Number.NaN);
  });

  it("does not append a record when the round number is NaN", () => {
    const result = recordReviewRound(EMPTY_REVIEW_LINEAGE, roundInput(Number.NaN));

    expect(result).not.toHaveProperty("value");
    expect(EMPTY_REVIEW_LINEAGE.records).toHaveLength(0);
  });

  /**
   * Measured, not assumed: with admission removed a numeric STRING is the shape that actually
   * reached a stored `ReviewFindingRecord`. `"2" <= 0` is false so the ordering guard let it by,
   * and unlike NaN it canonicalises cleanly, so nothing downstream objected either. It is the one
   * shape for which the whole function returned `ok: true` carrying a non-number `round`.
   */
  it("keeps a non-number round out of a stored record entirely", () => {
    const result = recordReviewRound(EMPTY_REVIEW_LINEAGE, roundInput("2"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal, got an accepted round");
    expect(result.code).toBe("FINDING_ROUND_INVALID");
    expect(EMPTY_REVIEW_LINEAGE.records).toHaveLength(0);
  });

  it("refuses a positive infinite round", () => {
    expectRoundInvalid(Number.POSITIVE_INFINITY);
  });

  it("refuses a negative infinite round", () => {
    expectRoundInvalid(Number.NEGATIVE_INFINITY);
  });

  it("refuses a fractional round", () => {
    expectRoundInvalid(1.5);
  });

  it("refuses a negative round", () => {
    expectRoundInvalid(-3);
  });

  it("refuses a round beyond the safe-integer range, where increments stop being distinct", () => {
    expectRoundInvalid(2 ** 53);
  });

  it("refuses a round that is not a number at all", () => {
    expectRoundInvalid("2");
  });
});

/**
 * The admission guard was ADDED in front of the ordering comparison, not substituted for it.
 * These assertions fail if the ordering guard was weakened or if admission started answering for
 * a well-formed round, so the two facts stay distinguishable by code.
 */
/**
 * Every shape the admission guard must reject, swept as one table. The label set and the length
 * are hand-written literals rather than derived from the table, because a table cannot police its
 * own generator: a sweep that silently produced zero cases would otherwise pass while asserting
 * nothing.
 */
const REJECTED_ROUND_SHAPES: readonly { readonly label: string; readonly round: unknown }[] = [
  { label: "NaN", round: Number.NaN },
  { label: "positive infinity", round: Number.POSITIVE_INFINITY },
  { label: "negative infinity", round: Number.NEGATIVE_INFINITY },
  { label: "a fraction", round: 1.5 },
  { label: "a negative integer", round: -3 },
  { label: "beyond the safe-integer range", round: 2 ** 53 },
  { label: "a numeric string", round: "2" },
  { label: "null", round: null },
  { label: "undefined", round: undefined },
  { label: "an object whose valueOf returns a number", round: { valueOf: () => 2 } },
];

describe("rejected round shapes", () => {
  it("sweeps exactly the ten shapes named here", () => {
    expect(REJECTED_ROUND_SHAPES).toHaveLength(10);
    expect(REJECTED_ROUND_SHAPES.map((shape) => shape.label)).toEqual([
      "NaN",
      "positive infinity",
      "negative infinity",
      "a fraction",
      "a negative integer",
      "beyond the safe-integer range",
      "a numeric string",
      "null",
      "undefined",
      "an object whose valueOf returns a number",
    ]);
  });

  for (const shape of REJECTED_ROUND_SHAPES) {
    it(`refuses ${shape.label} with FINDING_ROUND_INVALID`, () => {
      expectRoundInvalid(shape.round);
    });
  }
});

describe("round admission did not replace the append-only guard", () => {
  it("still refuses a repeated round with FINDING_LINEAGE_APPEND_ONLY", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const replay = recordReviewRound(first.lineage, roundInput(1));

    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected a refusal");
    expect(replay.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
    expect(replay.layer).toBe("FINDINGS");
  });

  it("still refuses an out-of-order earlier round with FINDING_LINEAGE_APPEND_ONLY", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const fifth = recorded(first.lineage, 5, [OTHER_SUBJECT]);
    const late = recordReviewRound(fifth.lineage, roundInput(3));

    expect(late.ok).toBe(false);
    if (late.ok) throw new Error("expected a refusal");
    expect(late.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
    expect(late.layer).toBe("FINDINGS");
  });

  it("advances the append-only frontier past a CLEAN (accepting) round, which appends no record", () => {
    // The bug: a clean round routes ACCEPT and appends no finding record, so a
    // frontier read only off records() forgot the round number entirely, and an
    // earlier or equal round could be resubmitted AFTER an acceptance.
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const cleanFifth = recorded(first.lineage, 5, []);
    expect(cleanFifth.routing.route).toBe("ACCEPT");
    expect(cleanFifth.lineage.records).toHaveLength(1); // no record was appended
    expect(cleanFifth.lineage.highestRound).toBe(5);

    for (const stale of [3, 5]) {
      const late = recordReviewRound(cleanFifth.lineage, roundInput(stale));
      expect(late.ok).toBe(false);
      if (late.ok) throw new Error(`round ${String(stale)} should be refused after the clean round`);
      expect(late.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
    }
    // A round PAST the clean frontier still lands.
    const sixth = recordReviewRound(cleanFifth.lineage, roundInput(6));
    expect(sixth.ok).toBe(true);
  });

  it("a clean round on an empty lineage advances the frontier too", () => {
    expect(EMPTY_REVIEW_LINEAGE.highestRound).toBe(0);
    const clean = recorded(EMPTY_REVIEW_LINEAGE, 2, []);
    expect(clean.routing.route).toBe("ACCEPT");
    expect(clean.lineage.highestRound).toBe(2);
    expect(recordReviewRound(clean.lineage, roundInput(1)).ok).toBe(false);
    expect(recordReviewRound(clean.lineage, roundInput(2)).ok).toBe(false);
  });

  it("refuses round 0 against an empty lineage as append-only, not as inadmissible", () => {
    const result = recordReviewRound(EMPTY_REVIEW_LINEAGE, roundInput(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
  });

  it("refuses a lineage whose digest does not attest, before it considers the round", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const forged: ReviewLineage = { ...first.lineage, records: [] };
    const result = recordReviewRound(forged, roundInput(Number.NaN));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("FINDING_LINEAGE_DIGEST_MISMATCH");
  });
});

describe("round admission left the routing behaviour untouched", () => {
  it("accepts a well-formed increasing round and appends its record", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [OTHER_SUBJECT]);

    expect(second.lineage.records).toHaveLength(2);
    expect(second.lineage.records.map((record) => record.round)).toEqual([1, 2]);
    expect(second.lineage.digest).not.toBe(first.lineage.digest);
  });

  it("still routes a repeated fingerprint to REJECT_PLAN", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [MISSING_ORACLE]);

    expect(second.routing.route).toBe("REJECT_PLAN");
    expect(second.routing.layer).toBe("FINDINGS");
    expect(second.routing.repeatFingerprints).toHaveLength(1);
  });

  it("still routes fresh findings to REJECT_IMPLEMENTATION", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [OTHER_SUBJECT]);

    expect(second.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(second.routing.repeatFingerprints).toEqual([]);
  });
});
