import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "./policy-evaluation.js";
import {
  POLICY_SLICE_DIGEST_VERSION,
  derivePolicySliceDigest,
} from "./policy-slice-digest.js";

const baseSlice = () => ({
  autoApprovalOptIns: [{ action: "effect.activate", tier: "R0" }],
  rules: [],
  sliceRef: "a".repeat(64),
});

/** The v1 identity of the legacy three-key slice. Absent and empty tables must both keep it. */
const LEGACY_KAT = "282d52fcbad428b6e2977068b2091a2bceb5b13520bc98ce11d3647674bdd662";
const FACT_ID = "node.capability:deploy";

const digestOf = (value: unknown): string => {
  const result = derivePolicySliceDigest(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.digest;
};

describe("policy slice content digest", () => {
  it("pins the version and canonical known-answer vector", () => {
    expect(POLICY_SLICE_DIGEST_VERSION).toBe("moe.policy.slice.content.v1");
    expect(digestOf(baseSlice())).toBe(LEGACY_KAT);
  });

  it("is canonical across object construction order", () => {
    const base = baseSlice();
    expect(digestOf({
      sliceRef: base.sliceRef,
      rules: base.rules,
      autoApprovalOptIns: base.autoApprovalOptIns,
    })).toBe(digestOf(base));
  });

  it("excludes the self-referential ref but binds every content family", () => {
    const base = baseSlice();
    expect(digestOf({ ...base, sliceRef: "b".repeat(64) })).toBe(digestOf(base));
    expect(digestOf({ ...base, autoApprovalOptIns: [] })).not.toBe(digestOf(base));
    expect(digestOf({
      ...base,
      rules: [{ effect: "DENY", obligations: [], requiredFactIds: [], ruleId: "deny" }],
    })).not.toBe(digestOf(base));
    expect(digestOf({ ...base, riskClassifications: [{ factId: FACT_ID, tier: "R1" }] }))
      .not.toBe(digestOf(base));
  });

  it("refuses malformed and accessor-backed slices with one stable code and layer", () => {
    const accessor = Object.defineProperty({}, "sliceRef", {
      enumerable: true,
      get(): never { throw new Error("hostile getter"); },
    });
    for (const value of [
      null,
      [],
      { ...baseSlice(), extra: true },
      { ...baseSlice(), autoApprovalOptIns: [{ action: "effect.activate", tier: "R3" }] },
      accessor,
    ]) {
      expect(derivePolicySliceDigest(value)).toStrictEqual({
        code: "POLICY_SLICE_INVALID",
        layer: "POLICY_SLICE_CODEC",
        ok: false,
      });
    }
  });

  it("returns frozen authority", () => {
    const result = derivePolicySliceDigest(baseSlice());
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

/**
 * A slice shape is EXACTLY three keys or EXACTLY four. A fifth key, an explicitly
 * `undefined` table and a non-list table are all refusals rather than defaults, because
 * "the risk table could not be read" has no fail-closed reading other than refusal.
 *
 * The two bound cases diverge deliberately: 513 ASCII characters exceed a code-unit bound
 * AND a byte bound, while 257 U+00E9 characters are only 257 code units and 514 UTF-8
 * BYTES, so a bound measured in `.length` would admit the second one.
 */
const MALFORMED_TABLES: readonly (readonly [string, unknown])[] = [
  ["extra entry key", [{ factId: FACT_ID, note: "x", tier: "R1" }]],
  ["missing entry tier", [{ factId: FACT_ID }]],
  ["duplicate factId", [{ factId: FACT_ID, tier: "R1" }, { factId: FACT_ID, tier: "R2" }]],
  ["empty factId", [{ factId: "", tier: "R1" }]],
  ["factId over the code-unit bound", [{ factId: "n".repeat(513), tier: "R1" }]],
  ["factId over the UTF-8 byte bound", [{ factId: "\u00e9".repeat(257), tier: "R1" }]],
  ["non-NFC factId", [{ factId: "e\u0301", tier: "R1" }]],
  ["NUL in factId", [{ factId: `${FACT_ID}\u0000`, tier: "R1" }]],
  ["over 512 entries", Array.from(
    { length: 513 },
    (_unused, index) => ({ factId: `node.resource:r${index}`, tier: "R0" }),
  )],
  ["invalid tier", [{ factId: FACT_ID, tier: "R4" }]],
  ["null tier", [{ factId: FACT_ID, tier: null }]],
  ["explicitly undefined table", undefined],
  ["table is a record, not a list", { [FACT_ID]: "R1" }],
];

describe("policy slice risk classifications", () => {
  it("refuses every malformed classification table with one stable code and layer", () => {
    expect(MALFORMED_TABLES.length).toBe(13);
    for (const [label, riskClassifications] of MALFORMED_TABLES) {
      expect([label, derivePolicySliceDigest({ ...baseSlice(), riskClassifications })])
        .toStrictEqual([
          label,
          { code: "POLICY_SLICE_INVALID", layer: "POLICY_SLICE_CODEC", ok: false },
        ]);
    }
  });

  it("admits the exact three-key and four-key slice shapes", () => {
    expect(digestOf(baseSlice())).toBe(LEGACY_KAT);
    expect(digestOf({ ...baseSlice(), riskClassifications: [] })).toBe(LEGACY_KAT);
    expect(digestOf({ ...baseSlice(), riskClassifications: [{ factId: FACT_ID, tier: "R1" }] }))
      .toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds a nonempty table into the v1 identity, canonically and tier-sensitively", () => {
    const base = baseSlice();
    const one = digestOf({ ...base, riskClassifications: [{ factId: FACT_ID, tier: "R1" }] });
    expect(one).not.toBe(LEGACY_KAT);
    expect(digestOf({ ...base, riskClassifications: [{ factId: FACT_ID, tier: "R2" }] }))
      .not.toBe(one);
    const table = [
      { factId: "node.capability:a", tier: "R1" },
      { factId: "node.resource:b", tier: "R2" },
    ];
    expect(digestOf({ ...base, riskClassifications: [...table].reverse() }))
      .toBe(digestOf({ ...base, riskClassifications: table }));
  });
});

const hex = (char: string): string => char.repeat(64);

const slice = (
  sliceRef: string,
  riskClassifications: readonly { readonly factId: string; readonly tier: string }[],
  autoApprovalOptIns: readonly { readonly action: string; readonly tier: string }[] = [],
) => ({ autoApprovalOptIns, riskClassifications, rules: [], sliceRef });

const evaluationInput = (sliceChain: readonly unknown[], facts: readonly unknown[]) => ({
  action: "effect.activate",
  actor: "agent-a",
  callerRiskHint: null,
  decisionDigest: hex("1"),
  evaluatedAtEpochMs: 1_000,
  evaluatorVersion: "policy-v1",
  facts,
  graphNodeRevisionRefs: ["rev-a"],
  policyRevisionRef: hex("2"),
  requiredFactIds: [],
  scope: ["scope-a"],
  sliceChain,
  waivers: [],
});

const recordOf = (value: unknown) => {
  const result = evaluatePolicy(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.record;
};

const strongFact = (tier: string | null) =>
  ({ factId: FACT_ID, tier, truthClass: "DAEMON_VERIFIED" });

describe("policy-declared risk classification through the evaluator", () => {
  it("grounds the tier of a strong null-tier fact the slice classifies", () => {
    const record = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R2" }])],
      [strongFact(null)],
    ));
    expect(record.riskAssessment.computedTier).toBe("R2");
    expect(record.riskAssessment.effectiveTier).toBe("R2");
    expect(record.riskAssessment.usedFactIds).toStrictEqual([FACT_ID]);
    expect(record.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(record.reasonCodes).toStrictEqual(["HUMAN_ONLY_TIER"]);
  });

  it("stays unclassifiable when policy classifies no fact the input carries", () => {
    const record = recordOf(evaluationInput([slice("root", [])], [strongFact(null)]));
    expect(record.riskAssessment.computedTier).toBeNull();
    expect(record.riskAssessment.effectiveTier).toBeNull();
    expect(record.riskAssessment.usedFactIds).toStrictEqual([]);
    expect(record.decision).toBe("HOLD_UNKNOWN");
    expect(record.reasonCodes).toStrictEqual(["RISK_TIER_UNCLASSIFIABLE"]);
  });

  it("refuses to classify a fact that does not clear the strong-truth floor", () => {
    const record = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R3" }])],
      [{ factId: FACT_ID, tier: null, truthClass: "AGENT_REPORTED" }],
    ));
    expect(record.riskAssessment.computedTier).toBeNull();
    expect(record.decision).toBe("HOLD_UNKNOWN");
    expect(record.reasonCodes).toStrictEqual(["RISK_TIER_UNCLASSIFIABLE"]);
  });

  it("cannot lower a fact that already bears a stronger tier", () => {
    const record = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R0" }])],
      [strongFact("R3")],
    ));
    expect(record.riskAssessment.computedTier).toBe("R3");
  });

  it("folds a chain add-only, raise-only, and omission-preserving", () => {
    const added = recordOf(evaluationInput(
      [slice("root", []), slice("child", [{ factId: FACT_ID, tier: "R1" }])],
      [strongFact(null)],
    ));
    expect(added.riskAssessment.computedTier).toBe("R1");
    const raised = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R1" }]),
        slice("child", [{ factId: FACT_ID, tier: "R3" }])],
      [strongFact(null)],
    ));
    expect(raised.riskAssessment.computedTier).toBe("R3");
    const omitted = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R2" }]), slice("child", [])],
      [strongFact(null)],
    ));
    expect(omitted.riskAssessment.computedTier).toBe("R2");
    for (const record of [added, raised, omitted]) {
      expect(record.reasonCodes).not.toContain("SLICE_RELAXATION_DETECTED");
    }
  });

  /**
   * DIVERGENCE FIXTURE for the lowering rule. Every other mechanism that can set
   * `fold.relaxed` is neutralized so the classification comparison is the ONLY one left:
   * `rules` is empty in both slices, so `ruleRelaxation` is never called; `requiredFactIds`
   * is empty and the single fact is strong and present, so the evidence layer cannot refuse;
   * `waivers` is empty, so `waiverInvalid` cannot fire; and both slices declare the IDENTICAL
   * opt-in, so `optInCovered` sees a covered redeclaration rather than a new one.
   *
   * The opt-in is `R1` for the action under evaluation, so `assessTier` returns ALLOW without
   * a code and the expected reason roster is a SINGLE entry. The control below changes exactly
   * one degree - the child's tier stops being lower - and the same fixture reaches ALLOW.
   */
  it("denies when a child lowers a classification and nothing else can relax", () => {
    const optIns = [{ action: "effect.activate", tier: "R1" }];
    const lowered = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R1" }], optIns),
        slice("child", [{ factId: FACT_ID, tier: "R0" }], optIns)],
      [strongFact(null)],
    ));
    expect(lowered.decision).toBe("DENY");
    expect(lowered.reasonCodes).toStrictEqual(["SLICE_RELAXATION_DETECTED"]);
    // The lowering is REFUSED, not merely reported: the ancestor's tier is what survives.
    expect(lowered.riskAssessment.computedTier).toBe("R1");

    const control = recordOf(evaluationInput(
      [slice("root", [{ factId: FACT_ID, tier: "R1" }], optIns),
        slice("child", [{ factId: FACT_ID, tier: "R1" }], optIns)],
      [strongFact(null)],
    ));
    expect(control.decision).toBe("ALLOW");
    expect(control.reasonCodes).toStrictEqual(["ALLOWED_BY_POLICY"]);
  });
});
