import { expect, it } from "vitest";
import { EMPTY_REVIEW_LINEAGE, recordReviewRound, qualifyReviewAcceptance } from "./review-findings.js";
import type { ReviewAcceptanceInput, ReviewRoundInput } from "./review-findings.js";
import type { ReviewLineage } from "./review-contract.js";

const hex = (char: string) => char.repeat(64);
function exhausted() {
  let lineage = EMPTY_REVIEW_LINEAGE;
  for (const round of [1, 2, 3]) {
    const result = recordReviewRound(lineage, { round, findings: [{ detail: `missing ${round}`,
      ruleId: `missing-${round}`, severity: "MAJOR", subject: { kind: "NODE", locator: "node-a" } }] });
    if (!result.ok) throw new Error(result.code);
    lineage = result.value.lineage;
  }
  return lineage;
}
function continuation(lineage: ReviewLineage) {
  return { projectId: "project-a", subjectRef: "node-a", round: 5, approval: {
    version: "moe-review-continuation/1" as const, projectId: "project-a", subjectRef: "node-a",
    decisionId: "allow-1", decisionResultSha256: hex("a"), decisionVersion: 4,
    sourceRound: lineage.highestRound, sourceLineageDigest: lineage.digest,
    sourceDecisionId: "round-3", sourceResultSha256: hex("b"), sourceAggregateVersion: 3,
    unsuccessfulRounds: lineage.unsuccessfulRounds,
  } };
}
const recordContinued = recordReviewRound as unknown as (
  lineage: ReviewLineage, round: ReviewRoundInput, continuation: unknown,
) => ReturnType<typeof recordReviewRound>;

it("routes one source-bound clean continuation without resetting rejection history", () => {
  const lineage = exhausted();
  const result = recordContinued(lineage, { round: 5, findings: [] }, continuation(lineage));
  expect(result).toMatchObject({ ok: true, value: { routing: { route: "ACCEPT" } } });
  if (!result.ok) throw new Error(result.code);
  expect(result.value.lineage.records).toEqual(lineage.records);
  expect(result.value.lineage.unsuccessfulRounds).toBe(3);
  expect(result.value.lineage.highestRound).toBe(5);
  expect(recordContinued(result.value.lineage, { round: 6, findings: [] }, continuation(lineage)))
    .toMatchObject({ ok: false, code: "REVIEW_CONTINUATION_INVALID" });
});

it.each(["project", "subject", "lineage", "source-round", "target-round", "decision-digest"])(
  "refuses a continuation with mismatched %s binding", (change) => {
    const lineage = exhausted();
    const use = continuation(lineage);
    if (change === "project") use.projectId = "other-project";
    if (change === "subject") use.subjectRef = "other-node";
    if (change === "lineage") use.approval.sourceLineageDigest = hex("f");
    if (change === "source-round") use.approval.sourceRound = 2;
    if (change === "target-round") use.round = 6;
    if (change === "decision-digest") use.approval.decisionResultSha256 = "not-a-digest";
    expect(recordContinued(lineage, { round: 5, findings: [] }, use))
      .toMatchObject({ ok: false, code: "REVIEW_CONTINUATION_INVALID" });
  });

it("exhausts the continuation when its approved round still has findings", () => {
  const lineage = exhausted();
  const result = recordContinued(lineage, { round: 5, findings: [{ detail: "still missing",
    ruleId: "still-missing", severity: "MAJOR", subject: { kind: "NODE", locator: "node-a" } }] }, continuation(lineage));
  expect(result).toMatchObject({ ok: true, value: { lineage: { unsuccessfulRounds: 4 }, routing: { route: "ESCALATE" } } });
});

function acceptance(lineage: ReviewLineage): ReviewAcceptanceInput {
  return {
    calibration: { corpusRevision: "corpus-current", sentinelPassed: true, staleness: "CURRENT" },
    lineage, proof: "PASSED", reviewInputDigest: hex("e"),
    reviewer: { authors: ["worker"], authorshipResolved: true, leaseHistory: [],
      leaseHistoryResolved: true, reviewer: "verifier", subjectRef: "node-a" },
    policy: { action: "review.accept", actor: "verifier", callerRiskHint: null,
      decisionDigest: hex("a"), evaluatedAtEpochMs: 1754000000000, evaluatorVersion: "policy/1",
      facts: [{ factId: "tier", tier: "R0", truthClass: "DAEMON_VERIFIED" }],
      graphNodeRevisionRefs: ["node-a@1"], policyRevisionRef: hex("b"), requiredFactIds: ["tier"], scope: ["node-a"],
      sliceChain: [{ autoApprovalOptIns: [{ action: "review.accept", tier: "R0" }],
        rules: [{ effect: "ALLOW", obligations: [], requiredFactIds: ["tier"], ruleId: "accept" }], sliceRef: "root" }], waivers: [] },
  };
}

it("requires independent passed proof and policy even for a bound clean continuation", () => {
  const prior = exhausted();
  const use = continuation(prior);
  const clean = recordContinued(prior, { round: 5, findings: [] }, use);
  if (!clean.ok) throw new Error(clean.code);
  const input = { ...acceptance(clean.value.lineage), continuation: use };
  expect(qualifyReviewAcceptance(input)).toMatchObject({ ok: true });
  expect(qualifyReviewAcceptance({ ...input, proof: "UNKNOWN" })).toMatchObject({ ok: false, code: "PROOF_UNKNOWN" });
  expect(qualifyReviewAcceptance({ ...input, proof: "FAILED" })).toMatchObject({ ok: false, code: "PROOF_FAILED" });
  expect(qualifyReviewAcceptance({ ...input, reviewer: { ...input.reviewer, reviewer: "worker" } }))
    .toMatchObject({ ok: false, code: "REVIEWER_IS_AUTHOR" });
  expect(qualifyReviewAcceptance({ ...input, policy: { ...input.policy, facts: [] } }))
    .toMatchObject({ ok: false, code: "ACCEPTANCE_POLICY_REFUSED" });
});

/**
 * The UnAI 2026-09-18 shape at the acceptance gate: three blocking rounds, the operator's
 * continuation, then a round whose only own finding is an informational MINOR note. The
 * kernel routes it ACCEPT (review-findings.ts), and acceptance must be able to spend the
 * continuation on it — before this arm, `reviewContinuationAccepts` refused any own record
 * past the source round regardless of severity, so the verifier's PASSED proof was thrown
 * away as REVIEW_CONTINUATION_INVALID and the card's "Allow one more attempt" bought nothing.
 * DRILL: dropping the `severity !== "MINOR"` clause reds this arm and leaves the MAJOR arm green.
 */
it("lets acceptance spend the continuation when the continued round carries only a MINOR note", () => {
  const prior = exhausted();
  const use = continuation(prior);
  const minor = recordContinued(prior, { round: 5, findings: [{ detail: "migration digest changed; re-provision",
    ruleId: "applied-migration-digest-changed", severity: "MINOR", subject: { kind: "CRITERION", locator: "criterion:migrations" } }] }, use);
  if (!minor.ok) throw new Error(minor.code);
  expect(minor.value.routing.route).toBe("ACCEPT");
  expect(minor.value.lineage.unsuccessfulRounds).toBe(3);
  expect(qualifyReviewAcceptance({ ...acceptance(minor.value.lineage), continuation: use })).toMatchObject({ ok: true });
  // A MAJOR own finding on the continued round still exhausts it at both gates.
  const major = recordContinued(prior, { round: 5, findings: [{ detail: "still missing",
    ruleId: "still-missing", severity: "MAJOR", subject: { kind: "NODE", locator: "node-a" } }] }, use);
  if (!major.ok) throw new Error(major.code);
  expect(qualifyReviewAcceptance({ ...acceptance(major.value.lineage), continuation: use }))
    .toMatchObject({ code: "REVIEW_CONTINUATION_INVALID", layer: "FINDINGS", ok: false });
});
