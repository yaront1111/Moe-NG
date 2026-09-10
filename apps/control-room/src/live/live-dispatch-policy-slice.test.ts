import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { POLICY_AUTO_APPROVAL_TIERS, derivePolicySliceDigest } from "@moe/core";
import type { PolicyAutoApprovalOptIn } from "@moe/core";
import { describe, expect, it } from "vitest";

import { DEV_PAYLOADS } from "./live-dispatch-payloads.js";

/**
 * THE ARM THAT DID NOT EXIST, and whose absence made the whole hazard invisible.
 *
 * `POLICY_REF` in live-dispatch-payloads.ts is a KNOWN-ANSWER DIGEST over the exact
 * `policy.install` slice beside it, and the daemon RECOMPUTES it at install:
 * `bootstrap-policy-authority-reader.ts` refuses when `selectedDigest.digest !== sliceRef`.
 * Until this file existed, `git grep -ln derivePolicySliceDigest -- apps/control-room/**`
 * returned NOTHING and the digest literal appeared at exactly one site, its own declaration -
 * so editing the slice and forgetting the ref shipped a GREEN control-room leg and a
 * runtime-refused install. The file header's claim that "parity tests pin this browser
 * constant to the core producer" was aspirational. It is true as of this file.
 *
 * The digest producer imports `node:crypto`, which is why the browser module pins a literal
 * and only this TEST calls the producer.
 */

function installedSlice(): Record<string, unknown> {
  const slice = (DEV_PAYLOADS["policy.install"] as Record<string, unknown>)["slice"];
  if (slice === null || typeof slice !== "object") {
    throw new Error("policy.install carries no slice");
  }
  return slice as Record<string, unknown>;
}

function installedOptIns(): readonly PolicyAutoApprovalOptIn[] {
  const optIns = installedSlice()["autoApprovalOptIns"];
  if (!Array.isArray(optIns)) throw new Error("the installed slice carries no opt-in list");
  return optIns as readonly PolicyAutoApprovalOptIn[];
}

describe("the browser's installed policy slice", () => {
  it("carries a sliceRef the core producer independently recomputes", () => {
    const slice = installedSlice();
    const derived = derivePolicySliceDigest(slice);
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(`the slice is not a valid PolicySlice: ${derived.code}`);
    expect(derived.digest).toBe(slice["sliceRef"]);
  });

  /**
   * `policy.validate` reuses the same constant as `policyRevisionRef`. They share an identifier
   * today, so this asserts the OBSERVABLE equality rather than trusting that they always will:
   * a mismatch there is quieter than the install refusal and no install arm would see it.
   */
  it("names the same revision at policy.validate as at policy.install", () => {
    const input = (DEV_PAYLOADS["policy.validate"] as Record<string, unknown>)["input"];
    expect((input as Record<string, unknown>)["policyRevisionRef"])
      .toBe(installedSlice()["sliceRef"]);
  });
});

describe("the host's standing auto-approval opt-ins", () => {
  it("is not the unconditional empty list it used to be", () => {
    expect(installedOptIns().length).toBeGreaterThan(0);
  });

  /**
   * BOTH DIRECTIONS. Every advertised gate action is opted in AND every opted-in action is one
   * of the two gate actions - a subset check in one direction alone would stay green while a
   * third, unrelated action was quietly opted into the automatic path.
   */
  it("opts in exactly the two gate actions, at a tier inside the auto-approvable ceiling", () => {
    const optIns = installedOptIns();
    expect(optIns.map((entry) => entry.action).sort())
      .toEqual(["preview.decide", "release.decide"]);
    for (const entry of optIns) {
      expect(POLICY_AUTO_APPROVAL_TIERS).toContain(entry.tier);
      expect(entry.tier).toBe("R1");
    }
  });

  /** The action strings are the shared runtime roster's, not this module's invention. */
  it("names only actions the shared command roster serves", () => {
    for (const entry of installedOptIns()) {
      expect(RUNTIME_COMMAND_KINDS).toContain(entry.action);
    }
  });

  /**
   * THE FENCE IS THE TYPE, NOT A RUNTIME BRANCH. `PolicyAutoApprovalTier` is `"R0" | "R1"`, so
   * an opt-in naming R2 or R3 does not COMPILE - which is why a RESTRICTED goal (mapped to R3)
   * can never be auto-approved by construction and this module writes no `if (tier === "R3")`.
   * A runtime guard would pass its own arm while hiding the fence, and would survive a future
   * widening of POLICY_AUTO_APPROVAL_TIERS that the type catches. `pnpm typecheck` FAILS if
   * either line below stops erroring.
   */
  it("cannot express an opt-in above the ceiling", () => {
    const humanOnly: PolicyAutoApprovalOptIn = {
      action: "preview.decide",
      // @ts-expect-error R3 is outside PolicyAutoApprovalTier; the compiler is the fence.
      tier: "R3",
    };
    const restricted: PolicyAutoApprovalOptIn = {
      action: "release.decide",
      // @ts-expect-error R2 is outside PolicyAutoApprovalTier; the compiler is the fence.
      tier: "R2",
    };
    expect([humanOnly.tier, restricted.tier]).toEqual(["R3", "R2"]);
    expect(POLICY_AUTO_APPROVAL_TIERS).not.toContain("R2");
    expect(POLICY_AUTO_APPROVAL_TIERS).not.toContain("R3");
  });
});
