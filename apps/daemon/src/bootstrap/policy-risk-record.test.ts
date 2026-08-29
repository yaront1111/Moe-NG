import { POLICY_RISK_TIERS } from "@moe/core";
import { describe, expect, it } from "vitest";

import * as policyRiskRecordModule from "./policy-risk-record.js";
import {
  POLICY_RISK_RECORD_KEYS,
  POLICY_RISK_WRITER_CODES,
  buildPolicyRiskRecord,
  decodePolicyRiskRecord,
  policyRiskAggregateIdFor,
  policyRiskRefusal,
  selectCurrentPolicyRiskRecord,
} from "./policy-risk-record.js";

const BASE = Object.freeze({
  actionKind: "foundation.dispatch",
  approvedBy: "human:operator-1",
  assessedAt: "2026-08-27T19:35:00.000Z",
  decisionRef: "decision-risk-1",
  projectId: "project-1",
  subjectRef: "a".repeat(64),
  subjectRevision: 7,
  tier: "R2",
});

const refusal = (result: ReturnType<typeof buildPolicyRiskRecord>) => {
  expect(result).toEqual({
    code: "POLICY_RISK_RECORD_INVALID",
    layer: "DAEMON_POLICY_RISK",
    ok: false,
  });
};

const recordOf = (value: unknown = BASE) => {
  const result = buildPolicyRiskRecord(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result;
};

describe("policy risk record contract", () => {
  it("exports the layer at column zero for the boundary roster (task-12465418) while stamping literal refusals", () => {
    expect(policyRiskRecordModule.POLICY_RISK_LAYER).toBe("DAEMON_POLICY_RISK");
    expect(policyRiskRefusal("POLICY_RISK_ACTION_MISSING")).toEqual({
      code: "POLICY_RISK_ACTION_MISSING",
      layer: "DAEMON_POLICY_RISK",
      ok: false,
    });
    if (false) {
      // @ts-expect-error arbitrary codes are outside the closed policy-risk vocabulary
      policyRiskRefusal("POLICY_RISK_ARBITRARY");
    }
  });

  it("publishes the exact closed writer refusal vocabulary", () => {
    expect(POLICY_RISK_WRITER_CODES).toEqual([
      "POLICY_RISK_ACTOR_NOT_HUMAN",
      "POLICY_RISK_DECISION_REF_MISSING",
      "POLICY_RISK_STEP_UP_MISSING",
      "POLICY_RISK_TIER_MISSING",
      "POLICY_RISK_SUBJECT_UNAVAILABLE",
    ]);
    expect(POLICY_RISK_WRITER_CODES).toHaveLength(5);
    expect(Object.isFrozen(POLICY_RISK_WRITER_CODES)).toBe(true);
  });

  it("freezes the exact amended eight-key roster without an expiry", () => {
    expect(POLICY_RISK_RECORD_KEYS).toEqual([
      "actionKind", "approvedBy", "assessedAt", "decisionRef",
      "projectId", "subjectRef", "subjectRevision", "tier",
    ]);
    expect(POLICY_RISK_RECORD_KEYS).toHaveLength(8);
    expect(Object.isFrozen(POLICY_RISK_RECORD_KEYS)).toBe(true);
  });

  const EXTRA_KEYS = Object.freeze(["expiresAt", "factId", "truthClass"] as const);
  it("refuses every named ninth key instead of dropping it", () => {
    expect(EXTRA_KEYS).toHaveLength(3);
    expect(new Set(EXTRA_KEYS).size).toBe(3);
    for (const key of EXTRA_KEYS) refusal(buildPolicyRiskRecord({ ...BASE, [key]: "caller" }));

    const hidden = { ...BASE };
    Object.defineProperty(hidden, "expiresAt", { value: "2027-01-01T00:00:00.000Z" });
    refusal(buildPolicyRiskRecord(hidden));
  });

  it("admits exactly the four core risk tiers", () => {
    expect(POLICY_RISK_TIERS).toHaveLength(4);
    for (const tier of POLICY_RISK_TIERS) expect(recordOf({ ...BASE, tier }).record.tier).toBe(tier);
    refusal(buildPolicyRiskRecord({ ...BASE, tier: "R4" }));
  });

  const INVALID_FIELDS = Object.freeze([
    ["decisionRef", ""],
    ["approvedBy", "   "],
    ["assessedAt", "2026-08-27"],
    ["assessedAt", "2026-08-27T19:35:00Z"],
    ["subjectRevision", -1],
  ] as const);
  it("refuses empty authority refs, noncanonical instants and invalid revisions", () => {
    expect(INVALID_FIELDS).toHaveLength(5);
    for (const [key, value] of INVALID_FIELDS) {
      refusal(buildPolicyRiskRecord({ ...BASE, [key]: value }));
    }
  });

  it("refuses a descriptor trap instead of throwing across the codec boundary", () => {
    const hostile = new Proxy(BASE, {
      getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); },
    });

    refusal(buildPolicyRiskRecord(hostile));
  });

  it("round-trips canonical bytes and freezes the decoded record", () => {
    const built = recordOf();
    const decoded = decodePolicyRiskRecord(built.bytes);
    expect(decoded).toEqual(built);
    if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
    expect(Object.isFrozen(decoded.record)).toBe(true);
    expect(recordOf(decoded.record).bytes).toEqual(built.bytes);
  });

  it("selects the highest subject revision without editing either record", () => {
    const lower = recordOf({ ...BASE, subjectRevision: 6 }).record;
    const higher = recordOf({ ...BASE, decisionRef: "decision-risk-2" }).record;
    const before = JSON.stringify([lower, higher]);
    expect(selectCurrentPolicyRiskRecord([lower, higher])).toEqual({ ok: true, record: higher });
    expect(selectCurrentPolicyRiskRecord([higher, lower])).toEqual({ ok: true, record: higher });
    expect(JSON.stringify([lower, higher])).toBe(before);
  });

  it("refuses equal-revision records as a conflict rather than last-wins", () => {
    const first = recordOf().record;
    const second = recordOf({ ...BASE, decisionRef: "decision-risk-2" }).record;
    expect(selectCurrentPolicyRiskRecord([first, second])).toEqual({
      code: "POLICY_RISK_RECORD_CONFLICT",
      layer: "DAEMON_POLICY_RISK",
      ok: false,
    });
  });

  it("derives one domain-separated aggregate per project, action and subject", () => {
    const first = policyRiskAggregateIdFor(BASE);
    expect(first).toMatch(/^policy-risk:sha256:[0-9a-f]{64}$/u);
    expect(policyRiskAggregateIdFor(BASE)).toBe(first);
    expect(policyRiskAggregateIdFor({ ...BASE, actionKind: "graph.approve" })).not.toBe(first);
  });
});
