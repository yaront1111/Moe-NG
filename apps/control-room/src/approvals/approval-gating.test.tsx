import { cleanup, render, screen } from "@testing-library/react";
import { buildNextAllowedCommands } from "@moe/contracts";
import { APPROVAL_AUTHORITY_CODES } from "@moe/core";
import type { ApprovalPolicy, HumanAuthorityGate, HumanAuthorityGrant } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_DECISION_KINDS, APPROVAL_FIXTURE_KIND, APPROVAL_FIXTURE_RECORDS,
  CUTOVER_CONSEQUENCE_FIXTURE, FIXTURE_REVISION_HASH, FIXTURE_SUPERSEDING_HASH, IDLE_CONSEQUENCES, approvalAffordance, approvalRecord, idleConsequence, withRecord,
} from "./approval-fixtures.js";
import type { ApprovalDecisionRecord } from "./approval-fixtures.js";
import {
  APPROVAL_REASONS, approvalReason, controlTestId, decisionCommandKind,
  resolveApprovalControls, unavailableText,
} from "./approval-gating.js";
import type { ApprovalAuthorityContext, ApprovalControl, ApprovalControlRequest } from "./approval-gating.js";
import { DecisionControl } from "./approval-inbox.js";
afterEach(cleanup);
const TARGET = "approval-j4-plan";
const APPROVE: ApprovalControlRequest = { commandKind: "approval.decide", label: "Approve plan", qualifier: "approve" };
const AUTO_POLICY: ApprovalPolicy = { delayMs: 25, kind: "PROCEED_WITHOUT_HUMAN" },
  HUMAN_POLICY: ApprovalPolicy = { kind: "REQUIRE_HUMAN" };
const UNSATISFIED_GATE: HumanAuthorityGate = { gateId: "human-gate-1", grant: null, workRef: TARGET };
const HUMAN_GRANT: HumanAuthorityGrant = {
  gateId: UNSATISFIED_GATE.gateId, grantedAtEpochMs: 1_786_755_600_000,
  principalId: "operator-alice", principalKind: "HUMAN", workRef: TARGET,
};
const SATISFIED_GATE: HumanAuthorityGate = { ...UNSATISFIED_GATE, grant: HUMAN_GRANT };
const CURRENT_RECORD = approvalRecord({ exactRevisionHash: FIXTURE_REVISION_HASH });
function controlsFor(
  record: ApprovalDecisionRecord,
  affordances = [approvalAffordance("approval.decide", { targetAggregateId: TARGET })],
  reasons: Readonly<Record<string, ReturnType<typeof approvalReason>>> = {},
  authority?: ApprovalAuthorityContext,
): readonly ApprovalControl[] {
  return resolveApprovalControls({ affordances, authority, reasons, record, requests: [APPROVE], targetAggregateId: TARGET });
}
function onlyControl(...args: Parameters<typeof controlsFor>): ApprovalControl {
  const controls = controlsFor(...args);
  expect(controls).toHaveLength(1); return controls[0] as ApprovalControl;
}
describe("approval fixtures", () => {
  it("remains development-only with an exact nonempty kind inventory", () => {
    expect(APPROVAL_FIXTURE_KIND).toBe("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
    const kinds = Object.keys(APPROVAL_FIXTURE_RECORDS).sort();
    expect(kinds).toEqual([...APPROVAL_DECISION_KINDS].sort());
    expect(kinds.length).toBe(APPROVAL_DECISION_KINDS.length);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of APPROVAL_DECISION_KINDS) {
      expect(Object.isFrozen(APPROVAL_FIXTURE_RECORDS[kind])).toBe(true);
    }
  });
  it("emits affordances accepted by the production parser", () => {
    const built = buildNextAllowedCommands({ aggregate: "APPROVAL", state: "PENDING" }, [
      approvalAffordance("approval.decide", { targetAggregateId: TARGET }),
      approvalAffordance("graph.approve", { commandId: "cmd-expansion", targetAggregateId: TARGET }),
    ]);
    expect(built.map((entry) => entry.commandKind)).toEqual(["approval.decide", "graph.approve"]);
  });
  it("keeps the design-derived cutover payload exact", () => {
    expect(Object.keys(CUTOVER_CONSEQUENCE_FIXTURE).sort()).toEqual([
      "consequencePayload", "deadline", "disposition", "exactStoredHash",
      "fundingReservation", "planningFenceMembership", "releaseAction",
    ]);
  });
});
describe("landed approval refusal vocabulary", () => {
  it("maps all eight codes to their literal canonical layers", () => {
    const projected = APPROVAL_AUTHORITY_CODES.map((code) => approvalReason(code, code))
      .map((reason) => `${reason.code}@${reason.refusingLayer}`);
    expect(projected.length).toBe(APPROVAL_AUTHORITY_CODES.length);
    expect(projected.length).toBe(8);
    expect(projected.length).toBeGreaterThan(0);
    expect(projected).toEqual([
      "APPROVAL_HUMAN_AUTHORITY_REQUIRED@HUMAN_AUTHORITY_GATE",
      "APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE",
      "APPROVAL_PRINCIPAL_MISSING@HUMAN_AUTHORITY_GATE",
      "APPROVAL_PRINCIPAL_UNNAMED@HUMAN_AUTHORITY_GATE",
      "APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE",
      "APPROVAL_GRANT_MOMENT_INVALID@HUMAN_AUTHORITY_GATE",
      "APPROVAL_POLICY_DELAY_INVALID@APPROVAL_POLICY",
      "APPROVAL_HUMAN_REVIEW_REQUIRED@APPROVAL_POLICY",
    ]);
  });
  it("includes code and layer literally in unavailable copy", () => {
    expect(unavailableText(APPROVAL_REASONS.HASH_MISMATCH)).toBe(
      `Unavailable: ${APPROVAL_REASONS.HASH_MISMATCH.phrase} `
      + "(APPROVAL_AUTHORITY_BINDING_MISMATCH @ HUMAN_AUTHORITY_GATE).",
    );
  });
});
describe("authority presentation", () => {
  it("visibly renders a gate-layer refusal with its unsatisfied binding", () => {
    const control = onlyControl(CURRENT_RECORD, undefined, {}, {
      gate: UNSATISFIED_GATE, policy: AUTO_POLICY,
    });
    render(<DecisionControl control={control} />);
    const button = screen.getByTestId(control.testId);
    expect([button.dataset.reasonCode, button.dataset.refusingLayer])
      .toEqual(["APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"]);
    for (const literal of [
      /APPROVAL_HUMAN_AUTHORITY_REQUIRED/, /HUMAN_AUTHORITY_GATE/,
      "human-gate-1", TARGET, "UNSATISFIED",
    ]) expect(screen.getByText(literal)).toBeDefined();
  });
  it("visibly renders a policy-layer refusal", () => {
    const control = onlyControl(CURRENT_RECORD, undefined, {}, {
      gate: null, policy: HUMAN_POLICY,
    });
    render(<DecisionControl control={control} />);
    const button = screen.getByTestId(control.testId);
    expect([button.dataset.reasonCode, button.dataset.refusingLayer])
      .toEqual(["APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY"]);
    for (const literal of [
      /APPROVAL_HUMAN_REVIEW_REQUIRED/, /APPROVAL_POLICY/, "REQUIRE_HUMAN",
    ]) expect(screen.getByText(literal)).toBeDefined();
  });
  it("renders automatic policy delay and a named human grant", () => {
    const automatic = onlyControl(CURRENT_RECORD, undefined, {}, {
      gate: null, policy: AUTO_POLICY,
    });
    const automaticView = render(<DecisionControl control={automatic} />);
    expect(screen.getByText("PROCEED_WITHOUT_HUMAN")).toBeDefined();
    expect(screen.getByText("25 ms")).toBeDefined();
    expect(automaticView.container.querySelectorAll("[data-testid^='cr.fact.']")).toHaveLength(2);
    automaticView.unmount();
    const granted = onlyControl(CURRENT_RECORD, undefined, {}, {
      gate: SATISFIED_GATE, policy: HUMAN_POLICY,
    });
    const grantedView = render(<DecisionControl control={granted} />);
    for (const literal of [
      "REQUIRE_HUMAN", "human-gate-1", TARGET, "SATISFIED", "HUMAN",
      "operator-alice", String(HUMAN_GRANT.grantedAtEpochMs),
    ]) expect(screen.getByText(literal)).toBeDefined();
    const factIds = [...grantedView.container.querySelectorAll("[data-testid^='cr.fact.']")]
      .map((node) => node.getAttribute("data-testid"));
    expect(factIds).toHaveLength(7);
    expect(new Set(factIds).size).toBe(7);
    expect(grantedView.container.querySelectorAll("[data-testid^='cr.chip.']")).toHaveLength(7);
  });
});
describe("controls derive only from supplied command authority", () => {
  it("enables only a returned command for a current record without invented context", () => {
    const control = onlyControl(CURRENT_RECORD);
    expect(control).toMatchObject({
      commandId: "cmd-fx-approval-decide", reasonCode: null,
      refusedBy: null, refusingLayer: null, state: "ENABLED",
    });
    const { container } = render(<DecisionControl control={control} />);
    expect(container.querySelectorAll("[data-testid^='cr.fact.']")).toHaveLength(0);
  });
  it("keeps a control absent when neither command nor reason was supplied", () => {
    expect(onlyControl(CURRENT_RECORD, [])).toMatchObject({
      commandId: null, disabledText: null, reasonCode: null,
      refusedBy: "AFFORDANCE_ABSENT", refusingLayer: null, state: "ABSENT",
    });
  });
  it("disables an absent affordance with the exact supplied refusal", () => {
    const control = onlyControl(CURRENT_RECORD, [], {
      "cr.action.approval-decide.approve": APPROVAL_REASONS.HUMAN_AUTHORITY_REQUIRED,
    });
    expect(control).toMatchObject({
      commandId: null, reasonCode: "APPROVAL_HUMAN_AUTHORITY_REQUIRED",
      refusedBy: "AFFORDANCE_ABSENT", refusingLayer: "HUMAN_AUTHORITY_GATE",
      state: "DISABLED",
    });
  });
  it("normalizes a forged code-layer pair at the production boundary", () => {
    const forged = {
      code: "APPROVAL_HUMAN_REVIEW_REQUIRED", phrase: "forged layer",
      refusingLayer: "HUMAN_AUTHORITY_GATE",
    } as unknown as ReturnType<typeof approvalReason>;
    const reasons = { "cr.action.approval-decide.approve": forged };
    const control = onlyControl(CURRENT_RECORD, [], reasons);
    expect(control).toMatchObject({
      commandId: null, reasonCode: "APPROVAL_AUTHORITY_BINDING_MISMATCH",
      refusedBy: "AFFORDANCE_ABSENT", refusingLayer: "HUMAN_AUTHORITY_GATE",
    });
  });
  it("offers no approving control for any decision kind behind an unsatisfied gate", () => {
    const requests = APPROVAL_DECISION_KINDS.map((kind) => ({
      commandKind: decisionCommandKind(kind), label: `Decide ${kind}`,
      qualifier: kind.toLowerCase(),
    }));
    const affordances = requests.map((request, index) => approvalAffordance(request.commandKind, {
      commandId: `cmd-gated-${index}`, targetAggregateId: TARGET,
    }));
    const controls = resolveApprovalControls({
      affordances, authority: { gate: UNSATISFIED_GATE, policy: AUTO_POLICY },
      record: CURRENT_RECORD, requests, targetAggregateId: TARGET,
    });
    expect(requests.length).toBe(APPROVAL_DECISION_KINDS.length);
    expect(controls.length).toBe(APPROVAL_DECISION_KINDS.length);
    expect(controls.length).toBeGreaterThan(0);
    expect(new Set(controls.map((control) => control.testId)).size).toBe(controls.length);
    for (const control of controls) {
      expect(["DISABLED", "ABSENT"]).toContain(control.state);
      expect(control.commandId).toBeNull();
      expect(control.reasonCode).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
      expect(control.refusingLayer).toBe("HUMAN_AUTHORITY_GATE");
    }
  });
  it("deduplicates repeated gated controls without creating an enabled path", () => {
    const controls = resolveApprovalControls({
      affordances: [approvalAffordance("approval.decide", { targetAggregateId: TARGET })],
      authority: { gate: UNSATISFIED_GATE, policy: AUTO_POLICY }, record: CURRENT_RECORD,
      requests: [APPROVE, APPROVE], targetAggregateId: TARGET,
    });
    expect([controls.length, controls.length > 0]).toEqual([1, true]);
    expect(controls[0]).toMatchObject({
      commandId: null, reasonCode: "APPROVAL_HUMAN_AUTHORITY_REQUIRED",
      refusingLayer: "HUMAN_AUTHORITY_GATE", state: "DISABLED",
    });
  });
  it("keeps malformed, empty, and non-human authority inputs refused", () => {
    const malformed = { gate: null, policy: null } as never, empty = { gate: { gateId: "", grant: null, workRef: "" }, policy: AUTO_POLICY };
    const nonHuman = { gate: { ...UNSATISFIED_GATE,
      grant: { ...HUMAN_GRANT, principalKind: "AGENT" as const } }, policy: AUTO_POLICY };
    const controls = [malformed, empty, nonHuman].map((authority) => onlyControl(CURRENT_RECORD, undefined, {}, authority));
    expect(controls).toHaveLength(3);
    expect(controls.map((control) => `${control.reasonCode}@${control.refusingLayer}`)).toEqual([
      "APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE",
      "APPROVAL_HUMAN_AUTHORITY_REQUIRED@HUMAN_AUTHORITY_GATE",
      "APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE",
    ]);
    for (const control of controls) expect(control.commandId).toBeNull();
    let gateReads = 0;
    const observedOnce = { policy: AUTO_POLICY, get gate() { gateReads += 1; return null; } } as ApprovalAuthorityContext;
    onlyControl(CURRENT_RECORD, undefined, {}, observedOnce); expect(gateReads).toBe(1);
  });
  it("derives stable test IDs from commands and qualifiers", () => {
    expect(controlTestId("graph.approve")).toBe("cr.action.graph-approve");
    expect(controlTestId("approval.decide", "reject")).toBe("cr.action.approval-decide.reject");
  });
});
describe("local structural guards", () => {
  const expectBindingRefusal = (record: ApprovalDecisionRecord, refusedBy: string): void => {
    expect(onlyControl(record)).toMatchObject({
      commandId: null, reasonCode: "APPROVAL_AUTHORITY_BINDING_MISMATCH", refusedBy,
      refusingLayer: "HUMAN_AUTHORITY_GATE", state: "DISABLED",
    });
  };
  it("names the lifecycle guard separately from its canonical refusal layer", () => {
    expectBindingRefusal(withRecord(CURRENT_RECORD, { lifecycle: "DECIDED" }), "RECORD_LIFECYCLE");
  });
  it("names each validity refusal and its stable code", () => {
    expectBindingRefusal(withRecord(CURRENT_RECORD, { validity: "INVALIDATED" }), "RECORD_VALIDITY");
    expectBindingRefusal(withRecord(CURRENT_RECORD, { validity: "SUPERSEDED" }), "RECORD_VALIDITY");
  });
  it("names hash mismatch and missing binding at the same canonical layer", () => {
    expectBindingRefusal(withRecord(CURRENT_RECORD, {
      exactRevisionHash: FIXTURE_SUPERSEDING_HASH,
    }), "REVISION_HASH");
    const unpinned = approvalAffordance("approval.decide", {
      graphRevisionHash: undefined, targetAggregateId: TARGET,
    });
    const control = onlyControl(CURRENT_RECORD, [unpinned]);
    expect(control).toMatchObject({
      reasonCode: "APPROVAL_AUTHORITY_BINDING_MISMATCH", refusedBy: "REVISION_HASH",
      refusingLayer: "HUMAN_AUTHORITY_GATE",
    });
  });
  it("checks authority, then lifecycle, validity, and hash", () => {
    const stale = withRecord(CURRENT_RECORD, {
      exactRevisionHash: FIXTURE_SUPERSEDING_HASH, lifecycle: "WITHDRAWN", validity: "INVALIDATED",
    });
    const gated = onlyControl(stale, undefined, {}, { gate: UNSATISFIED_GATE, policy: AUTO_POLICY });
    expect(gated).toMatchObject({
      reasonCode: "APPROVAL_HUMAN_AUTHORITY_REQUIRED", refusedBy: "AUTHORITY_CONTEXT",
      refusingLayer: "HUMAN_AUTHORITY_GATE",
    });
    expectBindingRefusal(stale, "RECORD_LIFECYCLE");
    expectBindingRefusal(withRecord(stale, { lifecycle: "PENDING" }), "RECORD_VALIDITY");
  });
  it("refuses every non-current production record with exact nonzero coverage", () => {
    const cases = APPROVAL_DECISION_KINDS.flatMap((kind) =>
      (["INVALIDATED", "SUPERSEDED"] as const).map((validity) =>
        withRecord(APPROVAL_FIXTURE_RECORDS[kind], {
          exactRevisionHash: FIXTURE_REVISION_HASH, lifecycle: "PENDING", validity,
        })));
    expect(cases.length).toBe(APPROVAL_DECISION_KINDS.length * 2);
    expect(cases.length).toBeGreaterThan(0);
    for (const record of cases) expectBindingRefusal(record, "RECORD_VALIDITY");
  });
});
describe("record and consequence integrity", () => {
  it("keeps policy records inside the R0/R1 daemon-verified bound", () => {
    expect(() => approvalRecord({
      actorKind: "SYSTEM_POLICY", riskTier: "R1", truthClass: "HUMAN_APPROVED",
    })).toThrow(/SYSTEM_POLICY/);
    expect(() => approvalRecord({
      actorKind: "SYSTEM_POLICY", riskTier: "R2", truthClass: "DAEMON_VERIFIED",
    })).toThrow(/R2/);
  });
  it("returns every declared idle consequence and invents none", () => {
    const defined = Object.keys(IDLE_CONSEQUENCES) as (keyof typeof IDLE_CONSEQUENCES)[];
    expect(defined.length).toBe(6);
    for (const kind of defined) expect(idleConsequence(kind)).toBe(IDLE_CONSEQUENCES[kind]);
    expect(idleConsequence("CUTOVER_QUIESCE")).toBeNull();
  });
});
