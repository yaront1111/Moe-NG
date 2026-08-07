import { describe, expect, it } from "vitest";

import type {
  ApprovalCommand,
  ApprovalDecisionRecord,
  ApprovalInvalidationInput,
  CarryForwardInput,
} from "./approval-contract.js";
import {
  applyApprovalCommand,
  applyApprovalInvalidation,
  evaluateCarryForward,
} from "./approval-invalidation.js";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const REVISION = hash("11");
const SUCCESSOR_REVISION = hash("22");
const NODE = "node:alpha";
const OTHER = "node:beta";
const CANONICALIZER = "moe-canonical/1";

const approval = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord => ({
  actor: "human:root", actorKind: "HUMAN", applicablePolicyRef: hash("33"),
  approvalRef: "approval:1", approvedNodeScope: [NODE], budgetRef: hash("44"),
  criteriaRef: hash("55"), decision: null, decisionReason: null,
  dependencyChanges: { additions: [], challenges: [], removals: [] },
  exactRevisionHash: REVISION, lifecycle: "PENDING", planQualityAssessmentRef: hash("66"),
  policyDecisionRef: null, riskTier: "R1", stepUpAuthRef: "stepup:1",
  truthClass: "HUMAN_APPROVED", validity: "CURRENT", ...over,
});

const systemApproval = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord =>
  approval({
    actor: `policy:${hash("77")}`, actorKind: "SYSTEM_POLICY", policyDecisionRef: hash("88"),
    stepUpAuthRef: null, truthClass: "DAEMON_VERIFIED", ...over,
  });

const DECIDE: ApprovalCommand = {
  decision: "APPROVE", decisionReason: null, kind: "approval.decide", stepUpAuthRef: "stepup:1",
};
const WITHDRAW: ApprovalCommand = { kind: "approval.withdraw" };

function decided(record: ApprovalDecisionRecord, command: ApprovalCommand): ApprovalDecisionRecord {
  const result = applyApprovalCommand(record, command);
  if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
  return result.value;
}

function refusal(record: unknown, command: unknown): { code: string; state: unknown } {
  const result = applyApprovalCommand(record, command);
  if (result.ok) throw new Error("expected rejection");
  return { code: result.error.code, state: result.error.details["sourceState"] };
}

function invalidation(over: Partial<ApprovalInvalidationInput>): readonly ApprovalDecisionRecord[] {
  const result = applyApprovalInvalidation({
    approvals: [approval()],
    impactSet: { canonicalizerVersion: CANONICALIZER, changedNodeRefs: [], changedRevisionHashes: [] },
    successorLinks: [],
    supportedCanonicalizerVersions: [CANONICALIZER],
    ...over,
  });
  if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
  return result.value;
}

const carryForward = (over: Partial<CarryForwardInput> = {}): CarryForwardInput => ({
  canonicalizerVersion: CANONICALIZER, dependenciesPresent: true,
  environmentClosureUnchanged: true, policySliceUnchanged: true,
  predecessorResultUnchanged: true, sourceHash: REVISION, targetHash: REVISION, ...over,
});

describe("approval lifecycle", () => {
  it("decides once and freezes the decided record", () => {
    const record = decided(approval(), DECIDE);
    expect(record).toMatchObject({ decision: "APPROVE", lifecycle: "DECIDED", validity: "CURRENT" });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("keeps the decision immutable and WITHDRAWN terminal", () => {
    expect(refusal(decided(approval(), DECIDE), { ...DECIDE, decision: "REJECT" }))
      .toEqual({ code: "ILLEGAL_TRANSITION", state: "DECIDED" });
    const withdrawn = decided(approval(), WITHDRAW);
    expect(withdrawn).toMatchObject({ decision: null, lifecycle: "WITHDRAWN" });
    expect(refusal(withdrawn, DECIDE)).toEqual({ code: "ILLEGAL_TRANSITION", state: "WITHDRAWN" });
    expect(refusal(withdrawn, WITHDRAW)).toEqual({ code: "ILLEGAL_TRANSITION", state: "WITHDRAWN" });
  });

  it("raises ILLEGAL_TRANSITION rather than degrading to UNKNOWN_ERROR", () => {
    const result = applyApprovalCommand(decided(approval(), DECIDE), DECIDE);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("ILLEGAL_TRANSITION");
    expect(result.error.truthClass).toBe("DAEMON_VERIFIED");
    expect(result.error.details).toMatchObject({
      aggregateKind: "APPROVAL", commandKind: "approval.decide", sourceState: "DECIDED",
    });
  });

  it("requires a reason on R3 and step-up on every human decision", () => {
    expect(refusal(approval({ riskTier: "R3" }), DECIDE).code).toBe("ILLEGAL_TRANSITION");
    expect(decided(approval({ riskTier: "R3" }), { ...DECIDE, decisionReason: "operator sign-off" })
      .decisionReason).toBe("operator sign-off");
    expect(refusal(approval(), { ...DECIDE, stepUpAuthRef: null }).code).toBe("ILLEGAL_TRANSITION");
  });

  it("never lets a SYSTEM_POLICY record claim human authority or a human-only tier", () => {
    const forgeries: readonly ApprovalDecisionRecord[] = [
      systemApproval({ truthClass: "HUMAN_APPROVED" }),
      systemApproval({ riskTier: "R2" }),
      systemApproval({ riskTier: "R3" }),
      systemApproval({ stepUpAuthRef: "stepup:forged" }),
      systemApproval({ policyDecisionRef: null }),
      systemApproval({ actor: "human:root" }),
    ];
    for (const forged of forgeries) {
      expect(refusal(forged, DECIDE).code).toBe("INPUT_INVALID");
    }
    expect(decided(systemApproval(), { ...DECIDE, stepUpAuthRef: null }).truthClass)
      .toBe("DAEMON_VERIFIED");
  });

  it("refuses a record whose decision and lifecycle disagree", () => {
    expect(refusal(approval({ decision: "APPROVE" }), DECIDE).code).toBe("INPUT_INVALID");
    expect(refusal(approval({ lifecycle: "DECIDED" }), DECIDE).code).toBe("INPUT_INVALID");
    expect(refusal(approval({ truthClass: "AGENT_REPORTED" }), DECIDE).code).toBe("INPUT_INVALID");
    expect(refusal(approval({ stepUpAuthRef: null }), DECIDE).code).toBe("INPUT_INVALID");
    expect(refusal(approval({ exactRevisionHash: "short" }), DECIDE).code).toBe("INPUT_INVALID");
    expect(refusal(approval(), { kind: "approval.unknown" }).code).toBe("INPUT_INVALID");
  });

  it("refuses to act on an approval whose validity has already settled", () => {
    for (const validity of ["INVALIDATED", "SUPERSEDED"] as const) {
      expect(refusal(approval({ validity }), DECIDE))
        .toEqual({ code: "ILLEGAL_TRANSITION", state: "PENDING" });
      expect(refusal(approval({ validity }), WITHDRAW).code).toBe("ILLEGAL_TRANSITION");
    }
  });
});

describe("selective invalidation", () => {
  it("invalidates only what the impact set proves changed", () => {
    const [byHash] = invalidation({
      impactSet: { canonicalizerVersion: CANONICALIZER, changedNodeRefs: [],
        changedRevisionHashes: [REVISION] },
    });
    expect(byHash?.validity).toBe("INVALIDATED");
    const [byScope] = invalidation({
      impactSet: {
        canonicalizerVersion: CANONICALIZER, changedNodeRefs: [NODE], changedRevisionHashes: [],
      },
    });
    expect(byScope?.validity).toBe("INVALIDATED");
    expect(byScope).toMatchObject({
      approvalRef: "approval:1", approvedNodeScope: [NODE], exactRevisionHash: REVISION,
    });
  });

  it("leaves every non-intersecting approval bit-identical", () => {
    const untouched = approval({ approvalRef: "approval:2", approvedNodeScope: [OTHER] });
    const result = invalidation({
      approvals: [untouched],
      impactSet: { canonicalizerVersion: CANONICALIZER, changedNodeRefs: [NODE],
        changedRevisionHashes: [SUCCESSOR_REVISION] },
    });
    expect(result[0]).toEqual(untouched);
    expect(result[0]).not.toBe(untouched);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("supersedes only through an explicit successor linkage", () => {
    const links = [{ predecessorApprovalRef: "approval:1", successorApprovalRef: "approval:9" }];
    const [superseded] = invalidation({ successorLinks: links });
    expect(superseded?.validity).toBe("SUPERSEDED");
    const [both] = invalidation({
      impactSet: { canonicalizerVersion: CANONICALIZER, changedNodeRefs: [],
        changedRevisionHashes: [REVISION] },
      successorLinks: links,
    });
    expect(both?.validity).toBe("SUPERSEDED");
  });

  it("never moves validity backward and never relabels a settled approval", () => {
    for (const validity of ["INVALIDATED", "SUPERSEDED"] as const) {
      const settled = approval({ validity });
      const result = invalidation({
        approvals: [settled],
        impactSet: { canonicalizerVersion: CANONICALIZER, changedNodeRefs: [NODE],
          changedRevisionHashes: [REVISION] },
        successorLinks: [
          { predecessorApprovalRef: "approval:1", successorApprovalRef: "approval:9" },
        ],
      });
      expect(result[0]).toEqual(settled);
    }
  });

  it("refuses an impact set whose canonicalizer version is unknown", () => {
    const result = applyApprovalInvalidation({
      approvals: [approval()],
      impactSet: { canonicalizerVersion: "moe-canonical/99", changedNodeRefs: [NODE],
        changedRevisionHashes: [] },
      successorLinks: [],
      supportedCanonicalizerVersions: [CANONICALIZER],
    });
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("INPUT_INVALID");
  });
});

describe("carry-forward adoption", () => {
  it("names each of the six invalidation conditions and admits only a clean adoption", () => {
    const cases: readonly (readonly [Partial<CarryForwardInput>, string])[] = [
      [{ targetHash: SUCCESSOR_REVISION }, "CARRY_FORWARD_HASH_MISMATCH"],
      [{ dependenciesPresent: false }, "CARRY_FORWARD_DEPENDENCY_MISSING"],
      [{ policySliceUnchanged: false }, "CARRY_FORWARD_POLICY_SLICE_CHANGED"],
      [{ predecessorResultUnchanged: false }, "CARRY_FORWARD_PREDECESSOR_RESULT_CHANGED"],
      [{ environmentClosureUnchanged: false }, "CARRY_FORWARD_ENVIRONMENT_CHANGED"],
      [{ canonicalizerVersion: "moe-canonical/99" }, "CARRY_FORWARD_CANONICALIZATION_UNKNOWN"],
    ];
    for (const [over, code] of cases) {
      const result = evaluateCarryForward(carryForward(over), [CANONICALIZER]);
      if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
      expect(result.value).toMatchObject({ valid: false });
      expect(result.value.reasonCodes).toContain(code);
    }
    const clean = evaluateCarryForward(carryForward(), [CANONICALIZER]);
    if (!clean.ok) throw new Error("unexpected rejection");
    expect(clean.value).toEqual({ reasonCodes: [], valid: true });
  });

  it("rejects a malformed carry-forward input instead of defaulting it", () => {
    for (const [input, supported] of [
      [{ ...carryForward(), sourceHash: "short" }, [CANONICALIZER]],
      [carryForward(), []],
      [carryForward(), null],
      [carryForward(), [""]],
    ] as const) {
      const result = evaluateCarryForward(input, supported);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.code).toBe("INPUT_INVALID");
    }
  });
});
