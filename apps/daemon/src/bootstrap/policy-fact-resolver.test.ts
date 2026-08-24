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

  it("accepts only the three server-selected identity inputs", () => {
    expect(resolvePolicyFact).toHaveLength(3);
  });

  it("keys the fact identity by project, authenticated actor, and action", () => {
    const identities = [
      resolvePolicyFact("project-1", "principal-1", "effect.activate").factId,
      resolvePolicyFact("project-2", "principal-1", "effect.activate").factId,
      resolvePolicyFact("project-1", "principal-2", "effect.activate").factId,
      resolvePolicyFact("project-1", "principal-1", "effect.review").factId,
    ];

    expect(identities).toHaveLength(4);
    expect(new Set(identities).size).toBe(4);
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
