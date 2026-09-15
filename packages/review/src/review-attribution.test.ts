import { describe, expect, it } from "vitest";

import type { ReviewFinding, ReviewLineage } from "./review-contract.js";
import { EMPTY_REVIEW_LINEAGE, findingFingerprint, qualifyReviewAcceptance, recordReviewRound } from "./review-findings.js";
import type { ReviewAcceptanceInput, ReviewRoundInput } from "./review-findings.js";

/**
 * Findings attributed to ANOTHER node of the same sealed plan (addendum 2026-09-15).
 *
 * Measured on UnAI, 2026-09-14/15: an honest seat whose own four criteria passed kept reporting a
 * repository CI step that only a sibling node's deliverable could turn green. Every finding
 * counted, so the node escalated after three rounds and again after every allowed attempt; no
 * round of either plan was ever accepted. These arms pin the kernel half of the fix: an
 * attributed finding is recorded and attested but never charges the reporter.
 *
 * Fixtures are hand-written literals; nothing at module scope calls the module under test.
 */
const OWN: ReviewFinding = {
  detail: "the evidence row is not persisted synchronously",
  ruleId: "evidence-sync",
  severity: "MAJOR",
  subject: { kind: "CRITERION", locator: "CRT-EVD-01-A" },
};

const FOREIGN: ReviewFinding = {
  attributedTo: { criterionIds: ["CRT-REG-01-A", "CRT-REG-03-A"], nodeKey: "uai-r2-registry-release" },
  detail: "pnpm validate:registry exits REGISTRY_RELEASE_MISSING until the registry release lands",
  ruleId: "registry-release-missing",
  severity: "MAJOR",
  subject: { kind: "ARTIFACT", locator: ".github/workflows/foundation.yml" },
};

/** The same identity as FOREIGN, reported as the reporter's own finding. */
const FOREIGN_AS_OWN: ReviewFinding = {
  detail: FOREIGN.detail, ruleId: FOREIGN.ruleId, severity: FOREIGN.severity, subject: FOREIGN.subject,
};

const hex = (char: string) => char.repeat(64);

function recorded(lineage: ReviewLineage, round: number, findings: readonly ReviewFinding[]) {
  const result = recordReviewRound(lineage, { findings, round });
  if (!result.ok) throw new Error(`expected a recorded round, refused with ${result.code}`);
  return result.value;
}

/** Deliberately ill-typed attributions reach the kernel exactly as a caller could send them. */
function withAttribution(attributedTo: unknown): ReviewRoundInput {
  return { findings: [{ ...FOREIGN_AS_OWN, attributedTo } as unknown as ReviewFinding], round: 1 };
}

describe("an attributed finding never charges the reporter", () => {
  it("routes a round whose only finding is attributed as clean, and records the finding", () => {
    const outcome = recorded(EMPTY_REVIEW_LINEAGE, 1, [FOREIGN]);

    expect(outcome.routing.route).toBe("ACCEPT");
    expect(outcome.lineage.unsuccessfulRounds).toBe(0);
    expect(outcome.lineage.records).toHaveLength(1);
    expect(outcome.lineage.records[0]?.finding.attributedTo).toEqual({
      criterionIds: ["CRT-REG-01-A", "CRT-REG-03-A"], nodeKey: "uai-r2-registry-release",
    });
    // The digest attests the attribution: the next round admits this lineage as the kernel's own.
    expect(recordReviewRound(outcome.lineage, { findings: [], round: 2 }).ok).toBe(true);
  });

  it("still charges the reporter's own finding in a mixed round", () => {
    const outcome = recorded(EMPTY_REVIEW_LINEAGE, 1, [FOREIGN, OWN]);

    expect(outcome.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(outcome.lineage.unsuccessfulRounds).toBe(1);
    expect(outcome.lineage.records).toHaveLength(2);
  });

  it("keeps the live loop's shape from escalating: three attributed rounds stay at zero", () => {
    let lineage = EMPTY_REVIEW_LINEAGE;
    for (const round of [1, 2, 3]) lineage = recorded(lineage, round, [FOREIGN]).lineage;

    expect(lineage.unsuccessfulRounds).toBe(0);
    expect(recorded(lineage, 4, [FOREIGN]).routing.route).toBe("ACCEPT");
  });

  it("does not treat an attributed repeat as a repeat of the reporter's own finding", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [FOREIGN]).lineage;
    const second = recorded(first, 2, [FOREIGN_AS_OWN]);

    // Reported as its own for the first time: fresh, not "the same finding again".
    expect(second.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(second.routing.repeatFingerprints).toEqual([]);
  });

  it("keeps repeat detection for the reporter's own findings", () => {
    const first = recorded(EMPTY_REVIEW_LINEAGE, 1, [OWN]).lineage;
    const second = recorded(first, 2, [OWN, FOREIGN]);

    expect(second.routing.route).toBe("REJECT_PLAN");
    expect(second.routing.repeatFingerprints).toEqual([findingFingerprint(OWN)]);
  });

  it("gives attribution no part in a finding's identity", () => {
    expect(findingFingerprint(FOREIGN)).toBe(findingFingerprint(FOREIGN_AS_OWN));
  });
});

describe("attribution shape admission", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["a string", "uai-r2-registry-release"],
    ["null", null],
    ["an array", ["uai-r2-registry-release"]],
    ["an extra key", { criterionIds: ["CRT-REG-01-A"], nodeKey: "node-b", reason: "x" }],
    ["a missing nodeKey", { criterionIds: ["CRT-REG-01-A"] }],
    ["an empty nodeKey", { criterionIds: ["CRT-REG-01-A"], nodeKey: "" }],
    ["a control character in nodeKey", { criterionIds: ["CRT-REG-01-A"], nodeKey: "node\nb" }],
    ["no criteria", { criterionIds: [], nodeKey: "node-b" }],
    ["criteria that are not an array", { criterionIds: "CRT-REG-01-A", nodeKey: "node-b" }],
    ["a non-string criterion", { criterionIds: [7], nodeKey: "node-b" }],
    ["an empty criterion", { criterionIds: [""], nodeKey: "node-b" }],
    ["a duplicated criterion", { criterionIds: ["CRT-REG-01-A", "CRT-REG-01-A"], nodeKey: "node-b" }],
    ["more than 32 criteria", { criterionIds: Array.from({ length: 33 }, (_, index) => `CRT-${index}`), nodeKey: "node-b" }],
    ["an over-long nodeKey", { criterionIds: ["CRT-REG-01-A"], nodeKey: "n".repeat(257) }],
  ];

  it.each(cases)("refuses %s with FINDING_ATTRIBUTION_INVALID and appends nothing", (_label, attributedTo) => {
    const before = recorded(EMPTY_REVIEW_LINEAGE, 1, [OWN]).lineage;
    const input = { ...withAttribution(attributedTo), round: 2 };

    const result = recordReviewRound(before, input);

    expect(result).toMatchObject({ code: "FINDING_ATTRIBUTION_INVALID", layer: "FINDINGS", ok: false });
    expect(before.records).toHaveLength(1);
  });

  it("stores criteria in one canonical order, so caller order cannot move the digest", () => {
    const forward = recorded(EMPTY_REVIEW_LINEAGE, 1, [FOREIGN]).lineage;
    const reversed = recorded(EMPTY_REVIEW_LINEAGE, 1, [{
      ...FOREIGN, attributedTo: { criterionIds: ["CRT-REG-03-A", "CRT-REG-01-A"], nodeKey: "uai-r2-registry-release" },
    }]).lineage;

    expect(reversed.digest).toBe(forward.digest);
  });
});

describe("an allowed attempt may carry attributed findings and still be accepted", () => {
  function exhausted(): ReviewLineage {
    let lineage = EMPTY_REVIEW_LINEAGE;
    for (const round of [1, 2, 3]) lineage = recorded(lineage, round, [OWN]).lineage;
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
  const acceptance = (lineage: ReviewLineage, use: unknown): ReviewAcceptanceInput => ({
    calibration: { corpusRevision: "corpus-1", sentinelPassed: true, staleness: "CURRENT" },
    continuation: use as ReviewAcceptanceInput["continuation"],
    lineage,
    policy: { action: "integration.accept_output", actor: "verifier", approvals: [], context: {} } as unknown as ReviewAcceptanceInput["policy"],
    proof: "PASSED",
    reviewInputDigest: hex("c"),
    reviewer: { authors: ["seat-1"], authorshipResolved: true, leaseHistory: [], leaseHistoryResolved: true,
      reviewer: "verifier", subjectRef: "node-a" },
  });

  it("routes the continued round ACCEPT when its only finding is attributed", () => {
    const lineage = exhausted();
    const result = recordContinued(lineage, { findings: [FOREIGN], round: 5 }, continuation(lineage));

    expect(result).toMatchObject({ ok: true, value: { routing: { route: "ACCEPT" }, lineage: { unsuccessfulRounds: 3 } } });
  });

  it("lets acceptance spend that continuation despite the attributed record", () => {
    const lineage = exhausted();
    const use = continuation(lineage);
    const result = recordContinued(lineage, { findings: [FOREIGN], round: 5 }, use);
    if (!result.ok) throw new Error(result.code);

    const qualified = qualifyReviewAcceptance(acceptance(result.value.lineage, use));

    // Not refused by the FINDINGS layer: the continuation still binds the approved lineage.
    expect(qualified.ok ? "ACCEPTED" : `${qualified.layer}:${qualified.code}`).not.toMatch(/^FINDINGS:/u);
  });

  it("still refuses acceptance when the continued round carried the reporter's own finding", () => {
    const lineage = exhausted();
    const use = continuation(lineage);
    const result = recordContinued(lineage, { findings: [FOREIGN, OWN], round: 5 }, use);
    if (!result.ok) throw new Error(result.code);

    expect(result.value.routing.route).toBe("ESCALATE");
    expect(qualifyReviewAcceptance(acceptance(result.value.lineage, use)))
      .toMatchObject({ layer: "FINDINGS", ok: false });
  });
});
