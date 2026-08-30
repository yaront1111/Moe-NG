import { describe, expect, it } from "vitest";

import * as core from "@moe/core";
import type { ApprovalCommand, ApprovalDecisionRecord } from "@moe/core";

const validChanges = () => ({
  additions: ["ref-a"],
  challenges: [] as string[],
  removals: ["ref-b"],
});

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function validApproval(): ApprovalDecisionRecord {
  return {
    actor: "human:root", actorKind: "HUMAN", applicablePolicyRef: hash("3"),
    approvalRef: "approval:1", approvedNodeScope: ["node:alpha"], budgetRef: hash("4"),
    criteriaRef: hash("5"), decision: null, decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash: hash("1"), lifecycle: "PENDING", planQualityAssessmentRef: hash("6"),
    policyDecisionRef: null, riskTier: "R1", stepUpAuthRef: "stepup:original",
    truthClass: "HUMAN_APPROVED", validity: "CURRENT",
  };
}

const DECIDE: ApprovalCommand = {
  decision: "APPROVE",
  decisionReason: "accept:reviewed",
  kind: "approval.decide",
  stepUpAuthRef: "stepup:decision",
};

type HostileCase = {
  readonly build: () => unknown;
  readonly name: string;
};

function cyclicChanges(): Record<string, unknown> {
  const additions: unknown[] = [];
  additions.push(additions);
  return { additions, challenges: [], removals: [] };
}

function revokedChanges(): unknown {
  const revoked = Proxy.revocable(validChanges(), {});
  revoked.revoke();
  return revoked.proxy;
}

function getterChanges(): unknown {
  const value = { challenges: [] as string[], removals: [] as string[] };
  Object.defineProperty(value, "additions", { enumerable: true, get: () => ["a"] });
  return value;
}

function exoticChanges<T extends object>(value: T): T & ReturnType<typeof validChanges> {
  return Object.assign(value, validChanges());
}

class DependencyChangesInstance {
  readonly additions = ["ref-a"];
  readonly challenges: string[] = [];
  readonly removals: string[] = [];
}

const HOSTILE_CASES: readonly HostileCase[] = [
  { name: "missing key", build: () => ({ additions: [], challenges: [] }) },
  { name: "extra key", build: () => ({ ...validChanges(), extra: true }) },
  { name: "non-array member", build: () => ({ ...validChanges(), additions: "ref-a" }) },
  { name: "null", build: () => null },
  { name: "top-level array", build: () => [validChanges()] },
  { name: "getter", build: getterChanges },
  { name: "class prototype", build: () => new DependencyChangesInstance() },
  { name: "Map prototype", build: () => exoticChanges(new Map()) },
  { name: "Date prototype", build: () => exoticChanges(new Date(0)) },
  { name: "symbol key", build: () => ({ ...validChanges(), [Symbol("hidden")]: true }) },
  { name: "cycle", build: cyclicChanges },
  { name: "revoked Proxy", build: revokedChanges },
];

describe("public approval dependency validation", () => {
  it("admits a detached deeply frozen dependency tuple", () => {
    const input = validChanges();
    const result = core.validateApprovalDependencyChanges(input);
    const sibling = core.validateApprovalDependencyChanges(input);

    expect(result).toBeDefined();
    expect(sibling).toBeDefined();
    if (result === undefined || sibling === undefined) return;
    expect(result).not.toBe(input);
    expect(result).not.toBe(sibling);
    expect(result.additions).not.toBe(input.additions);
    expect(result.additions).not.toBe(sibling.additions);
    expect(result.challenges).not.toBe(input.challenges);
    expect(result.removals).not.toBe(input.removals);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.additions)).toBe(true);
    expect(Object.isFrozen(result.challenges)).toBe(true);
    expect(Object.isFrozen(result.removals)).toBe(true);

    input.additions.push("ref-c");
    expect(result.additions).toEqual(["ref-a"]);
    expect(sibling.additions).toEqual(["ref-a"]);
  });

  it("isolates the ref-list fence with an empty-string ref", () => {
    expect(core.validateApprovalDependencyChanges({
      additions: [""], challenges: [], removals: [],
    })).toBeUndefined();
  });

  it("admits the ref-list divergence positive control", () => {
    expect(core.validateApprovalDependencyChanges({
      additions: ["a"], challenges: [], removals: [],
    })).toBeDefined();
  });

  it("isolates the snapshot fence with an otherwise admissible class instance", () => {
    const input = new DependencyChangesInstance();

    // exact()+refList() admits these data fields; only hostile snapshotting rejects the prototype.
    expect(core.validateApprovalDependencyChanges(input)).toBeUndefined();
  });

  it("refuses every generated hostile shape without throwing", () => {
    let swept = 0;
    for (const hostile of HOSTILE_CASES) {
      let result: unknown = "not-called";
      expect(() => {
        result = core.validateApprovalDependencyChanges(hostile.build());
      }, hostile.name).not.toThrow();
      expect(result, hostile.name).toBeUndefined();
      swept += 1;
    }
    expect(swept).toBe(HOSTILE_CASES.length);
    expect(HOSTILE_CASES).toHaveLength(12);
    expect(HOSTILE_CASES.length).toBeGreaterThan(0);
  });

  it("admits empty lists on a null-prototype object", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      additions: [], challenges: [], removals: [],
    });

    expect(core.validateApprovalDependencyChanges(input)).toEqual({
      additions: [], challenges: [], removals: [],
    });
  });

  it("admits the complete public human approval record", () => {
    const record = validApproval();

    expect(core.validateApprovalRecord(record)).toEqual(record);
  });

  it("refuses the same record when only dependency changes are malformed", () => {
    const record = validApproval();
    const malformed = {
      ...record,
      dependencyChanges: { ...record.dependencyChanges, additions: [""] },
    };

    expect(core.validateApprovalRecord(malformed)).toBeUndefined();
  });

  it("decides a current pending human approval through the public command surface", () => {
    const result = core.applyApprovalCommand(validApproval(), DECIDE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      decision: DECIDE.decision,
      decisionReason: DECIDE.decisionReason,
      lifecycle: "DECIDED",
      stepUpAuthRef: DECIDE.stepUpAuthRef,
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("maps malformed dependency changes to the core INPUT_INVALID refusal", () => {
    const record = validApproval();
    const malformed = {
      ...record,
      dependencyChanges: { additions: [""], challenges: [], removals: [] },
    };
    const result = core.applyApprovalCommand(malformed, DECIDE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INPUT_INVALID");
    expect(Object.hasOwn(result.error, "source")).toBe(false);
    expect(Object.hasOwn(result.error, "layer")).toBe(false);
  });
});
