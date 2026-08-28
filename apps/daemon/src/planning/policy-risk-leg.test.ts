import type { ApprovalDecisionRecord } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  POLICY_RISK_EVENT_TYPE,
  POLICY_RISK_WRITER_CODES,
  decodePolicyRiskRecord,
  policyRiskAggregateIdFor,
} from "../bootstrap/policy-risk-record.js";
import { POLICY_RISK_APPROVAL_ACTION, buildPolicyRiskLeg } from "./policy-risk-leg.js";
import type { PolicyRiskLegInput } from "./policy-risk-leg.js";

const OPERATOR = "operator-1";
const SUBJECT = Object.freeze({
  subjectRef: "a".repeat(64),
  subjectRevision: 3,
});

function approval(
  overrides: Partial<ApprovalDecisionRecord> = {},
): ApprovalDecisionRecord {
  return {
    actor: OPERATOR,
    actorKind: "HUMAN",
    applicablePolicyRef: "b".repeat(64),
    approvalRef: "approval-risk-1",
    approvedNodeScope: [],
    budgetRef: "c".repeat(64),
    criteriaRef: "d".repeat(64),
    decision: "APPROVE",
    decisionReason: "operator approved",
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash: "e".repeat(64),
    lifecycle: "DECIDED",
    planQualityAssessmentRef: "f".repeat(64),
    policyDecisionRef: "1".repeat(64),
    riskTier: "R2",
    stepUpAuthRef: "step-up-risk-1",
    truthClass: "HUMAN_APPROVED",
    validity: "CURRENT",
    ...overrides,
  };
}

function input(overrides: Partial<PolicyRiskLegInput> = {}): PolicyRiskLegInput {
  return {
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    approval: approval(),
    approvedBy: OPERATOR,
    assessedAt: "2026-08-28T08:00:00.000Z",
    commandId: "command-risk-1",
    projectId: "project-1",
    subject: SUBJECT,
    ...overrides,
  };
}

function withoutTier(record: ApprovalDecisionRecord): ApprovalDecisionRecord {
  const { riskTier: _riskTier, ...rest } = record;
  return rest as ApprovalDecisionRecord;
}

const REFUSAL_CASES = Object.freeze([
  ["nullable decision reference", "POLICY_RISK_DECISION_REF_MISSING", () => input({
    approval: approval({ policyDecisionRef: null }),
  })],
  ["missing step-up", "POLICY_RISK_STEP_UP_MISSING", () => input({
    approval: approval({ stepUpAuthRef: null }),
  })],
  ["non-human actor kind", "POLICY_RISK_ACTOR_NOT_HUMAN", () => input({
    approval: approval({ actorKind: "SYSTEM_POLICY" }),
  })],
  ["non-human truth", "POLICY_RISK_ACTOR_NOT_HUMAN", () => input({
    approval: approval({ truthClass: "DAEMON_VERIFIED" }),
  })],
  ["unbound actor", "POLICY_RISK_ACTOR_NOT_HUMAN", () => input({ approvedBy: "operator-2" })],
  ["missing tier", "POLICY_RISK_TIER_MISSING", () => input({
    approval: withoutTier(approval()),
  })],
  ["missing subject", "POLICY_RISK_SUBJECT_UNAVAILABLE", () => input({ subject: null })],
  ["inactive subject", "POLICY_RISK_SUBJECT_UNAVAILABLE", () => input({
    subject: { ...SUBJECT, subjectRevision: 0 },
  })],
] as const);

const NON_OPERATOR_PRINCIPALS = Object.freeze([
  "agent-risk", "mcp-risk", "demo-risk", "fixture-risk", "test-risk",
] as const);

describe("policy-risk decision leg", () => {
  afterEach(closeStores);

  it("builds one canonical current-version leg from committed human authority", () => {
    const store = openStore();
    const result = buildPolicyRiskLeg(store, input());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
    expect(result.leg.aggregateId).toBe(policyRiskAggregateIdFor({
      actionKind: "plan.approve", projectId: "project-1", subjectRef: SUBJECT.subjectRef,
    }));
    expect(result.leg.expectedVersion).toBe(0);
    expect(result.leg.events).toHaveLength(1);
    expect(result.leg.events[0]?.eventType).toBe(POLICY_RISK_EVENT_TYPE);
    const decoded = decodePolicyRiskRecord(result.leg.events[0]?.payload ?? new Uint8Array());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
    expect(decoded.record).toEqual({
      actionKind: "plan.approve",
      approvedBy: OPERATOR,
      assessedAt: "2026-08-28T08:00:00.000Z",
      decisionRef: "1".repeat(64),
      projectId: "project-1",
      subjectRef: SUBJECT.subjectRef,
      subjectRevision: 3,
      tier: "R2",
    });
    expect(typeof decoded.record.subjectRevision).toBe("number");
  });

  it("fences a later leg at the current risk-aggregate version", () => {
    const store = openStore();
    const first = buildPolicyRiskLeg(store, input());
    if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
    store.commit({
      aggregateId: first.leg.aggregateId,
      commandBytes: new TextEncoder().encode("first-policy-risk-leg"),
      commandId: "seed-first-policy-risk-leg",
      committedAt: "2026-08-28T08:00:00.000Z",
      events: first.leg.events,
      expectedVersion: first.leg.expectedVersion,
    });

    const second = buildPolicyRiskLeg(store, input({ commandId: "command-risk-2" }));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(`${second.code}@${second.layer}`);
    expect(second.leg.aggregateId).toBe(first.leg.aggregateId);
    expect(second.leg.expectedVersion).toBe(1);
  });

  it("pins the exact writer vocabulary bidirectionally to generated refusal arms", () => {
    expect(POLICY_RISK_WRITER_CODES).toEqual([
      "POLICY_RISK_ACTOR_NOT_HUMAN",
      "POLICY_RISK_DECISION_REF_MISSING",
      "POLICY_RISK_STEP_UP_MISSING",
      "POLICY_RISK_TIER_MISSING",
      "POLICY_RISK_SUBJECT_UNAVAILABLE",
    ]);
    expect(POLICY_RISK_WRITER_CODES).toHaveLength(5);
    expect(REFUSAL_CASES).toHaveLength(8);
    expect(new Set(REFUSAL_CASES.map(([, code]) => code)))
      .toEqual(new Set(POLICY_RISK_WRITER_CODES));
  });

  it.each(REFUSAL_CASES)("refuses %s as %s without producing a leg", (_name, code, arrange) => {
    const result = buildPolicyRiskLeg(openStore(), arrange());
    const extras = result.ok ? [result.leg] : [];

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected policy-risk writer refusal");
    expect(result.code).toBe(code);
    expect(result.layer).toBe("DAEMON_POLICY_RISK");
    expect(extras).toEqual([]);
  });

  it("requires the server-assembled operator witness for non-operator principal names", () => {
    expect(NON_OPERATOR_PRINCIPALS).toHaveLength(5);
    let executed = 0;
    for (const actor of NON_OPERATOR_PRINCIPALS) {
      const result = buildPolicyRiskLeg(openStore(), input({
        approval: approval({ actor }), approvedBy: null,
      }));
      expect(result).toEqual({
        code: "POLICY_RISK_ACTOR_NOT_HUMAN", layer: "DAEMON_POLICY_RISK", ok: false,
      });
      expect(result.ok ? [result.leg] : []).toEqual([]);
      executed += 1;
    }
    expect(executed).toBe(NON_OPERATOR_PRINCIPALS.length);
  });
});
