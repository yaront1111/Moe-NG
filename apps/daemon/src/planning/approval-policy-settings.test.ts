import { describe, expect, it } from "vitest";

import { APPROVAL_POLICY_KINDS } from "@moe/core";

import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_APPROVAL_MODE,
  SPEED_MODE_DELAY_ENV_KEY,
  decodeApprovalPolicy,
  readApprovalPolicySettings,
} from "./approval-policy-settings.js";

/**
 * The settings-to-policy decode, swept in the direction that matters: EVERYTHING that is
 * not an explicitly stated SPEED delay must come back `REQUIRE_HUMAN`.
 *
 * The refusal cases are asserted as a PROPERTY over the whole generated set rather than as
 * a hand-picked list, because a list can be extended with a permissive case and stay green.
 * The accepted cases sit in the same suite so the refusals are demonstrably a decision: a
 * decoder that answered `REQUIRE_HUMAN` unconditionally would fail them.
 */

interface RefusedCase {
  readonly settings: unknown;
  readonly why: string;
}

interface AcceptedCase {
  readonly delayMs: number;
  readonly settings: unknown;
  readonly why: string;
}

const REFUSED_SETTINGS: readonly RefusedCase[] = Object.freeze([
  { settings: undefined, why: "settings absent" },
  { settings: null, why: "settings null" },
  { settings: {}, why: "approval mode absent" },
  { settings: { speedModeDelayMs: 0 }, why: "delay stated, mode absent" },
  { settings: { approvalMode: "QUALITY", speedModeDelayMs: 0 }, why: "unrecognised mode" },
  { settings: { approvalMode: "speed", speedModeDelayMs: 0 }, why: "mode case mismatch" },
  { settings: { approvalMode: 42, speedModeDelayMs: 0 }, why: "mode not a string" },
  { settings: { approvalMode: "SPEED" }, why: "SPEED with the delay ABSENT" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: undefined }, why: "delay undefined" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: null }, why: "delay null" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: 1.5 }, why: "delay non-integer" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: -1 }, why: "delay negative" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: Number.NaN }, why: "delay NaN" },
  {
    settings: { approvalMode: "SPEED", speedModeDelayMs: Number.POSITIVE_INFINITY },
    why: "delay Infinity",
  },
  {
    settings: { approvalMode: "SPEED", speedModeDelayMs: Number.MAX_SAFE_INTEGER + 1 },
    why: "delay beyond the safe integer range",
  },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: "2000" }, why: "delay numeric string" },
  { settings: { approvalMode: "SPEED", speedModeDelayMs: true }, why: "delay not a number" },
  { settings: [], why: "settings an array" },
  { settings: SPEED_APPROVAL_MODE, why: "settings a bare mode string" },
]);

const ACCEPTED_SETTINGS: readonly AcceptedCase[] = Object.freeze([
  { delayMs: 0, settings: { approvalMode: "SPEED", speedModeDelayMs: 0 }, why: "stated zero" },
  {
    delayMs: 2000,
    settings: { approvalMode: "SPEED", speedModeDelayMs: 2000 },
    why: "the incident's 2s delay, this time stated",
  },
  {
    delayMs: Number.MAX_SAFE_INTEGER,
    settings: { approvalMode: "SPEED", speedModeDelayMs: Number.MAX_SAFE_INTEGER },
    why: "the widest delay the contract admits",
  },
]);

const REFUSED_ENV: readonly RefusedCase[] = Object.freeze([
  { settings: {}, why: "no approval settings in the environment" },
  { settings: { [APPROVAL_MODE_ENV_KEY]: "" }, why: "mode empty" },
  { settings: { [APPROVAL_MODE_ENV_KEY]: "QUALITY" }, why: "unrecognised mode" },
  { settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE }, why: "SPEED, delay absent" },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "" },
    why: "delay empty",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "2s" },
    why: "delay not a number",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "-1" },
    why: "delay negative",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "1.5" },
    why: "delay non-integer",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: " 0 " },
    why: "delay padded with whitespace",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "1e3" },
    why: "delay in exponent notation",
  },
  {
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "0x10" },
    why: "delay in hexadecimal",
  },
  {
    settings: {
      [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE,
      [SPEED_MODE_DELAY_ENV_KEY]: "9007199254740992",
    },
    why: "delay beyond the safe integer range",
  },
]);

const ACCEPTED_ENV: readonly AcceptedCase[] = Object.freeze([
  {
    delayMs: 0,
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "0" },
    why: "stated zero",
  },
  {
    delayMs: 2000,
    settings: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "2000" },
    why: "the incident's 2s delay, this time stated",
  },
]);

const envOf = (settings: unknown): Readonly<Record<string, string | undefined>> =>
  settings as Readonly<Record<string, string | undefined>>;

/** Reads the field the decoder is judged against, without reimplementing the judgement. */
function statedDelay(settings: unknown): unknown {
  if (settings === null || typeof settings !== "object") return undefined;
  return (settings as { readonly speedModeDelayMs?: unknown }).speedModeDelayMs;
}

describe("approval policy settings decode", () => {
  it("names the transitional settings it reads", () => {
    expect(APPROVAL_MODE_ENV_KEY).toBe("MOE_APPROVAL_MODE");
    expect(SPEED_MODE_DELAY_ENV_KEY).toBe("MOE_SPEED_MODE_DELAY_MS");
    expect(SPEED_APPROVAL_MODE).toBe("SPEED");
  });

  it("refuses every settings value that does not state a SPEED delay", () => {
    // A sweep that silently generates zero cases passes while testing nothing.
    expect(REFUSED_SETTINGS.length).toBe(19);

    for (const { settings, why } of REFUSED_SETTINGS) {
      expect(decodeApprovalPolicy(settings), why).toEqual({ kind: "REQUIRE_HUMAN" });
    }
  });

  it("carries the stated delay through rather than a delay of its own", () => {
    expect(ACCEPTED_SETTINGS.length).toBe(3);

    for (const { delayMs, settings, why } of ACCEPTED_SETTINGS) {
      expect(decodeApprovalPolicy(settings), why)
        .toEqual({ delayMs, kind: "PROCEED_WITHOUT_HUMAN" });
    }
  });

  it("never proceeds without a human unless the delay was explicitly stated", () => {
    const swept = [...REFUSED_SETTINGS, ...ACCEPTED_SETTINGS];
    expect(swept.length).toBe(22);
    const kinds = new Set<string>();

    for (const { settings, why } of swept) {
      const policy = decodeApprovalPolicy(settings);
      expect(APPROVAL_POLICY_KINDS, why).toContain(policy.kind);
      kinds.add(policy.kind);
      if (policy.kind !== "PROCEED_WITHOUT_HUMAN") continue;
      // The permissive arm is reachable ONLY from a delay the settings themselves named.
      expect(typeof statedDelay(settings), why).toBe("number");
      expect(policy.delayMs, why).toBe(statedDelay(settings));
    }

    // Both members are reachable from settings, so neither branch is dead.
    expect([...kinds].sort()).toEqual([...APPROVAL_POLICY_KINDS].sort());
  });
});

describe("approval policy settings from the environment", () => {
  it("refuses every environment that does not state a SPEED delay", () => {
    expect(REFUSED_ENV.length).toBe(12);

    for (const { settings, why } of REFUSED_ENV) {
      expect(readApprovalPolicySettings(envOf(settings)), why)
        .toEqual({ kind: "REQUIRE_HUMAN" });
    }
  });

  it("decodes a stated SPEED delay from the environment", () => {
    expect(ACCEPTED_ENV.length).toBe(2);

    for (const { delayMs, settings, why } of ACCEPTED_ENV) {
      expect(readApprovalPolicySettings(envOf(settings)), why)
        .toEqual({ delayMs, kind: "PROCEED_WITHOUT_HUMAN" });
    }
  });

  it("never proceeds without a human from an environment value alone", () => {
    const swept = [...REFUSED_ENV, ...ACCEPTED_ENV];
    expect(swept.length).toBe(14);
    const kinds = new Set<string>();

    for (const { settings, why } of swept) {
      const policy = readApprovalPolicySettings(envOf(settings));
      expect(APPROVAL_POLICY_KINDS, why).toContain(policy.kind);
      kinds.add(policy.kind);
      if (policy.kind !== "PROCEED_WITHOUT_HUMAN") continue;
      const raw = envOf(settings)[SPEED_MODE_DELAY_ENV_KEY];
      expect(raw, why).toMatch(/^\d+$/u);
      expect(policy.delayMs, why).toBe(Number(raw));
    }

    expect([...kinds].sort()).toEqual([...APPROVAL_POLICY_KINDS].sort());
  });
});
