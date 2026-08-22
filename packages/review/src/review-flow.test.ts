import { describe, expect, it } from "vitest";

import type { PolicyEvaluationInput } from "@moe/core";

import { REVIEW_ESCALATION_ROUND_LIMIT, REVIEW_PACKAGE_BOUND_FIELDS } from "./review-contract.js";
import type {
  ReviewFinding,
  ReviewLineage,
  ReviewPackageBoundField,
  ReviewPackageItemInput,
  ReviewerCalibration,
  ReviewerIndependenceInput,
} from "./review-contract.js";
import {
  EMPTY_REVIEW_LINEAGE,
  findingFingerprint,
  qualifyReviewAcceptance,
  recordReviewRound,
} from "./review-findings.js";
import type { ReviewAcceptanceInput } from "./review-findings.js";
import { buildReviewPackage } from "./review-package.js";

/**
 * Every fixture below is hand-transcribed. Nothing at module scope dereferences a module under
 * test, because that aborts collection and reports `(0 test)` instead of naming the assertion
 * that broke.
 */
function hex(seed: string): string {
  return seed.padStart(64, "0");
}

/** DoD 2 verbatim: the six fields the clean package must bind. */
const BOUND_FIELDS = [
  "criteria", "hashes", "receipts", "rubric", "submittedBytes", "tree",
] as const;

/** DoD 2 names three; design 883 adds handoff persuasion. All four are unexpressible. */
const FORBIDDEN_KINDS = [
  "HANDOFF_PERSUASION", "JOURNAL_ENTRY", "SELF_ASSESSMENT", "WORKER_TRANSCRIPT",
] as const;

const BASE_ITEMS: readonly ReviewPackageItemInput[] = [
  { digest: hex("c1"), kind: "CRITERION", locator: "criterion:oracle" },
  { digest: hex("c2"), kind: "CRITERION", locator: "criterion:scope" },
  { digest: hex("a1"), kind: "GRAPH_HASH", locator: "graph:revision" },
  { digest: hex("a2"), kind: "PLAN_HASH", locator: "plan:revision" },
  { digest: hex("b1"), kind: "INTEGRATED_TREE", locator: "tree:integrated" },
  { digest: hex("d1"), kind: "DAEMON_RECEIPT", locator: "receipt:evidence" },
  { digest: hex("d2"), kind: "DAEMON_ARTIFACT", locator: "artifact:build" },
  { digest: hex("e1"), kind: "RUBRIC", locator: "rubric/3" },
  { digest: hex("f1"), kind: "SUBMITTED_BYTES", locator: "submission:final" },
];

/** One perturbable source item per bound field; asserted below to cover the field list exactly. */
const BOUND_FIELD_SOURCES: readonly (readonly [ReviewPackageBoundField, string])[] = [
  ["criteria", "CRITERION"],
  ["hashes", "GRAPH_HASH"],
  ["receipts", "DAEMON_RECEIPT"],
  ["rubric", "RUBRIC"],
  ["submittedBytes", "SUBMITTED_BYTES"],
  ["tree", "INTEGRATED_TREE"],
];

function withoutKind(kind: string): readonly ReviewPackageItemInput[] {
  return BASE_ITEMS.filter((item) => item.kind !== kind);
}

function perturb(kind: string): readonly ReviewPackageItemInput[] {
  return BASE_ITEMS.map((item) =>
    item.kind === kind ? { ...item, digest: hex("ff") } : item);
}

function built(items: readonly ReviewPackageItemInput[]) {
  const result = buildReviewPackage(items);
  if (!result.ok) throw new Error(`expected a package, refused with ${result.code}`);
  return result.value;
}

describe("clean review package bindings", () => {
  it("binds exactly the six fields DoD 2 names", () => {
    expect(Object.keys(built(BASE_ITEMS).bound).sort()).toEqual([...BOUND_FIELDS]);
  });

  it("declares the same six bound fields on the production contract", () => {
    expect([...REVIEW_PACKAGE_BOUND_FIELDS].sort()).toEqual([...BOUND_FIELDS]);
  });

  it("binds every supplied item under its field rather than dropping any", () => {
    const bound = built(BASE_ITEMS).bound;

    expect(bound.criteria.map((item) => item.locator))
      .toEqual(["criterion:oracle", "criterion:scope"]);
    expect(bound.hashes.map((item) => item.kind)).toEqual(["GRAPH_HASH", "PLAN_HASH"]);
    expect(bound.receipts.map((item) => item.kind)).toEqual(["DAEMON_ARTIFACT", "DAEMON_RECEIPT"]);
    expect(bound.rubric.locator).toBe("rubric/3");
    expect(bound.submittedBytes.digest).toBe(hex("f1"));
    expect(bound.tree.locator).toBe("tree:integrated");
  });

  it("pins the package version", () => {
    expect(built(BASE_ITEMS).version).toBe("moe-review-package/1");
  });

  it("sweeps one perturbation per bound field, covering the field list exactly", () => {
    expect(BOUND_FIELD_SOURCES.length).toBe(6);
    expect(BOUND_FIELD_SOURCES.map(([field]) => field).sort()).toEqual([...BOUND_FIELDS]);
  });

  it.each(BOUND_FIELD_SOURCES)(
    "changes reviewInputDigest when the bound %s changes",
    (_field, kind) => {
      expect(built(perturb(kind)).reviewInputDigest)
        .not.toBe(built(BASE_ITEMS).reviewInputDigest);
    },
  );

  it("returns the identical digest for the identical items", () => {
    expect(built(BASE_ITEMS).reviewInputDigest).toBe(built([...BASE_ITEMS]).reviewInputDigest);
  });

  it("does not vary with the order items happen to arrive in", () => {
    expect(built([...BASE_ITEMS].reverse()).reviewInputDigest)
      .toBe(built(BASE_ITEMS).reviewInputDigest);
  });

  it("deep-freezes what the digest attested", () => {
    const bound = built(BASE_ITEMS).bound;

    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.criteria)).toBe(true);
    expect(Object.isFrozen(bound.rubric)).toBe(true);
    expect(() => {
      (bound.criteria as ReviewPackageItemInput[]).push(
        { digest: hex("99"), kind: "CRITERION", locator: "criterion:smuggled" },
      );
    }).toThrow(TypeError);
  });
});

describe("clean review package exclusions", () => {
  it("sweeps a non-zero number of forbidden kinds including all three DoD 2 names", () => {
    expect(FORBIDDEN_KINDS.length).toBe(4);
    expect(FORBIDDEN_KINDS).toContain("WORKER_TRANSCRIPT");
    expect(FORBIDDEN_KINDS).toContain("SELF_ASSESSMENT");
    expect(FORBIDDEN_KINDS).toContain("JOURNAL_ENTRY");
  });

  it.each(FORBIDDEN_KINDS)("refuses a %s item with PACKAGE_ITEM_KIND_FORBIDDEN", (kind) => {
    const result = buildReviewPackage([
      ...BASE_ITEMS,
      { digest: hex("11"), kind, locator: `smuggled:${kind}` },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("PACKAGE_ITEM_KIND_FORBIDDEN");
    expect(result.layer).toBe("PACKAGE");
    expect(result).not.toHaveProperty("value");
  });

  it("refuses an item kind that is neither allow-listed nor a named exclusion", () => {
    const result = buildReviewPackage([
      ...BASE_ITEMS,
      { digest: hex("12"), kind: "SIDE_CHANNEL", locator: "smuggled:other" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("PACKAGE_ITEM_KIND_UNKNOWN");
    expect(result.layer).toBe("PACKAGE");
  });

  it("binds the digest it validated, not a later read of a re-reading accessor", () => {
    let reads = 0;
    const smuggler: ReviewPackageItemInput = {
      get digest() {
        reads += 1;
        return reads === 1 ? hex("d1") : "not-a-digest";
      },
      kind: "DAEMON_RECEIPT",
      locator: "receipt:evidence",
    };
    const bound = built([...withoutKind("DAEMON_RECEIPT"), smuggler]).bound;

    expect(bound.receipts.map((item) => item.digest)).toEqual([hex("d2"), hex("d1")]);
  });

  it("refuses a receipt reference that is not a 64-hex content address", () => {
    const result = buildReviewPackage(
      BASE_ITEMS.map((item) =>
        item.kind === "DAEMON_RECEIPT" ? { ...item, digest: "not-a-digest" } : item),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("PACKAGE_ITEM_DIGEST_INVALID");
    expect(result.layer).toBe("PACKAGE");
  });
});

describe("clean review package binding completeness", () => {
  it.each(["CRITERION", "GRAPH_HASH", "DAEMON_RECEIPT", "RUBRIC", "SUBMITTED_BYTES",
    "INTEGRATED_TREE"])("refuses a package missing its %s binding", (kind) => {
    const result = buildReviewPackage(withoutKind(kind));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("PACKAGE_BINDING_INCOMPLETE");
    expect(result.layer).toBe("PACKAGE");
  });

  it.each(["RUBRIC", "SUBMITTED_BYTES", "INTEGRATED_TREE"])(
    "refuses a second %s binding rather than silently picking one",
    (kind) => {
      const result = buildReviewPackage([
        ...BASE_ITEMS,
        { digest: hex("13"), kind, locator: `duplicate:${kind}` },
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("PACKAGE_BINDING_AMBIGUOUS");
      expect(result.layer).toBe("PACKAGE");
    },
  );
});

const MISSING_ORACLE: ReviewFinding = {
  detail: "the acceptance recipe asserts nothing about the criterion",
  ruleId: "rule:oracle-adequacy",
  severity: "CRITICAL",
  subject: { kind: "CRITERION", locator: "criterion:oracle" },
};

/** Same typed subject and rule as MISSING_ORACLE, reworded and re-severed. */
const MISSING_ORACLE_REWORDED: ReviewFinding = {
  detail: "no assertion links this criterion to an artifact",
  ruleId: "rule:oracle-adequacy",
  severity: "MAJOR",
  subject: { kind: "CRITERION", locator: "criterion:oracle" },
};

/** Byte-identical prose to MISSING_ORACLE, different typed subject. */
const SAME_TEXT_OTHER_SUBJECT: ReviewFinding = {
  detail: "the acceptance recipe asserts nothing about the criterion",
  ruleId: "rule:oracle-adequacy",
  severity: "CRITICAL",
  subject: { kind: "CRITERION", locator: "criterion:scope" },
};

function recorded(lineage: ReviewLineage, round: number, findings: readonly ReviewFinding[]) {
  const result = recordReviewRound(lineage, { findings, round });
  if (!result.ok) throw new Error(`expected a recorded round, refused with ${result.code}`);
  return result.value;
}

describe("structured finding identity", () => {
  it("gives a reworded finding with the same subject and rule the same fingerprint", () => {
    expect(findingFingerprint(MISSING_ORACLE_REWORDED))
      .toBe(findingFingerprint(MISSING_ORACLE));
  });

  it("gives byte-identical prose about a different subject a different fingerprint", () => {
    expect(findingFingerprint(SAME_TEXT_OTHER_SUBJECT))
      .not.toBe(findingFingerprint(MISSING_ORACLE));
  });

  it("distinguishes the same locator under a different typed subject kind", () => {
    expect(findingFingerprint({
      ...MISSING_ORACLE,
      subject: { kind: "ARTIFACT", locator: "criterion:oracle" },
    })).not.toBe(findingFingerprint(MISSING_ORACLE));
  });

  it("distinguishes the same subject under a different rule", () => {
    expect(findingFingerprint({ ...MISSING_ORACLE, ruleId: "rule:scope-breach" }))
      .not.toBe(findingFingerprint(MISSING_ORACLE));
  });

  it("is a 64-hex digest of the typed identity only", () => {
    expect(findingFingerprint(MISSING_ORACLE)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("rejection lineage and repeat routing", () => {
  it("routes a first-round finding to REJECT_IMPLEMENTATION at the FINDINGS layer", () => {
    const outcome = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);

    expect(outcome.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(outcome.routing.layer).toBe("FINDINGS");
    expect(outcome.routing.repeatFingerprints).toEqual([]);
    expect(outcome.lineage.unsuccessfulRounds).toBe(1);
  });

  it("routes a reworded repeat of an earlier finding to replan", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [MISSING_ORACLE_REWORDED]);

    expect(second.routing.route).toBe("REJECT_PLAN");
    expect(second.routing.layer).toBe("FINDINGS");
    expect(second.routing.repeatFingerprints).toEqual([findingFingerprint(MISSING_ORACLE)]);
  });

  it("does not treat identical prose about a different subject as a repeat", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [SAME_TEXT_OTHER_SUBJECT]);

    expect(second.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(second.routing.repeatFingerprints).toEqual([]);
  });

  it("routes a round with no findings to ACCEPT without counting it unsuccessful", () => {
    const outcome = recorded(EMPTY_REVIEW_LINEAGE, 1, []);

    expect(outcome.routing.route).toBe("ACCEPT");
    expect(outcome.routing.layer).toBe("FINDINGS");
    expect(outcome.lineage.unsuccessfulRounds).toBe(0);
  });

  it("stores an inert copy of a finding rather than a re-reading accessor", () => {
    let reads = 0;
    const shifty: ReviewFinding = {
      get detail() {
        reads += 1;
        return reads === 1 ? "first reading" : "second reading";
      },
      ruleId: "rule:oracle-adequacy",
      severity: "MAJOR",
      subject: { kind: "NODE", locator: "node:one" },
    };
    const outcome = recorded(EMPTY_REVIEW_LINEAGE, 1, [shifty]);

    expect(outcome.lineage.records[0]?.finding.detail).toBe("first reading");
  });

  it("fingerprints the stored copy, never a second reading of a shifty rule id", () => {
    let reads = 0;
    const shifty: ReviewFinding = {
      detail: "stable prose",
      get ruleId() {
        reads += 1;
        return reads === 1 ? "rule:oracle-adequacy" : "rule:scope-breach";
      },
      severity: "MAJOR",
      subject: { kind: "NODE", locator: "node:one" },
    };
    const record = recorded(EMPTY_REVIEW_LINEAGE, 1, [shifty]).lineage.records[0];
    if (record === undefined) throw new Error("expected a recorded finding");

    expect(record.finding.ruleId).toBe("rule:oracle-adequacy");
    expect(findingFingerprint(record.finding)).toBe(record.fingerprint);
  });

  it("reads a shifty subject once, so kind and locator come from the same reading", () => {
    let reads = 0;
    const shifty: ReviewFinding = {
      detail: "stable prose",
      ruleId: "rule:oracle-adequacy",
      severity: "MAJOR",
      get subject() {
        reads += 1;
        return reads === 1
          ? { kind: "NODE" as const, locator: "node:one" }
          : { kind: "ARTIFACT" as const, locator: "artifact:two" };
      },
    };
    const record = recorded(EMPTY_REVIEW_LINEAGE, 1, [shifty]).lineage.records[0];
    if (record === undefined) throw new Error("expected a recorded finding");

    expect(record.finding.subject).toEqual({ kind: "NODE", locator: "node:one" });
    expect(findingFingerprint(record.finding)).toBe(record.fingerprint);
  });

  it("appends every recorded finding with its round and fingerprint", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [SAME_TEXT_OTHER_SUBJECT]);

    expect(second.lineage.records.map((record) => record.round)).toEqual([1, 2]);
    expect(second.lineage.records.map((record) => record.fingerprint))
      .toEqual([findingFingerprint(MISSING_ORACLE), findingFingerprint(SAME_TEXT_OTHER_SUBJECT)]);
  });
});

describe("rejection lineage is append-only", () => {
  it("refuses a round that does not advance past the last recorded one", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const replay = recordReviewRound(first.lineage, { findings: [MISSING_ORACLE], round: 1 });

    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected refusal");
    expect(replay.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
    expect(replay.layer).toBe("FINDINGS");
    expect(replay).not.toHaveProperty("value");
  });

  it("refuses an out-of-order earlier round", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 5, [SAME_TEXT_OTHER_SUBJECT]);
    const late = recordReviewRound(second.lineage, { findings: [MISSING_ORACLE], round: 3 });

    expect(late.ok).toBe(false);
    if (late.ok) throw new Error("expected refusal");
    expect(late.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
  });

  it("leaves the lineage digest unchanged when a rewrite is refused", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const before = first.lineage.digest;

    expect(recordReviewRound(first.lineage, { findings: [], round: 0 }).ok).toBe(false);
    expect(first.lineage.digest).toBe(before);
  });

  it("cannot have an earlier record rewritten in place", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const before = first.lineage.digest;

    const smuggled = first.lineage.records as unknown as { round: number }[];

    expect(Object.isFrozen(first.lineage.records)).toBe(true);
    expect(() => {
      const earliest = smuggled[0];
      if (earliest === undefined) throw new Error("expected a recorded finding");
      earliest.round = 9;
    }).toThrow(TypeError);
    expect(first.lineage.digest).toBe(before);
  });

  it("changes the lineage digest when a round is genuinely appended", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const second = recorded(first.lineage, 2, [SAME_TEXT_OTHER_SUBJECT]);

    expect(second.lineage.digest).not.toBe(first.lineage.digest);
    expect(first.lineage.digest).not.toBe(EMPTY_REVIEW_LINEAGE.digest);
  });

  it("refuses a lineage whose digest does not attest its own records", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const forged: ReviewLineage = { ...first.lineage, records: [] };
    const result = recordReviewRound(forged, { findings: [MISSING_ORACLE], round: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("FINDING_LINEAGE_DIGEST_MISMATCH");
    expect(result.layer).toBe("FINDINGS");
  });

  it("refuses a lineage whose unsuccessful-round counter was reset by hand", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [MISSING_ORACLE]);
    const forged: ReviewLineage = { ...first.lineage, unsuccessfulRounds: 0 };
    const result = recordReviewRound(forged, { findings: [SAME_TEXT_OTHER_SUBJECT], round: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("FINDING_LINEAGE_DIGEST_MISMATCH");
  });
});

const ELIGIBLE_REVIEWER: ReviewerIndependenceInput = {
  authors: ["principal:author"],
  authorshipResolved: true,
  leaseHistory: [],
  leaseHistoryResolved: true,
  reviewer: "principal:reviewer",
  subjectRef: "node:alpha",
};

const CURRENT_CALIBRATION: ReviewerCalibration = {
  corpusRevision: "corpus/2026-08",
  sentinelPassed: true,
  staleness: "CURRENT",
};

/** A @moe/core policy input that the core evaluator decides ALLOW. No rule is restated here. */
const ALLOW_POLICY: PolicyEvaluationInput = {
  action: "review.accept",
  actor: "principal:reviewer",
  callerRiskHint: null,
  decisionDigest: hex("aa"),
  evaluatedAtEpochMs: 1754000000000,
  evaluatorVersion: "policy/1",
  facts: [{ factId: "fact:tier", tier: "R0", truthClass: "DAEMON_VERIFIED" }],
  graphNodeRevisionRefs: ["node:alpha@1"],
  policyRevisionRef: hex("bb"),
  requiredFactIds: ["fact:tier"],
  scope: ["node:alpha"],
  sliceChain: [{
    autoApprovalOptIns: [{ action: "review.accept", tier: "R0" }],
    rules: [{
      effect: "ALLOW",
      obligations: [],
      requiredFactIds: ["fact:tier"],
      ruleId: "rule:accept",
    }],
    sliceRef: "slice:root",
  }],
  waivers: [],
};

const DENY_POLICY: PolicyEvaluationInput = {
  ...ALLOW_POLICY,
  sliceChain: [{
    autoApprovalOptIns: [{ action: "review.accept", tier: "R0" }],
    rules: [{
      effect: "DENY",
      obligations: [],
      requiredFactIds: ["fact:tier"],
      ruleId: "rule:accept",
    }],
    sliceRef: "slice:root",
  }],
};

function acceptance(overrides: Partial<ReviewAcceptanceInput> = {}): ReviewAcceptanceInput {
  return {
    calibration: CURRENT_CALIBRATION,
    lineage: EMPTY_REVIEW_LINEAGE,
    policy: ALLOW_POLICY,
    proof: "PASSED",
    reviewInputDigest: hex("ee"),
    reviewer: ELIGIBLE_REVIEWER,
    ...overrides,
  };
}

function nodeFinding(locator: string): ReviewFinding {
  return {
    detail: `finding about ${locator}`,
    ruleId: "rule:oracle-adequacy",
    severity: "MAJOR",
    subject: { kind: "NODE", locator },
  };
}

function threeUnsuccessfulRounds(): ReviewLineage {
  const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [nodeFinding("node:one")]);
  const second = recorded(first.lineage, 2, [nodeFinding("node:two")]);
  return recorded(second.lineage, 3, [nodeFinding("node:three")]).lineage;
}

describe("acceptance qualification", () => {
  it("qualifies an eligible reviewer on a passed proof and an ALLOW policy verdict", () => {
    const result = qualifyReviewAcceptance(acceptance());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected qualification, refused with ${result.code}`);
    expect(result.value.policyDecision).toBe("ALLOW");
    expect(result.value.policyReasonCodes).toEqual(["ALLOWED_BY_POLICY"]);
    expect(result.value.reviewInputDigest).toBe(hex("ee"));
    expect(result.value.reviewerCalibrationDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("cannot accept on a FAILED proof", () => {
    const result = qualifyReviewAcceptance(acceptance({ proof: "FAILED" }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("PROOF_FAILED");
    expect(result.layer).toBe("ACCEPTANCE");
    expect(result).not.toHaveProperty("value");
  });

  it("cannot accept on an UNKNOWN proof, which is not the same fact as failed", () => {
    const unknown = qualifyReviewAcceptance(acceptance({ proof: "UNKNOWN" }));
    const failed = qualifyReviewAcceptance(acceptance({ proof: "FAILED" }));

    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected refusal");
    if (failed.ok) throw new Error("expected refusal");
    expect(unknown.code).toBe("PROOF_UNKNOWN");
    expect(unknown.layer).toBe("ACCEPTANCE");
    expect(unknown).not.toHaveProperty("value");
    expect(unknown.code).not.toBe(failed.code);
  });

  it("cannot accept when reviewer independence is UNKNOWN, even on a passed proof", () => {
    const result = qualifyReviewAcceptance(acceptance({
      reviewer: { ...ELIGIBLE_REVIEWER, leaseHistoryResolved: false },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("UNKNOWN_REVIEWER_INDEPENDENCE");
    expect(result.layer).toBe("ELIGIBILITY");
    expect(result).not.toHaveProperty("value");
  });

  it("lets the ELIGIBILITY gate answer before the proof gate, so the layer is unambiguous", () => {
    const result = qualifyReviewAcceptance(acceptance({
      proof: "FAILED",
      reviewer: { ...ELIGIBLE_REVIEWER, reviewer: "principal:author" },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("REVIEWER_IS_AUTHOR");
    expect(result.layer).toBe("ELIGIBILITY");
  });

  it("carries @moe/core's policy reason code verbatim rather than restating the rule", () => {
    const result = qualifyReviewAcceptance(acceptance({ policy: DENY_POLICY }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("ACCEPTANCE_POLICY_REFUSED");
    expect(result.layer).toBe("ACCEPTANCE");
    expect(result.policyReasonCodes).toEqual(["DENIED_BY_RULE"]);
  });

  it("refuses when @moe/core cannot evaluate the policy input at all", () => {
    const result = qualifyReviewAcceptance(acceptance({
      policy: { ...ALLOW_POLICY, decisionDigest: "not-a-digest" },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("ACCEPTANCE_POLICY_REFUSED");
    expect(result.layer).toBe("ACCEPTANCE");
    expect(result.policyReasonCodes).toEqual([]);
  });
});

describe("review escalation boundary", () => {
  it("pins the escalation limit the production contract publishes", () => {
    expect(REVIEW_ESCALATION_ROUND_LIMIT).toBe(3);
  });

  it("does not escalate after two unsuccessful rounds", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [nodeFinding("node:one")]);
    const second = recorded(first.lineage, 2, [nodeFinding("node:two")]);

    expect(second.lineage.unsuccessfulRounds).toBe(2);
    expect(second.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(second.routing.reasonCodes).toEqual([]);
  });

  it("requires human escalation on the third unsuccessful round", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [nodeFinding("node:one")]);
    const second = recorded(first.lineage, 2, [nodeFinding("node:two")]);
    const third = recorded(second.lineage, 3, [nodeFinding("node:three")]);

    expect(third.lineage.unsuccessfulRounds).toBe(3);
    expect(third.routing.route).toBe("ESCALATE");
    expect(third.routing.reasonCodes).toEqual(["REVIEW_ROUND_CAP_REACHED"]);
  });

  it("does not let a fourth round quietly proceed as if unescalated", () => {
    const fourth = recorded(threeUnsuccessfulRounds(), 4, [nodeFinding("node:four")]);

    expect(fourth.lineage.unsuccessfulRounds).toBe(4);
    expect(fourth.routing.route).toBe("ESCALATE");
    expect(fourth.routing.reasonCodes).toEqual(["REVIEW_ROUND_CAP_REACHED"]);
  });

  it("never auto-accepts a clean round once the cap has been reached", () => {
    const clean = recorded(threeUnsuccessfulRounds(), 4, []);

    expect(clean.lineage.unsuccessfulRounds).toBe(3);
    expect(clean.routing.route).toBe("ESCALATE");
  });

  it("still qualifies acceptance while only two rounds have been unsuccessful", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [nodeFinding("node:one")]);
    const second = recorded(first.lineage, 2, [nodeFinding("node:two")]);

    expect(qualifyReviewAcceptance(acceptance({ lineage: second.lineage })).ok).toBe(true);
  });

  it("refuses acceptance at the FINDINGS layer once the cap is reached", () => {
    const result = qualifyReviewAcceptance(acceptance({ lineage: threeUnsuccessfulRounds() }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("REVIEW_ROUND_CAP_REACHED");
    expect(result.layer).toBe("FINDINGS");
  });

  it("cannot be escaped by handing acceptance a lineage with the counter reset", () => {
    const capped = threeUnsuccessfulRounds();
    const result = qualifyReviewAcceptance(acceptance({
      lineage: { ...capped, unsuccessfulRounds: 0 },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("FINDING_LINEAGE_DIGEST_MISMATCH");
    expect(result.layer).toBe("FINDINGS");
  });
});
