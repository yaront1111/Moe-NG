import { describe, expect, it } from "vitest";

import {
  AI_GOVERNOR_MODE,
  GOVERNANCE_MAX_DECISIONS_ENV_KEY,
  GOVERNANCE_MODE_ENV_KEY,
  GOVERNANCE_POLICY_KINDS,
  GOVERNANCE_PRINCIPAL_ID,
  decodeGovernancePolicy,
  governanceOpen,
  readGovernancePolicySettings,
} from "./governance-policy-settings.js";

/**
 * The settings-to-policy decode, swept in the direction that matters: EVERYTHING that is not an
 * explicitly stated AI_GOVERNOR decision bound must come back `REQUIRE_HUMAN`.
 *
 * The refusal cases are asserted as a PROPERTY over the whole generated set rather than as a
 * hand-picked list, because a list can be extended with a permissive case and stay green. The
 * accepted cases sit in the same suite so the refusals are demonstrably a decision: a decoder
 * that answered `REQUIRE_HUMAN` unconditionally would fail them.
 *
 * Shaped after `approval-policy-settings.test.ts` deliberately — the two settings answer the
 * same class of question ("may this proceed without a human?") and a reader who knows one
 * should not have to learn a second shape to audit the other.
 */

interface RefusedCase {
  readonly settings: unknown;
  readonly why: string;
}

interface AcceptedCase {
  readonly maxDecisions: number;
  readonly settings: unknown;
  readonly why: string;
}

const REFUSED_SETTINGS: readonly RefusedCase[] = Object.freeze([
  { settings: undefined, why: "settings absent" },
  { settings: null, why: "settings null" },
  { settings: {}, why: "governance mode absent" },
  { settings: { governanceMaxDecisions: 0 }, why: "bound stated, mode absent" },
  {
    settings: { governanceMaxDecisions: 0, governanceMode: "REQUIRE_HUMAN" },
    why: "unrecognised mode",
  },
  {
    settings: { governanceMaxDecisions: 0, governanceMode: "ai_governor" },
    why: "mode case mismatch",
  },
  { settings: { governanceMaxDecisions: 0, governanceMode: 42 }, why: "mode not a string" },
  { settings: { governanceMode: "AI_GOVERNOR" }, why: "AI_GOVERNOR with the bound ABSENT" },
  {
    settings: { governanceMaxDecisions: undefined, governanceMode: "AI_GOVERNOR" },
    why: "bound undefined",
  },
  {
    settings: { governanceMaxDecisions: null, governanceMode: "AI_GOVERNOR" },
    why: "bound null",
  },
  {
    settings: { governanceMaxDecisions: 1.5, governanceMode: "AI_GOVERNOR" },
    why: "bound non-integer",
  },
  {
    settings: { governanceMaxDecisions: -1, governanceMode: "AI_GOVERNOR" },
    why: "bound negative",
  },
  {
    settings: { governanceMaxDecisions: Number.NaN, governanceMode: "AI_GOVERNOR" },
    why: "bound NaN",
  },
  {
    settings: { governanceMaxDecisions: Number.POSITIVE_INFINITY, governanceMode: "AI_GOVERNOR" },
    why: "bound Infinity",
  },
  {
    settings: {
      governanceMaxDecisions: Number.MAX_SAFE_INTEGER + 1, governanceMode: "AI_GOVERNOR",
    },
    why: "bound beyond the safe integer range",
  },
  {
    settings: { governanceMaxDecisions: "2", governanceMode: "AI_GOVERNOR" },
    why: "bound numeric string",
  },
  {
    settings: { governanceMaxDecisions: true, governanceMode: "AI_GOVERNOR" },
    why: "bound not a number",
  },
  { settings: [], why: "settings an array" },
  { settings: AI_GOVERNOR_MODE, why: "settings a bare mode string" },
]);

const ACCEPTED_SETTINGS: readonly AcceptedCase[] = Object.freeze([
  {
    maxDecisions: 0,
    settings: { governanceMaxDecisions: 0, governanceMode: "AI_GOVERNOR" },
    why: "stated zero: governance may only ever replan, never fund another attempt",
  },
  {
    maxDecisions: 1,
    settings: { governanceMaxDecisions: 1, governanceMode: "AI_GOVERNOR" },
    why: "one governance answer per node, then the replan",
  },
  {
    maxDecisions: Number.MAX_SAFE_INTEGER,
    settings: { governanceMaxDecisions: Number.MAX_SAFE_INTEGER, governanceMode: "AI_GOVERNOR" },
    why: "the widest bound the contract admits, still stated",
  },
]);

const REFUSED_ENV: readonly RefusedCase[] = Object.freeze([
  { settings: {}, why: "no governance settings in the environment" },
  { settings: { [GOVERNANCE_MODE_ENV_KEY]: "" }, why: "mode empty" },
  { settings: { [GOVERNANCE_MODE_ENV_KEY]: "REQUIRE_HUMAN" }, why: "unrecognised mode" },
  { settings: { [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE }, why: "AI_GOVERNOR, bound absent" },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound empty",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "2x", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound not a number",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "-1", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound negative",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "1.5", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound non-integer",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: " 1 ", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound padded with whitespace",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "1e3", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound in exponent notation",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "0x10", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound in hexadecimal",
  },
  {
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "9007199254740992",
      [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "bound beyond the safe integer range",
  },
]);

const ACCEPTED_ENV: readonly AcceptedCase[] = Object.freeze([
  {
    maxDecisions: 0,
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "0", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "stated zero",
  },
  {
    maxDecisions: 1,
    settings: {
      [GOVERNANCE_MAX_DECISIONS_ENV_KEY]: "1", [GOVERNANCE_MODE_ENV_KEY]: AI_GOVERNOR_MODE,
    },
    why: "one governance answer per node",
  },
]);

const envOf = (settings: unknown): Readonly<Record<string, string | undefined>> =>
  settings as Readonly<Record<string, string | undefined>>;

/** Reads the field the decoder is judged against, without reimplementing the judgement. */
function statedBound(settings: unknown): unknown {
  if (settings === null || typeof settings !== "object") return undefined;
  return (settings as { readonly governanceMaxDecisions?: unknown }).governanceMaxDecisions;
}

describe("governance policy settings decode", () => {
  it("names the settings it reads and the seat it decides from", () => {
    expect(GOVERNANCE_MODE_ENV_KEY).toBe("MOE_GOVERNANCE_MODE");
    expect(GOVERNANCE_MAX_DECISIONS_ENV_KEY).toBe("MOE_GOVERNANCE_MAX_DECISIONS");
    expect(AI_GOVERNOR_MODE).toBe("AI_GOVERNOR");
    // The reserved seat, in the same shape as the daemon's other two service identities.
    expect(GOVERNANCE_PRINCIPAL_ID).toBe("daemon:governor");
    expect(GOVERNANCE_PRINCIPAL_ID.startsWith("daemon:")).toBe(true);
  });

  it("refuses every settings value that does not state a governance bound", () => {
    // A sweep that silently generates zero cases passes while testing nothing.
    expect(REFUSED_SETTINGS.length).toBe(19);

    for (const { settings, why } of REFUSED_SETTINGS) {
      expect(decodeGovernancePolicy(settings), why).toEqual({ kind: "REQUIRE_HUMAN" });
    }
  });

  it("carries the stated bound through rather than a bound of its own", () => {
    expect(ACCEPTED_SETTINGS.length).toBe(3);

    for (const { maxDecisions, settings, why } of ACCEPTED_SETTINGS) {
      expect(decodeGovernancePolicy(settings), why)
        .toEqual({ kind: AI_GOVERNOR_MODE, maxDecisions });
    }
  });

  it("never opens the governance seat unless the bound was explicitly stated", () => {
    const swept = [...REFUSED_SETTINGS, ...ACCEPTED_SETTINGS];
    expect(swept.length).toBe(22);
    const kinds = new Set<string>();

    for (const { settings, why } of swept) {
      const policy = decodeGovernancePolicy(settings);
      expect(GOVERNANCE_POLICY_KINDS, why).toContain(policy.kind);
      kinds.add(policy.kind);
      if (!governanceOpen(policy)) continue;
      // The permissive arm is reachable ONLY from a bound the settings themselves named.
      expect(typeof statedBound(settings), why).toBe("number");
      expect(policy.maxDecisions, why).toBe(statedBound(settings));
    }

    // Both members are reachable from settings, so neither branch is dead.
    expect([...kinds].sort()).toEqual([...GOVERNANCE_POLICY_KINDS].sort());
  });
});

describe("governance policy settings from the environment", () => {
  it("refuses every environment that does not state a governance bound", () => {
    expect(REFUSED_ENV.length).toBe(12);

    for (const { settings, why } of REFUSED_ENV) {
      expect(readGovernancePolicySettings(envOf(settings)), why)
        .toEqual({ kind: "REQUIRE_HUMAN" });
    }
  });

  it("decodes a stated governance bound from the environment", () => {
    expect(ACCEPTED_ENV.length).toBe(2);

    for (const { maxDecisions, settings, why } of ACCEPTED_ENV) {
      expect(readGovernancePolicySettings(envOf(settings)), why)
        .toEqual({ kind: AI_GOVERNOR_MODE, maxDecisions });
    }
  });

  it("never opens the governance seat from an environment value alone", () => {
    const swept = [...REFUSED_ENV, ...ACCEPTED_ENV];
    expect(swept.length).toBe(14);
    const kinds = new Set<string>();

    for (const { settings, why } of swept) {
      const policy = readGovernancePolicySettings(envOf(settings));
      expect(GOVERNANCE_POLICY_KINDS, why).toContain(policy.kind);
      kinds.add(policy.kind);
      if (!governanceOpen(policy)) continue;
      const raw = envOf(settings)[GOVERNANCE_MAX_DECISIONS_ENV_KEY];
      expect(raw, why).toMatch(/^\d+$/u);
      expect(policy.maxDecisions, why).toBe(Number(raw));
    }

    expect([...kinds].sort()).toEqual([...GOVERNANCE_POLICY_KINDS].sort());
  });
});

describe("an absent governance policy", () => {
  it("is a closed seat, so a composition that forgot to wire it cannot open one", () => {
    // The undefined case is answered by the predicate itself; every call site inherits it.
    expect(governanceOpen(undefined)).toBe(false);
    expect(governanceOpen({ kind: "REQUIRE_HUMAN" })).toBe(false);
    expect(governanceOpen({ kind: AI_GOVERNOR_MODE, maxDecisions: 0 })).toBe(true);
  });
});
