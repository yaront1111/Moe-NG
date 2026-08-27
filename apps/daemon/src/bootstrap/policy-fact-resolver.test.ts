import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "./bootstrap-test-fixtures.js";
import { resolvePolicyFact, resolvePolicyWaivers } from "./policy-fact-resolver.js";

const HOSTILE_ACTIONS = Object.freeze([
  "effect.activate", "operator.override", "../policy/admin",
] as const);

describe("resolvePolicyFact", () => {
  afterEach(closeStores);

  it("returns the exact auditable unknown-risk fact", () => {
    const store = openStore();
    expect(resolvePolicyFact(store, "project-1", "principal-1", "effect.activate")).toEqual({
      factId: "policy-risk-unclassifiable:sha256:d1b00b797dc06790e122914a3255ba4130e9588d01146ab81311b2fa0c54fa42",
      tier: null,
      truthClass: "UNKNOWN",
    });
  });

  it("accepts the store, project, authenticated principal, and evaluated action", () => {
    expect(resolvePolicyFact).toHaveLength(4);
  });

  it("keeps hostile caller-requested actions non-authoritative", () => {
    const store = openStore();
    const facts = HOSTILE_ACTIONS.map((action) =>
      resolvePolicyFact(store, "project-1", "principal-1", action));

    expect(HOSTILE_ACTIONS).toHaveLength(3);
    expect(new Set(HOSTILE_ACTIONS).size).toBe(3);
    expect(facts).toHaveLength(HOSTILE_ACTIONS.length);
    expect(new Set(facts.map((fact) => fact.factId)).size).toBe(HOSTILE_ACTIONS.length);
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
