/**
 * DoD 3. Satisfying the human-authority gate requires a NAMED HUMAN principal,
 * the satisfaction is recorded durably with that principal and the moment it was
 * given, and every refusal names an exact stable code AND the layer that
 * answered — asserted literally, never by matching an `Error` message.
 *
 * THE GRANT IS BOUND TO THE UNIT OF WORK. A grant minted for one work reference
 * cannot be transplanted onto another gate, and a hand-written grant is
 * re-validated rather than trusted. In the motivating incident a bulk status
 * change cleared every task's recorded `blockedReason`; a satisfaction that were
 * merely *present* rather than bound and re-checked would be forgeable the same
 * way, by an agent, with no human anywhere in the loop.
 */
import { expect, it } from "vitest";

import {
  APPROVAL_AUTHORITY_CODES,
  APPROVAL_AUTHORITY_LAYERS,
  checkHumanAuthority,
  grantHumanAuthority,
} from "./approval-authority.js";
import type {
  HumanAuthorityCheck, HumanAuthorityGate, HumanAuthorityGrantResult,
} from "./approval-authority.js";

const GATE_ID = "GO_ACTIVATE";
const WORK_REF = "task-09008b4c";
const MOMENT = 1_755_216_000_000;

/** Named for the incident: a GA activation gate whose GO_ACTIVATE was never issued. */
const gated = (): HumanAuthorityGate => ({ gateId: GATE_ID, grant: null, workRef: WORK_REF });
const HUMAN = { kind: "HUMAN", principalId: "human:yaron", profileRevisionId: "profile-1" };

/**
 * Every assertion below compares this string. It carries the stable code AND the
 * refusing layer together, so a test can never pass on "it did not succeed".
 */
const outcome = (result: HumanAuthorityCheck | HumanAuthorityGrantResult): string =>
  result.ok ? "SATISFIED" : `${result.code}@${result.layer}`;

it("names exactly the reviewed approval authority codes and layers", () => {
  expect([...APPROVAL_AUTHORITY_CODES]).toEqual([
    "APPROVAL_HUMAN_AUTHORITY_REQUIRED", "APPROVAL_AUTHORITY_BINDING_MISMATCH",
    "APPROVAL_PRINCIPAL_MISSING", "APPROVAL_PRINCIPAL_UNNAMED",
    "APPROVAL_PRINCIPAL_NOT_HUMAN", "APPROVAL_GRANT_MOMENT_INVALID",
    "APPROVAL_POLICY_DELAY_INVALID", "APPROVAL_HUMAN_REVIEW_REQUIRED",
  ]);
  expect([...APPROVAL_AUTHORITY_LAYERS]).toEqual(["HUMAN_AUTHORITY_GATE", "APPROVAL_POLICY"]);
  expect([Object.isFrozen(APPROVAL_AUTHORITY_CODES), Object.isFrozen(APPROVAL_AUTHORITY_LAYERS)])
    .toEqual([true, true]);
});

it("records the granting human principal and the moment it was given", () => {
  const result = grantHumanAuthority(gated(), HUMAN, MOMENT);
  expect(outcome(result)).toBe("SATISFIED");
  if (!result.ok) throw new Error("expected a grant");
  expect(result.gate.grant).toEqual({
    gateId: GATE_ID, grantedAtEpochMs: MOMENT, principalId: "human:yaron",
    principalKind: "HUMAN", workRef: WORK_REF,
  });
  expect([Object.isFrozen(result.gate), Object.isFrozen(result.gate.grant)]).toEqual([true, true]);
});

it("leaves the presented gate unmutated when it mints a grant", () => {
  const gate = gated();
  expect(outcome(grantHumanAuthority(gate, HUMAN, MOMENT))).toBe("SATISFIED");
  expect(gate.grant).toBeNull();
});

it("accepts the minted grant when it is checked back against its own gate", () => {
  const minted = grantHumanAuthority(gated(), HUMAN, MOMENT);
  if (!minted.ok) throw new Error("expected a grant");
  const check = checkHumanAuthority(minted.gate);
  expect(outcome(check)).toBe("SATISFIED");
  if (!check.ok) throw new Error("expected a satisfied gate");
  expect([check.grant.principalId, check.grant.grantedAtEpochMs])
    .toEqual(["human:yaron", MOMENT]);
});

/**
 * `unknown` on purpose: the daemon, the control room and the orchestrator will
 * each hand this a value off the wire, so the refusals have to be reachable from
 * inputs that no TypeScript annotation would admit.
 */
const PRINCIPAL_REFUSALS: readonly (readonly [string, unknown, string])[] = [
  ["absent", null, "APPROVAL_PRINCIPAL_MISSING@HUMAN_AUTHORITY_GATE"],
  ["undefined", undefined, "APPROVAL_PRINCIPAL_MISSING@HUMAN_AUTHORITY_GATE"],
  ["a bare string", "human:yaron", "APPROVAL_PRINCIPAL_MISSING@HUMAN_AUTHORITY_GATE"],
  ["an empty id", { ...HUMAN, principalId: "" }, "APPROVAL_PRINCIPAL_UNNAMED@HUMAN_AUTHORITY_GATE"],
  ["a blank id", { ...HUMAN, principalId: "  " }, "APPROVAL_PRINCIPAL_UNNAMED@HUMAN_AUTHORITY_GATE"],
  ["a missing id", { kind: "HUMAN" }, "APPROVAL_PRINCIPAL_UNNAMED@HUMAN_AUTHORITY_GATE"],
  ["an agent", { ...HUMAN, kind: "AGENT" }, "APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE"],
  ["the system", { ...HUMAN, kind: "SYSTEM" }, "APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE"],
  ["an unknown kind", { ...HUMAN, kind: "ROBOT" },
    "APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE"],
];

it("generates one refusal case per rejected principal shape", () => {
  expect(PRINCIPAL_REFUSALS.length).toBe(9);
  expect(PRINCIPAL_REFUSALS.length).toBeGreaterThan(0);
});

it.each(PRINCIPAL_REFUSALS)("refuses %s with an exact code and layer", (_label, principal, want) => {
  expect(outcome(grantHumanAuthority(gated(), principal, MOMENT))).toBe(want);
});

const MOMENT_REFUSALS: readonly (readonly [string, unknown])[] = [
  ["not a number", "2026-08-15"], ["not a number at all", null], ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY], ["fractional", 1_755_216_000_000.5],
  ["negative", -1],
];

it("generates one refusal case per rejected moment", () => {
  expect(MOMENT_REFUSALS.length).toBe(6);
  expect(MOMENT_REFUSALS.length).toBeGreaterThan(0);
});

it.each(MOMENT_REFUSALS)("refuses a grant whose moment is %s", (_label, moment) => {
  expect(outcome(grantHumanAuthority(gated(), HUMAN, moment)))
    .toBe("APPROVAL_GRANT_MOMENT_INVALID@HUMAN_AUTHORITY_GATE");
});

it("refuses an ungranted gate at the gate layer", () => {
  expect(outcome(checkHumanAuthority(gated())))
    .toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED@HUMAN_AUTHORITY_GATE");
});

/** The grant is re-derived from a real mint, so only the BINDING differs. */
function transplanted(patch: Partial<HumanAuthorityGate>): HumanAuthorityGate {
  const minted = grantHumanAuthority(gated(), HUMAN, MOMENT);
  if (!minted.ok) throw new Error("expected a grant");
  return { gateId: GATE_ID, grant: minted.gate.grant, workRef: WORK_REF, ...patch };
}

it("refuses a grant transplanted onto another unit of work", () => {
  expect(outcome(checkHumanAuthority(transplanted({ workRef: "task-4e1fe696" }))))
    .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE");
});

it("refuses a grant transplanted onto another authority gate", () => {
  expect(outcome(checkHumanAuthority(transplanted({ gateId: "GO_QUIESCE" }))))
    .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE");
});

/**
 * The grant here was never minted by `grantHumanAuthority`; it was written
 * straight onto the gate, which is exactly what an agent with write access to
 * the record would do. `checkHumanAuthority` re-validates rather than trusting a
 * stored grant, so writing the record confers nothing.
 */
it("refuses a hand-written grant naming a non-human principal", () => {
  const forged: HumanAuthorityGate = {
    gateId: GATE_ID,
    grant: {
      gateId: GATE_ID, grantedAtEpochMs: MOMENT, principalId: "worker-fd8f822b",
      principalKind: "AGENT", workRef: WORK_REF,
    },
    workRef: WORK_REF,
  };
  expect(outcome(checkHumanAuthority(forged)))
    .toBe("APPROVAL_PRINCIPAL_NOT_HUMAN@HUMAN_AUTHORITY_GATE");
});

/**
 * THE FORGERY THAT LOOKS LIKE A MATCH. An agent that writes the record can make
 * the binding compare equal by naming NOTHING on both sides: `undefined` equals
 * `undefined`, and a grant bound to no work would otherwise read as bound to
 * this work. The gate's own identity has to be named before any comparison of it
 * means anything.
 */
it("refuses a hand-written grant bound to an unnamed gate and work reference", () => {
  const unnamed = { gateId: undefined, workRef: undefined } as unknown as HumanAuthorityGate;
  const forged: HumanAuthorityGate = {
    ...unnamed,
    grant: {
      ...(unnamed as unknown as { gateId: string; workRef: string }),
      grantedAtEpochMs: MOMENT, principalId: "human:yaron", principalKind: "HUMAN",
    },
  };
  expect(outcome(checkHumanAuthority(forged)))
    .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE");
});

it.each([["gate", "gateId"], ["work", "workRef"]])(
  "refuses to mint a grant for a gate naming no %s reference",
  (_label, field) => {
    const unnamed = { ...gated(), [field]: "  " } as HumanAuthorityGate;
    expect(outcome(grantHumanAuthority(unnamed, HUMAN, MOMENT)))
      .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE");
  },
);

it("refuses a hand-written grant naming no principal", () => {
  const forged: HumanAuthorityGate = {
    gateId: GATE_ID,
    grant: {
      gateId: GATE_ID, grantedAtEpochMs: MOMENT, principalId: "  ",
      principalKind: "HUMAN", workRef: WORK_REF,
    },
    workRef: WORK_REF,
  };
  expect(outcome(checkHumanAuthority(forged)))
    .toBe("APPROVAL_PRINCIPAL_UNNAMED@HUMAN_AUTHORITY_GATE");
});
