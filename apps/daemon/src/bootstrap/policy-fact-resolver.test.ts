import { describe, expect, it } from "vitest";

import { resolvePolicyFact, resolvePolicyWaivers } from "./policy-fact-resolver.js";

describe("resolvePolicyFact", () => {
  it("returns the exact auditable unknown-risk fact", () => {
    expect(resolvePolicyFact("project-1", "principal-1", "effect.activate")).toEqual({
      factId: "policy-risk-unclassifiable:sha256:d1b00b797dc06790e122914a3255ba4130e9588d01146ab81311b2fa0c54fa42",
      tier: null,
      truthClass: "UNKNOWN",
    });
  });

  it("accepts project, authenticated principal, and caller-requested action", () => {
    expect(resolvePolicyFact).toHaveLength(3);
  });

  it("keeps hostile caller-requested actions non-authoritative", () => {
    const actions = ["effect.activate", "operator.override", "../policy/admin"];
    const facts = actions.map((action) => resolvePolicyFact("project-1", "principal-1", action));

    expect(actions.length).toBeGreaterThan(0);
    expect(facts).toHaveLength(actions.length);
    expect(new Set(facts.map((fact) => fact.factId)).size).toBe(actions.length);
    for (const fact of facts) {
      expect(Object.isFrozen(fact)).toBe(true);
      expect(fact.tier).toBeNull();
      expect(fact.truthClass).toBe("UNKNOWN");
      expect(Object.keys(fact)).toEqual(["factId", "tier", "truthClass"]);
    }
  });
});

describe("resolvePolicyWaivers", () => {
  it("returns a consulted resolved-empty source distinct from absence", () => {
    const resolved = resolvePolicyWaivers();

    expect(resolved).toEqual({ status: "RESOLVED_EMPTY", waivers: [] });
    expect(resolved).not.toBeUndefined();
  });

  it("has no caller input or branch that can produce a waiver", () => {
    expect(resolvePolicyWaivers).toHaveLength(0);
    expect(resolvePolicyWaivers().waivers).toHaveLength(0);
  });
});
