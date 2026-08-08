import { describe, expect, it } from "vitest";

import type { ReviewerCalibration, ReviewerIndependenceInput } from "./review-contract.js";
import {
  assessReviewerIndependence,
  qualifyReviewerForAcceptance,
  reviewerCalibrationDigest,
} from "./reviewer-eligibility.js";

/**
 * Fixtures are hand-transcribed rather than derived from the module under test: a module-scope
 * const that dereferences the subject aborts collection and reports `(0 test)` instead of naming
 * the broken assertion.
 */
const LATTICE = ["INDEPENDENT", "NOT_INDEPENDENT", "UNKNOWN"] as const;
const AUTHOR = "principal:author";
const REVIEWER = "principal:reviewer";
const SUBJECT = "node:alpha";
const OTHER_SUBJECT = "node:beta";

const CURRENT_CALIBRATION: ReviewerCalibration = {
  corpusRevision: "corpus/2026-08",
  sentinelPassed: true,
  staleness: "CURRENT",
};

function facts(overrides: Partial<ReviewerIndependenceInput> = {}): ReviewerIndependenceInput {
  return {
    authors: [AUTHOR],
    authorshipResolved: true,
    leaseHistory: [],
    leaseHistoryResolved: true,
    reviewer: REVIEWER,
    subjectRef: SUBJECT,
    ...overrides,
  };
}

describe("reviewer independence verdict", () => {
  it("refuses the author with REVIEWER_IS_AUTHOR", () => {
    const assessment = assessReviewerIndependence(facts({ reviewer: AUTHOR }));

    expect(assessment.verdict).toBe("NOT_INDEPENDENT");
    expect(assessment.reasonCodes).toEqual(["REVIEWER_IS_AUTHOR"]);
  });

  it("refuses a reviewer who held a mutating lease over the subject and released it", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistory: [{ kind: "MUTATING", principal: REVIEWER, subjectRef: SUBJECT }],
    }));

    expect(assessment.verdict).toBe("NOT_INDEPENDENT");
    expect(assessment.reasonCodes).toEqual(["REVIEWER_HELD_MUTATING_LEASE"]);
  });

  it("keeps a reviewer who held only a read-only lease over the subject independent", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistory: [{ kind: "READ_ONLY", principal: REVIEWER, subjectRef: SUBJECT }],
    }));

    expect(assessment.verdict).toBe("INDEPENDENT");
    expect(assessment.reasonCodes).toEqual([]);
  });

  it("keeps a reviewer whose mutating lease was over a different subject independent", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistory: [{ kind: "MUTATING", principal: REVIEWER, subjectRef: OTHER_SUBJECT }],
    }));

    expect(assessment.verdict).toBe("INDEPENDENT");
    expect(assessment.reasonCodes).toEqual([]);
  });

  it("ignores another principal's mutating lease over the subject", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistory: [{ kind: "MUTATING", principal: AUTHOR, subjectRef: SUBJECT }],
    }));

    expect(assessment.verdict).toBe("INDEPENDENT");
    expect(assessment.reasonCodes).toEqual([]);
  });

  it("yields UNKNOWN_REVIEWER_INDEPENDENCE when lease history cannot be resolved", () => {
    const assessment = assessReviewerIndependence(facts({ leaseHistoryResolved: false }));

    expect(assessment.verdict).toBe("UNKNOWN");
    expect(assessment.reasonCodes).toEqual(["UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("yields UNKNOWN_REVIEWER_INDEPENDENCE when authorship cannot be resolved", () => {
    const assessment = assessReviewerIndependence(facts({ authorshipResolved: false }));

    expect(assessment.verdict).toBe("UNKNOWN");
    expect(assessment.reasonCodes).toEqual(["UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("does not accept an empty authorship set as a resolved one", () => {
    const assessment = assessReviewerIndependence(facts({ authors: [] }));

    expect(assessment.verdict).toBe("UNKNOWN");
    expect(assessment.reasonCodes).toEqual(["UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("cannot prove an unnamed reviewer distinct from the authorship set", () => {
    const assessment = assessReviewerIndependence(facts({ reviewer: "" }));

    expect(assessment.verdict).toBe("UNKNOWN");
    expect(assessment.reasonCodes).toEqual(["UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("cannot scope a lease history to an unnamed subject", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistory: [{ kind: "MUTATING", principal: REVIEWER, subjectRef: "" }],
      subjectRef: "",
    }));

    expect(assessment.verdict).toBe("UNKNOWN");
    expect(assessment.reasonCodes).toEqual(["UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("lets a proven disqualification dominate an unresolvable fact, reporting both codes", () => {
    const assessment = assessReviewerIndependence(facts({
      leaseHistoryResolved: false,
      reviewer: AUTHOR,
    }));

    expect(assessment.verdict).toBe("NOT_INDEPENDENT");
    expect(assessment.reasonCodes)
      .toEqual(["REVIEWER_IS_AUTHOR", "UNKNOWN_REVIEWER_INDEPENDENCE"]);
  });

  it("names the honest independence level rather than claiming model independence", () => {
    expect(assessReviewerIndependence(facts()).level).toBe("ROLE_SEPARATED_CLEAN_CONTEXT");
  });

  it("answers on the three-valued lattice, never a boolean", () => {
    const observed = [
      assessReviewerIndependence(facts()).verdict,
      assessReviewerIndependence(facts({ reviewer: AUTHOR })).verdict,
      assessReviewerIndependence(facts({ leaseHistoryResolved: false })).verdict,
    ];

    expect(observed).toEqual(["INDEPENDENT", "NOT_INDEPENDENT", "UNKNOWN"]);
    expect(new Set(observed).size).toBe(3);
    for (const verdict of observed) expect(LATTICE).toContain(verdict);
  });
});

describe("reviewer calibration determinism", () => {
  it("returns the identical assessment for the identical facts across repeated calls", () => {
    const first = assessReviewerIndependence(facts());
    for (let round = 0; round < 32; round += 1) {
      expect(assessReviewerIndependence(facts())).toEqual(first);
    }
  });

  it("derives the calibration digest from the reviewer and the subject", () => {
    const base = reviewerCalibrationDigest(facts());

    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(reviewerCalibrationDigest(facts())).toBe(base);
    expect(reviewerCalibrationDigest(facts({ reviewer: "principal:other" }))).not.toBe(base);
    expect(reviewerCalibrationDigest(facts({ subjectRef: OTHER_SUBJECT }))).not.toBe(base);
  });

  it("does not vary with the order the lease history happens to arrive in", () => {
    const forward = reviewerCalibrationDigest(facts({
      leaseHistory: [
        { kind: "READ_ONLY", principal: REVIEWER, subjectRef: SUBJECT },
        { kind: "MUTATING", principal: AUTHOR, subjectRef: SUBJECT },
      ],
    }));
    const reversed = reviewerCalibrationDigest(facts({
      leaseHistory: [
        { kind: "MUTATING", principal: AUTHOR, subjectRef: SUBJECT },
        { kind: "READ_ONLY", principal: REVIEWER, subjectRef: SUBJECT },
      ],
    }));

    expect(forward).toBe(reversed);
  });

  it("publishes the calibration digest on the assessment it calibrated", () => {
    expect(assessReviewerIndependence(facts()).calibrationDigest)
      .toBe(reviewerCalibrationDigest(facts()));
  });
});

const CALIBRATION_REFUSALS: readonly (readonly [string, ReviewerCalibration, string])[] = [
  ["stale calibration", { ...CURRENT_CALIBRATION, staleness: "STALE" },
    "REVIEWER_CALIBRATION_STALE"],
  ["unproven currency", { ...CURRENT_CALIBRATION, staleness: "UNKNOWN" },
    "REVIEWER_CALIBRATION_UNPROVEN"],
  ["failed sentinel set", { ...CURRENT_CALIBRATION, sentinelPassed: false },
    "REVIEWER_CALIBRATION_UNPROVEN"],
  ["unnamed corpus revision", { ...CURRENT_CALIBRATION, corpusRevision: "" },
    "REVIEWER_CALIBRATION_UNPROVEN"],
];

describe("reviewer acceptance qualification gate", () => {
  it("sweeps a non-zero number of calibration refusal cases", () => {
    expect(CALIBRATION_REFUSALS.length).toBe(4);
  });

  it("qualifies an independent, currently calibrated reviewer", () => {
    const result = qualifyReviewerForAcceptance(facts(), CURRENT_CALIBRATION);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected qualification");
    expect(result.value.calibrationEligible).toBe(true);
    expect(result.value.independence.verdict).toBe("INDEPENDENT");
    expect(result.value.reasonCodes).toEqual([]);
  });

  it("produces no acceptance qualification when independence is UNKNOWN", () => {
    const result = qualifyReviewerForAcceptance(
      facts({ leaseHistoryResolved: false }),
      CURRENT_CALIBRATION,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("UNKNOWN_REVIEWER_INDEPENDENCE");
    expect(result.layer).toBe("ELIGIBILITY");
    expect(result).not.toHaveProperty("value");
  });

  it("produces no acceptance qualification when independence is NOT_INDEPENDENT", () => {
    const result = qualifyReviewerForAcceptance(facts({ reviewer: AUTHOR }), CURRENT_CALIBRATION);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("REVIEWER_IS_AUTHOR");
    expect(result.layer).toBe("ELIGIBILITY");
    expect(result).not.toHaveProperty("value");
  });

  it("refuses a prior mutating lease holder with its own code, not the author code", () => {
    const result = qualifyReviewerForAcceptance(
      facts({ leaseHistory: [{ kind: "MUTATING", principal: REVIEWER, subjectRef: SUBJECT }] }),
      CURRENT_CALIBRATION,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("REVIEWER_HELD_MUTATING_LEASE");
    expect(result.layer).toBe("ELIGIBILITY");
  });

  it.each(CALIBRATION_REFUSALS)(
    "refuses an independent reviewer with %s",
    (_label, calibration, code) => {
      const result = qualifyReviewerForAcceptance(facts(), calibration);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe(code);
      expect(result.layer).toBe("ELIGIBILITY");
    },
  );
});
