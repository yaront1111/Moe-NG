/**
 * Hostile proof for @moe/core's public policy-slice content digest boundary.
 *
 * The function derives an identity; it does not accept a caller-carried digest. Its AFTER
 * arm therefore mutates a previously accepted source and proves the changed source must be
 * revalidated, rather than inventing a "re-sealed forgery" that this API cannot receive.
 */

import {
  POLICY_SLICE_DIGEST_LAYERS,
  derivePolicySliceDigest,
} from "../../packages/core/src/index.js";
import type { PolicySliceDigestResult } from "../../packages/core/src/index.js";

import { probeRacing } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";

const BOUNDARY = "POLICY_SLICE_DIGEST_LAYERS";
const RACE_BOUND = Object.freeze({ label: "policy-slice-digest-race", timeoutMs: 2_000 });

function policyLayer(): string {
  const found = POLICY_SLICE_DIGEST_LAYERS.find((layer) => layer === "POLICY_SLICE_CODEC");
  if (found === undefined) {
    throw new Error("POLICY_SLICE_CODEC is not declared by POLICY_SLICE_DIGEST_LAYERS");
  }
  return found;
}

const INVALID = Object.freeze({
  code: "POLICY_SLICE_INVALID",
  layer: policyLayer(),
});

interface MutableRule {
  effect: string;
  obligations: Array<{ kind: string; obligationId: string }>;
  requiredFactIds: string[];
  ruleId: string;
}

interface MutablePolicySlice {
  autoApprovalOptIns: Array<{ action: string; tier: string }>;
  rules: MutableRule[];
  sliceRef: string;
}

function policySlice(tag: string): MutablePolicySlice {
  return {
    autoApprovalOptIns: [{ action: "work.execute", tier: "R1" }],
    rules: [{
      effect: "REQUIRE_HUMAN_APPROVAL",
      obligations: [{ kind: "HARD", obligationId: `obligation-${tag}` }],
      requiredFactIds: [`fact-${tag}`],
      ruleId: `rule-${tag}`,
    }],
    sliceRef: `policy-slice-${tag}`,
  };
}

/** A real accepted call prevents an implementation that refuses every input from passing. */
export function policySliceDigestPositiveControl(): PolicySliceDigestResult {
  return derivePolicySliceDigest(policySlice("positive-control"));
}

export const POLICY_SLICE_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    constant: BOUNDARY,
    expect: INVALID,
    name: "an accessor-backed slice is refused before canonical content is read",
    async run(): Promise<unknown> {
      const hostile = policySlice("before");
      Object.defineProperty(hostile, "rules", {
        enumerable: true,
        get: () => [],
      });
      return derivePolicySliceDigest(hostile);
    },
  },
  {
    arm: "AFTER",
    constant: BOUNDARY,
    expect: INVALID,
    name: "a source mutated after one accepted derivation must be revalidated",
    async run(): Promise<unknown> {
      const mutable = policySlice("after");
      const accepted = derivePolicySliceDigest(mutable);
      if (!accepted.ok) {
        throw new Error(`positive precondition refused: ${accepted.code}@${accepted.layer}`);
      }
      mutable.rules[0]!.effect = "ALLOW_WITHOUT_AUTHORITY";
      return derivePolicySliceDigest(mutable);
    },
  },
  {
    arm: "RACE",
    constant: BOUNDARY,
    expectLeft: INVALID,
    expectRight: INVALID,
    name: "two shared aliases become invalid before concurrent derivations",
    run: () => {
      const shared = policySlice("race");
      return probeRacing(
        RACE_BOUND,
        async () => {
          shared.rules[0]!.effect = "ALLOW_WITHOUT_AUTHORITY";
          await Promise.resolve();
          return derivePolicySliceDigest(shared);
        },
        async () => {
          shared.autoApprovalOptIns[0]!.tier = "R3";
          await Promise.resolve();
          return derivePolicySliceDigest(shared);
        },
      );
    },
  },
]);
