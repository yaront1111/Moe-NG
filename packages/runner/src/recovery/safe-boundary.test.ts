import { describe, expect, it } from "vitest";
import {
  PREDECESSOR_RELEASES,
  RECOVERY_ERROR_CODES,
  type PredecessorRelease,
} from "./recovery-contract.js";
import { admitResume, admitSuccessorOverlap, advanceRecoveryDrain } from "./safe-boundary.js";
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

function overlapRequest(predecessorRelease: unknown): Record<string, unknown> {
  return { predecessorRef: "predecessor-1", successorRef: "successor-1", predecessorRelease };
}

function resumeRequest(
  predecessorRelease: unknown,
  safeHandoff: unknown = HANDOFF,
): Record<string, unknown> {
  return { resumeRef: "resume-1", predecessorRelease, safeHandoff };
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
