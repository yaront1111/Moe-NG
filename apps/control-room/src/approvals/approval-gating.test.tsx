import { buildNextAllowedCommands } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_DECISION_KINDS,
  APPROVAL_FIXTURE_KIND,
  APPROVAL_FIXTURE_RECORDS,
  CUTOVER_CONSEQUENCE_FIXTURE,
  FIXTURE_REVISION_HASH,
  FIXTURE_SUPERSEDING_HASH,
  IDLE_CONSEQUENCES,
  approvalAffordance,
  approvalRecord,
  idleConsequence,
  withRecord,
} from "./approval-fixtures.js";
import type { ApprovalDecisionKind, ApprovalDecisionRecord } from "./approval-fixtures.js";
import {
  APPROVAL_REASONS,
  approvalReason,
  controlTestId,
  resolveApprovalControls,
  unavailableText,
} from "./approval-gating.js";
import type { ApprovalControl, ApprovalControlRequest } from "./approval-gating.js";

const TARGET = "approval-j4-plan";

const APPROVE: ApprovalControlRequest = {
  commandKind: "approval.decide",
  label: "Approve plan",
  qualifier: "approve",
};

function controlsFor(
  record: ApprovalDecisionRecord,
  affordances = [approvalAffordance("approval.decide", { targetAggregateId: TARGET })],
  reasons: Readonly<Record<string, ReturnType<typeof approvalReason>>> = {},
): readonly ApprovalControl[] {
  return resolveApprovalControls({
    affordances,
    reasons,
    record,
    requests: [APPROVE],
    targetAggregateId: TARGET,
  });
}

function onlyControl(...args: Parameters<typeof controlsFor>): ApprovalControl {
  const controls = controlsFor(...args);
  expect(controls).toHaveLength(1);
  return controls[0] as ApprovalControl;
}

const CURRENT_RECORD = approvalRecord({ exactRevisionHash: FIXTURE_REVISION_HASH });

describe("approval fixtures", () => {
  it("marks itself development-only and never confirmatory", () => {
    expect(APPROVAL_FIXTURE_KIND).toBe("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
  });

  it("supplies one frozen record per declared decision kind", () => {
    expect(APPROVAL_DECISION_KINDS.length).toBeGreaterThan(0);
    const kinds = Object.keys(APPROVAL_FIXTURE_RECORDS) as ApprovalDecisionKind[];
    expect(kinds.sort()).toEqual([...APPROVAL_DECISION_KINDS].sort());
    for (const kind of APPROVAL_DECISION_KINDS) {
      expect(Object.isFrozen(APPROVAL_FIXTURE_RECORDS[kind])).toBe(true);
    }
  });

  it("emits affordances the daemon's own parser accepts", () => {
    const built = buildNextAllowedCommands({ aggregate: "APPROVAL", state: "PENDING" }, [
      approvalAffordance("approval.decide", { targetAggregateId: TARGET }),
      approvalAffordance("graph.approve", { commandId: "cmd-fx-expansion", targetAggregateId: TARGET }),
    ]);
    expect(built).toHaveLength(2);
    expect(built.map((entry) => entry.commandKind)).toEqual(["approval.decide", "graph.approve"]);
  });

  it("carries the design-derived cutover consequence payload verbatim", () => {
    expect(Object.keys(CUTOVER_CONSEQUENCE_FIXTURE).sort()).toEqual([
      "consequencePayload", "deadline", "disposition", "exactStoredHash",
      "fundingReservation", "planningFenceMembership", "releaseAction",
    ]);
  });
});

describe("approvals-local reason channel", () => {
  it("refuses a ratified code paired with a source its registry row forbids", () => {
    expect(() => approvalReason("CUTOVER_STATE_INVALID", "GOAL", "wrong home")).toThrow(
      /CUTOVER_STATE_INVALID/,
    );
  });

  it("accepts a source-unrestricted code against any lifecycle source", () => {
    const reason = approvalReason("CAPABILITY_DENIED", "APPROVAL", "your role may not decide R3");
    expect(reason.code).toBe("CAPABILITY_DENIED");
  });

  it("refuses a code spelling the ratified registry does not define", () => {
    expect(() =>
      approvalReason("APPROVAL_STALE" as never, "APPROVAL", "invented"),
    ).toThrow(/APPROVAL_STALE/);
  });

  it("renders the spec 8.1 unavailable sentence exactly", () => {
    expect(unavailableText(APPROVAL_REASONS.HASH_MISMATCH)).toBe(
      `Unavailable: ${APPROVAL_REASONS.HASH_MISMATCH.phrase} (EXPECTED_VERSION_CONFLICT).`,
    );
  });
});

describe("policy-decided record integrity", () => {
  it("refuses a SYSTEM_POLICY record claiming human-approved truth", () => {
    expect(() =>
      approvalRecord({ actorKind: "SYSTEM_POLICY", riskTier: "R1", truthClass: "HUMAN_APPROVED" }),
    ).toThrow(/SYSTEM_POLICY/);
  });

  it("refuses a SYSTEM_POLICY record above the R0/R1 opt-in bound", () => {
    expect(() =>
      approvalRecord({ actorKind: "SYSTEM_POLICY", riskTier: "R2", truthClass: "DAEMON_VERIFIED" }),
    ).toThrow(/R2/);
  });
});

describe("idle-consequence lines", () => {
  it("returns the spec 8.10 line for every kind the spec defines", () => {
    const defined = Object.keys(IDLE_CONSEQUENCES) as (keyof typeof IDLE_CONSEQUENCES)[];
    expect(defined.length).toBe(6);
    for (const kind of defined) {
      expect(idleConsequence(kind)).toBe(IDLE_CONSEQUENCES[kind]);
    }
    expect(idleConsequence("PLAN")).toBe(
      "node waits in PLAN_REVIEW; its lease may lapse to SUSPECT.",
    );
  });

  it("returns null rather than inventing a line for undefined kinds", () => {
    expect(idleConsequence("CUTOVER_QUIESCE")).toBeNull();
    expect(idleConsequence("CUTOVER_ACTIVATE")).toBeNull();
    expect(idleConsequence("SOFT_POLICY_WAIVER")).toBeNull();
  });
});

describe("decide controls derive only from nextAllowedCommands", () => {
  it("enables a control the daemon actually returned for a current record", () => {
    const control = onlyControl(CURRENT_RECORD);
    expect(control.state).toBe("ENABLED");
    expect(control.testId).toBe("cr.action.approval-decide.approve");
    expect(control.commandId).toBe("cmd-fx-approval-decide");
    expect(control.refusedBy).toBeNull();
    expect(control.reasonCode).toBeNull();
  });

  it("names an expansion control after graph.approve, not approval.decide", () => {
    expect(controlTestId("graph.approve")).toBe("cr.action.graph-approve");
    expect(controlTestId("approval.decide", "reject")).toBe("cr.action.approval-decide.reject");
  });

  it("omits the control entirely when the daemon returned neither command nor reason", () => {
    const control = onlyControl(CURRENT_RECORD, []);
    expect(control.state).toBe("ABSENT");
    expect(control.disabledText).toBeNull();
    expect(control.reasonCode).toBeNull();
    expect(control.commandId).toBeNull();
    expect(control.refusedBy).toBe("AFFORDANCE_ABSENT");
  });

  it("disables with the supplied reason when a reason is present but the command is not", () => {
    const control = onlyControl(CURRENT_RECORD, [], {
      "cr.action.approval-decide.approve": APPROVAL_REASONS.CAPABILITY_DENIED,
    });
    expect(control.state).toBe("DISABLED");
    expect(control.reasonCode).toBe("CAPABILITY_DENIED");
    expect(control.refusedBy).toBe("AFFORDANCE_ABSENT");
    expect(control.disabledText).toBe(unavailableText(APPROVAL_REASONS.CAPABILITY_DENIED));
    expect(control.commandId).toBeNull();
  });
});

describe("stale-approval guard", () => {
  it("refuses a record whose approval lifecycle already left PENDING", () => {
    const control = onlyControl(withRecord(CURRENT_RECORD, { lifecycle: "DECIDED" }));
    expect(control.state).toBe("DISABLED");
    expect(control.refusedBy).toBe("RECORD_LIFECYCLE");
    expect(control.reasonCode).toBe("ILLEGAL_TRANSITION");
    expect(control.commandId).toBeNull();
  });

  it("refuses an invalidated record even while the daemon still offers the command", () => {
    const control = onlyControl(withRecord(CURRENT_RECORD, { validity: "INVALIDATED" }));
    expect(control.state).toBe("DISABLED");
    expect(control.refusedBy).toBe("RECORD_VALIDITY");
    expect(control.reasonCode).toBe("REVISION_REBOUND");
  });

  it("refuses a superseded record with the superseded-authority code", () => {
    const control = onlyControl(withRecord(CURRENT_RECORD, { validity: "SUPERSEDED" }));
    expect(control.refusedBy).toBe("RECORD_VALIDITY");
    expect(control.reasonCode).toBe("SUPERSEDED_AUTHORITY");
  });

  it("refuses when the record's exact hash is not the identity the command pins", () => {
    const control = onlyControl(withRecord(CURRENT_RECORD, {
      exactRevisionHash: FIXTURE_SUPERSEDING_HASH,
    }));
    expect(control.state).toBe("DISABLED");
    expect(control.refusedBy).toBe("REVISION_HASH");
    expect(control.reasonCode).toBe("EXPECTED_VERSION_CONFLICT");
  });

  it("refuses fail-closed when the command pins no revision hash to compare", () => {
    const unpinned = approvalAffordance("approval.decide", {
      graphRevisionHash: undefined,
      targetAggregateId: TARGET,
    });
    const control = onlyControl(CURRENT_RECORD, [unpinned]);
    expect(control.state).toBe("DISABLED");
    expect(control.refusedBy).toBe("REVISION_HASH");
    expect(control.reasonCode).toBe("STALE_EPOCH");
  });

  it("pins guard order: lifecycle outranks validity, validity outranks the hash", () => {
    const both = withRecord(CURRENT_RECORD, {
      exactRevisionHash: FIXTURE_SUPERSEDING_HASH,
      validity: "INVALIDATED",
    });
    expect(onlyControl(both).refusedBy).toBe("RECORD_VALIDITY");
    expect(onlyControl(withRecord(both, { lifecycle: "WITHDRAWN" })).refusedBy)
      .toBe("RECORD_LIFECYCLE");
  });

  it("never enables a control for a non-current record across every kind", () => {
    const stale = ["INVALIDATED", "SUPERSEDED"] as const;
    let swept = 0;
    for (const kind of APPROVAL_DECISION_KINDS) {
      for (const validity of stale) {
        const record = withRecord(APPROVAL_FIXTURE_RECORDS[kind], {
          exactRevisionHash: FIXTURE_REVISION_HASH,
          lifecycle: "PENDING",
          validity,
        });
        const control = onlyControl(record);
        expect(control.state).toBe("DISABLED");
        expect(control.commandId).toBeNull();
        swept += 1;
      }
    }
    expect(swept).toBe(APPROVAL_DECISION_KINDS.length * stale.length);
    expect(swept).toBeGreaterThan(0);
  });
});
