import { describe, expect, it } from "vitest";

import {
  POLICY_SLICE_DIGEST_VERSION,
  derivePolicySliceDigest,
} from "./policy-slice-digest.js";

const baseSlice = () => ({
  autoApprovalOptIns: [{ action: "effect.activate", tier: "R0" }],
  rules: [],
  sliceRef: "a".repeat(64),
});

const digestOf = (value: unknown): string => {
  const result = derivePolicySliceDigest(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.digest;
};

describe("policy slice content digest", () => {
  it("pins the version and canonical known-answer vector", () => {
    expect(POLICY_SLICE_DIGEST_VERSION).toBe("moe.policy.slice.content.v1");
    expect(digestOf(baseSlice()))
      .toBe("282d52fcbad428b6e2977068b2091a2bceb5b13520bc98ce11d3647674bdd662");
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
