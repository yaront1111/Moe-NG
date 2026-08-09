import { describe, expect, it } from "vitest";
import {
  PREDECESSOR_RELEASES,
  RECOVERY_ERROR_CODES,
  RECOVERY_OUTCOME_KINDS,
  RESUMABLE_RECOVERY_CLASSIFICATIONS,
  type PredecessorRelease,
  type RecoveryOutcomeKind,
} from "./recovery-contract.js";
import { admitResume, admitSuccessorOverlap, advanceRecoveryDrain } from "./safe-boundary.js";
import { classifyCrash, type CrashClassification } from "./crash-classification.js";
import { SETTLED, records, situation } from "./recovery-test-fixtures.js";
import { RESOURCE_FACTS } from "../supervisor/drain-table.js";

/**
 * DoD 1: "No successor overlaps a predecessor lacking a proven safe release
 * boundary." All three predecessor states are asserted explicitly, because an
 * optimistic implementation gets exactly one of them wrong — UNKNOWN — and a
 * suite that only tests PROVEN_RELEASED and ACTIVE stays green while it does.
 *
 * Hand-transcribed rather than read from the subject: a fixture derived from the
 * vocabulary under test moves with it, so a dropped member would never redden.
 */
const RELEASES: readonly PredecessorRelease[] = ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"];
const HANDOFF = "handoff-ref-1";

/**
 * The five durable classifications, hand-transcribed for the same reason as
 * RELEASES. DoD 2's sweep is only meaningful if this list is independent of the
 * export it checks: a universe read from the subject agrees with the subject
 * even after a member is dropped.
 */
const KINDS: readonly RecoveryOutcomeKind[] = [
  "ADOPTED",
  "ABSENT",
  "SUSPECT",
  "QUARANTINED",
  "RECONCILIATION_COMMAND",
];

/** Every kind the closed resumable set excludes — the four that must refuse. */
const NON_RESUMABLE: readonly RecoveryOutcomeKind[] = [
  "ADOPTED",
  "SUSPECT",
  "QUARANTINED",
  "RECONCILIATION_COMMAND",
];

function overlapRequest(
  predecessorRelease: unknown,
  classification: unknown = "ABSENT",
): Record<string, unknown> {
  return {
    predecessorRef: "predecessor-1",
    successorRef: "successor-1",
    predecessorRelease,
    classification,
  };
}

function resumeRequest(
  predecessorRelease: unknown,
  safeHandoff: unknown = HANDOFF,
  classification: unknown = "ABSENT",
): Record<string, unknown> {
  return { resumeRef: "resume-1", predecessorRelease, safeHandoff, classification };
}

function disposition(
  reasons: readonly string[],
  strongestReason: string,
  terminalTarget: string,
): Record<string, unknown> {
  return { reasons: [...reasons], strongestReason, terminalTarget };
}

const HELD_REVOKE = disposition(["URGENT_REVOKE"], "URGENT_REVOKE", "CANCELLED");
const HELD_PAUSE = disposition(
  ["WORK_RELEASE_OR_PAUSE"],
  "WORK_RELEASE_OR_PAUSE",
  "RELEASED",
);

describe("recovery vocabulary", () => {
  it("declares the three-valued predecessor release lattice", () => {
    expect([...PREDECESSOR_RELEASES]).toEqual([...RELEASES]);
  });

  it("stays string-identical to the supervisor resource-fact lattice", () => {
    expect([...PREDECESSOR_RELEASES].sort()).toEqual([...RESOURCE_FACTS].sort());
  });

  it("declares both predecessor refusals as separate codes", () => {
    expect(RECOVERY_ERROR_CODES).toContain("RECOVERY_PREDECESSOR_ACTIVE");
    expect(RECOVERY_ERROR_CODES).toContain("RECOVERY_PREDECESSOR_RELEASE_UNKNOWN");
  });

  it("declares the five durable classifications against a hand-written universe", () => {
    expect(KINDS).toHaveLength(5);
    expect([...RECOVERY_OUTCOME_KINDS]).toEqual([...KINDS]);
  });

  /**
   * DoD 1. The resumable set is closed and contains ABSENT alone. Asserting the
   * exact array rather than membership is the point: a later member appended
   * here would silently widen continuation authority, and `toContain("ABSENT")`
   * would still pass.
   */
  it("closes the resumable classification set to ABSENT alone and freezes it", () => {
    expect([...RESUMABLE_RECOVERY_CLASSIFICATIONS]).toEqual(["ABSENT"]);
    expect(Object.isFrozen(RESUMABLE_RECOVERY_CLASSIFICATIONS)).toBe(true);
  });

  it("partitions the five kinds into the resumable one and four non-resumable", () => {
    const resumable = KINDS.filter((kind) =>
      (RESUMABLE_RECOVERY_CLASSIFICATIONS as readonly string[]).includes(kind),
    );
    expect(resumable).toEqual(["ABSENT"]);
    expect(KINDS.filter((kind) => !resumable.includes(kind))).toEqual([...NON_RESUMABLE]);
  });

  it("declares the non-resumable refusal code", () => {
    expect(RECOVERY_ERROR_CODES).toContain("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
  });
});

describe("successor overlap admission", () => {
  it("sweeps every declared predecessor release and generates a case for each", () => {
    const verdicts = RELEASES.map((release) => admitSuccessorOverlap(overlapRequest(release)));
    expect(verdicts).toHaveLength(3);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual(["ADMITTED", "BLOCKED", "BLOCKED"]);
  });

  it("admits a successor over a predecessor with a proven release boundary", () => {
    const verdict = admitSuccessorOverlap(overlapRequest("PROVEN_RELEASED"));
    expect(verdict.kind).toBe("ADMITTED");
    if (verdict.kind !== "ADMITTED") return;
    expect(verdict.successorRef).toBe("successor-1");
  });

  it("blocks a successor over a predecessor we know has not released", () => {
    const verdict = admitSuccessorOverlap(overlapRequest("ACTIVE"));
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_PREDECESSOR_ACTIVE");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("blocks a successor over a predecessor whose release cannot be established", () => {
    const verdict = admitSuccessorOverlap(overlapRequest("UNKNOWN"));
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_PREDECESSOR_RELEASE_UNKNOWN");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("does not collapse an unknown release into a known-active one", () => {
    const active = admitSuccessorOverlap(overlapRequest("ACTIVE"));
    const unknown = admitSuccessorOverlap(overlapRequest("UNKNOWN"));
    expect(active.kind === "BLOCKED" ? active.failure.code : null).not.toBe(
      unknown.kind === "BLOCKED" ? unknown.failure.code : undefined,
    );
  });

  it("refuses a request naming a release the lattice does not declare", () => {
    const verdict = admitSuccessorOverlap(overlapRequest("PROBABLY_RELEASED"));
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_BOUNDARY_MALFORMED");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("refuses a request carrying an undeclared extra key", () => {
    const verdict = admitSuccessorOverlap({
      ...overlapRequest("PROVEN_RELEASED"),
      elapsedMs: 60_000,
    });
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_BOUNDARY_MALFORMED");
  });
});

describe("release and resume admission", () => {
  it("admits a resume across a proven boundary carrying its exact handoff", () => {
    const verdict = admitResume(resumeRequest("PROVEN_RELEASED"));
    expect(verdict.kind).toBe("ADMITTED");
    if (verdict.kind !== "ADMITTED") return;
    expect(verdict.safeHandoff).toBe(HANDOFF);
    expect(verdict.resumeRef).toBe("resume-1");
  });

  it.each(["ACTIVE", "UNKNOWN"] as const)(
    "refuses a resume when the predecessor boundary reads %s",
    (release) => {
      const verdict = admitResume(resumeRequest(release));
      expect(verdict.kind).toBe("REFUSED");
      if (verdict.kind !== "REFUSED") return;
      expect(verdict.failure.code).toBe("RECOVERY_RESUME_BOUNDARY_UNPROVEN");
      expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
    },
  );

  it("refuses a resume across a released predecessor with no exact handoff", () => {
    const verdict = admitResume(resumeRequest("PROVEN_RELEASED", null));
    expect(verdict.kind).toBe("REFUSED");
    if (verdict.kind !== "REFUSED") return;
    expect(verdict.failure.code).toBe("RECOVERY_RESUME_BOUNDARY_UNPROVEN");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("refuses a malformed resume request", () => {
    const verdict = admitResume({ resumeRef: "resume-1" });
    expect(verdict.kind).toBe("REFUSED");
    if (verdict.kind !== "REFUSED") return;
    expect(verdict.failure.code).toBe("RECOVERY_BOUNDARY_MALFORMED");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });
});

/**
 * DoD 2. Continuation authority is decided by the DURABLE classification, and
 * only ABSENT is resumable. Before this, a caller supplying PROVEN_RELEASED plus
 * a handoff was admitted for all five kinds — including QUARANTINED with held
 * resources — because the classification never reached the boundary at all.
 */
describe("durable classification admission", () => {
  it("sweeps all five classifications through overlap and generates a case for each", () => {
    const verdicts = KINDS.map((classification) =>
      admitSuccessorOverlap(overlapRequest("PROVEN_RELEASED", classification)),
    );
    expect(verdicts).toHaveLength(5);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual([
      "BLOCKED",
      "ADMITTED",
      "BLOCKED",
      "BLOCKED",
      "BLOCKED",
    ]);
  });

  it("sweeps all five classifications through resume and generates a case for each", () => {
    const verdicts = KINDS.map((classification) =>
      admitResume(resumeRequest("PROVEN_RELEASED", HANDOFF, classification)),
    );
    expect(verdicts).toHaveLength(5);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual([
      "REFUSED",
      "ADMITTED",
      "REFUSED",
      "REFUSED",
      "REFUSED",
    ]);
  });

  it.each(NON_RESUMABLE)("blocks overlap for %s with the exact code and layer", (classification) => {
    const verdict = admitSuccessorOverlap(overlapRequest("PROVEN_RELEASED", classification));
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it.each(NON_RESUMABLE)("refuses resume for %s with the exact code and layer", (classification) => {
    const verdict = admitResume(resumeRequest("PROVEN_RELEASED", HANDOFF, classification));
    expect(verdict.kind).toBe("REFUSED");
    if (verdict.kind !== "REFUSED") return;
    expect(verdict.failure.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  /**
   * Guard ORDER, not merely guard presence. QUARANTINED carries held resources,
   * so an implementation that consults the release lattice first answers ACTIVE
   * and the classification test above stays green while the classification guard
   * is gone entirely. Pinning the code here is what makes that mutant die.
   */
  it("answers the classification before the release lattice for QUARANTINED + ACTIVE", () => {
    const verdict = admitSuccessorOverlap(overlapRequest("ACTIVE", "QUARANTINED"));
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
    expect(verdict.failure.code).not.toBe("RECOVERY_PREDECESSOR_ACTIVE");
  });

  it("answers the classification before the handoff check for SUSPECT + no handoff", () => {
    const verdict = admitResume(resumeRequest("PROVEN_RELEASED", null, "SUSPECT"));
    expect(verdict.kind).toBe("REFUSED");
    if (verdict.kind !== "REFUSED") return;
    expect(verdict.failure.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
    expect(verdict.failure.code).not.toBe("RECOVERY_RESUME_BOUNDARY_UNPROVEN");
  });

  /**
   * Fail closed. A request that omits the classification must be malformed, not
   * defaulted to the resumable member — a default would reinstate exactly the
   * permissive shape this migration removes.
   */
  it("refuses an overlap request omitting the classification entirely", () => {
    const verdict = admitSuccessorOverlap({
      predecessorRef: "predecessor-1",
      successorRef: "successor-1",
      predecessorRelease: "PROVEN_RELEASED",
    });
    expect(verdict.kind).toBe("BLOCKED");
    if (verdict.kind !== "BLOCKED") return;
    expect(verdict.failure.code).toBe("RECOVERY_BOUNDARY_MALFORMED");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("refuses a resume request omitting the classification entirely", () => {
    const verdict = admitResume({
      resumeRef: "resume-1",
      predecessorRelease: "PROVEN_RELEASED",
      safeHandoff: HANDOFF,
    });
    expect(verdict.kind).toBe("REFUSED");
    if (verdict.kind !== "REFUSED") return;
    expect(verdict.failure.code).toBe("RECOVERY_BOUNDARY_MALFORMED");
    expect(verdict.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it.each([null, "RESUMED", "absent", 1, {}] as const)(
    "refuses a classification outside the closed vocabulary: %s",
    (classification) => {
      const overlap = admitSuccessorOverlap(overlapRequest("PROVEN_RELEASED", classification));
      const resume = admitResume(resumeRequest("PROVEN_RELEASED", HANDOFF, classification));
      expect(overlap.kind === "BLOCKED" ? overlap.failure.code : null).toBe(
        "RECOVERY_BOUNDARY_MALFORMED",
      );
      expect(resume.kind === "REFUSED" ? resume.failure.code : null).toBe(
        "RECOVERY_BOUNDARY_MALFORMED",
      );
    },
  );

  it("still applies the release lattice once the classification is resumable", () => {
    const active = admitSuccessorOverlap(overlapRequest("ACTIVE", "ABSENT"));
    const unknown = admitSuccessorOverlap(overlapRequest("UNKNOWN", "ABSENT"));
    const noHandoff = admitResume(resumeRequest("PROVEN_RELEASED", null, "ABSENT"));
    expect([
      active.kind === "BLOCKED" ? active.failure.code : null,
      unknown.kind === "BLOCKED" ? unknown.failure.code : null,
      noHandoff.kind === "REFUSED" ? noHandoff.failure.code : null,
    ]).toEqual([
      "RECOVERY_PREDECESSOR_ACTIVE",
      "RECOVERY_PREDECESSOR_RELEASE_UNKNOWN",
      "RECOVERY_RESUME_BOUNDARY_UNPROVEN",
    ]);
  });
});

/**
 * DoD 1's other half: the evidence a continuation crosses on is DERIVED from the
 * durable record set, never asserted by whoever is asking.
 *
 * These drive `classifyCrash` from this suite rather than the classification
 * suite because `crash-classification.test.ts` is outside this task's owned
 * paths; the behaviour under test is this migration's, so its assertions ship
 * with it.
 */
describe("continuation evidence derivation", () => {
  const evidenceOf = (classification: CrashClassification): unknown =>
    classification.kind === "REFUSED" ? classification.failure.code : classification.continuationEvidence;

  it("takes the release and handoff from the durable records verbatim", () => {
    const classified = classifyCrash(
      situation({
        records: records({ ...SETTLED, safeHandoff: "handoff-from-disk" }),
        observation: {
          effectRef: "intent-1", processExit: { kind: "EXITED", code: 0 },
          effectStatus: "PROVEN_ABSENT", observedEpoch: 7,
          presenceLooksLive: false, journalDigest: null, reviewPackageDigest: null,
        },
      }),
    );
    expect(classified.kind).toBe("ABSENT");
    expect(evidenceOf(classified)).toEqual({
      predecessorRelease: "PROVEN_RELEASED",
      safeHandoff: "handoff-from-disk",
    });
  });

  /** Quarantine is the case that matters: resources are still held, so the
   * derived release must read ACTIVE. This is precisely the classification the
   * old contract admitted on a caller-supplied PROVEN_RELEASED. */
  const HELD_RECORDS = { registration: null, lockState: "RELEASED" } as const;

  it("reports a still-held predecessor as ACTIVE rather than optimistically released", () => {
    const classified = classifyCrash(situation({ records: records(HELD_RECORDS) }));
    expect(classified.kind).toBe("QUARANTINED");
    expect(evidenceOf(classified)).toEqual({ predecessorRelease: "ACTIVE", safeHandoff: null });
  });

  it("carries evidence on every non-refusing arm and freezes it", () => {
    const arms = [
      classifyCrash(situation({ records: records(HELD_RECORDS) })),
      classifyCrash(situation({ records: records({ ...SETTLED, safeHandoff: "handoff-1" }) })),
    ];
    expect(arms.length).toBeGreaterThan(0);
    const nonRefusing = arms.filter((arm) => arm.kind !== "REFUSED");
    expect(nonRefusing).toHaveLength(2);
    for (const arm of nonRefusing) {
      expect(Object.isFrozen(arm.continuationEvidence)).toBe(true);
    }
  });

  /**
   * The hostile case this migration exists for. A caller appending its own
   * release/handoff assertions to the situation must be refused by the exact
   * shape gate, not quietly ignored — being ignored would be safe today and
   * become authority the moment somebody read the field.
   */
  it("refuses a situation carrying caller-asserted release and handoff", () => {
    const hostile = classifyCrash({
      records: records({ ...SETTLED, safeHandoff: "handoff-from-disk" }),
      observation: {
        effectRef: "intent-1", processExit: { kind: "EXITED", code: 0 },
        effectStatus: "PROVEN_ABSENT", observedEpoch: 7,
        presenceLooksLive: false, journalDigest: null, reviewPackageDigest: null,
      },
      claimedAuthority: null,
      predecessorRelease: "PROVEN_RELEASED",
      safeHandoff: "handoff-the-caller-wants",
    });
    expect(hostile.kind).toBe("REFUSED");
    if (hostile.kind !== "REFUSED") return;
    expect(hostile.failure.code).toBe("RECOVERY_OBSERVATION_MALFORMED");
    expect(hostile.failure.layer).toBe("CLASSIFICATION");
  });

  it("never lets a caller-asserted release reach the derived evidence", () => {
    const classified = classifyCrash(
      situation({ records: records({ ...HELD_RECORDS, resourceFact: "ACTIVE", safeHandoff: null }) }),
    );
    expect(evidenceOf(classified)).not.toEqual({
      predecessorRelease: "PROVEN_RELEASED",
      safeHandoff: "handoff-the-caller-wants",
    });
    expect(evidenceOf(classified)).toEqual({ predecessorRelease: "ACTIVE", safeHandoff: null });
  });
});

describe("drain advance monotonicity", () => {
  it("upgrades a held disposition by a stronger observed reason", () => {
    const observed = disposition(
      ["WORK_CANCEL", "WORK_RELEASE_OR_PAUSE"],
      "WORK_CANCEL",
      "CANCELLED",
    );
    const advance = advanceRecoveryDrain(HELD_PAUSE, observed);
    expect(advance.kind).toBe("ADVANCED");
    if (advance.kind !== "ADVANCED") return;
    expect(advance.disposition.strongestReason).toBe("WORK_CANCEL");
    expect([...advance.disposition.reasons]).toEqual(["WORK_CANCEL", "WORK_RELEASE_OR_PAUSE"]);
    expect(advance.disposition.terminalTarget).toBe("CANCELLED");
  });

  it("keeps the held strength when a weaker reason joins the set", () => {
    const observed = disposition(
      ["URGENT_REVOKE", "WORK_RELEASE_OR_PAUSE"],
      "URGENT_REVOKE",
      "CANCELLED",
    );
    const advance = advanceRecoveryDrain(HELD_REVOKE, observed);
    expect(advance.kind).toBe("ADVANCED");
    if (advance.kind !== "ADVANCED") return;
    expect(advance.disposition.strongestReason).toBe("URGENT_REVOKE");
    expect([...advance.disposition.reasons]).toEqual(["URGENT_REVOKE", "WORK_RELEASE_OR_PAUSE"]);
  });

  it("refuses an observed disposition whose strongest reason was walked back", () => {
    const observed = disposition(
      ["URGENT_REVOKE", "WORK_CANCEL"],
      "WORK_CANCEL",
      "CANCELLED",
    );
    const advance = advanceRecoveryDrain(HELD_REVOKE, observed);
    expect(advance.kind).toBe("REFUSED");
    if (advance.kind !== "REFUSED") return;
    expect(advance.failure.code).toBe("RECOVERY_DRAIN_DOWNGRADE_REFUSED");
    expect(advance.failure.layer).toBe("SAFE_BOUNDARY");
  });

  it("refuses an observed disposition that dropped a held reason", () => {
    const observed = disposition(["WORK_CANCEL"], "WORK_CANCEL", "CANCELLED");
    const advance = advanceRecoveryDrain(HELD_REVOKE, observed);
    expect(advance.kind).toBe("REFUSED");
    if (advance.kind !== "REFUSED") return;
    expect(advance.failure.code).toBe("RECOVERY_DRAIN_REASON_DROPPED");
    expect(advance.failure.layer).toBe("SAFE_BOUNDARY");
  });

  /**
   * Epic rail 6: two layers can refuse a drain record, so the test pins WHICH
   * one did. A retargeted disposition is the supervisor's single monotonicity
   * source answering, and its code and layer are carried through verbatim.
   */
  it("carries the supervisor refusal verbatim when the observed target was retargeted", () => {
    const observed = disposition(
      ["URGENT_REVOKE", "WORK_CANCEL"],
      "URGENT_REVOKE",
      "RELEASED",
    );
    const advance = advanceRecoveryDrain(HELD_REVOKE, observed);
    expect(advance.kind).toBe("REFUSED");
    if (advance.kind !== "REFUSED") return;
    expect(advance.failure.code).toBe("DRAIN_DISPOSITION_NOT_MONOTONIC");
    expect(advance.failure.layer).toBe("DRAIN");
  });

  it("carries the supervisor refusal when the held disposition does not parse", () => {
    const advance = advanceRecoveryDrain({ reasons: [] }, HELD_REVOKE);
    expect(advance.kind).toBe("REFUSED");
    if (advance.kind !== "REFUSED") return;
    expect(advance.failure.code).toBe("DRAIN_DISPOSITION_NOT_MONOTONIC");
    expect(advance.failure.layer).toBe("DRAIN");
  });

  it("refuses a downgrade rather than silently returning the held disposition", () => {
    const observed = disposition(["URGENT_REVOKE", "WORK_CANCEL"], "WORK_CANCEL", "CANCELLED");
    const advance = advanceRecoveryDrain(HELD_REVOKE, observed);
    expect(advance).not.toHaveProperty("disposition");
    expect(advance.kind).not.toBe("ADVANCED");
  });
});
