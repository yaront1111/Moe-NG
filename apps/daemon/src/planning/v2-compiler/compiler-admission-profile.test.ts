import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { V2CompilerNodeAdmissionRequest } from "./authority-contracts.js";
import { readCompilerAdmissionProfile } from "./compiler-admission-profile.js";
import { compilerNodeAdmissionAuthority } from "./compiler-scheduler-test-fixtures.js";
import { qualifiedIdentity } from "./material-identity.js";
import { PLANNER_ADMISSION_PROFILE_VERSION } from
  "./planner-admission-profile-contract.js";

const digest = (label: string): string => createHash("sha256").update(label).digest("hex");

function request(): V2CompilerNodeAdmissionRequest {
  return Object.freeze({
    authorityKind: "BUILDER",
    budgetBindingDigest: qualifiedIdentity("budget-bindings", [
      "node-build", "budget-build", "TIME", "30", "days",
    ]),
    budgetBindings: Object.freeze([Object.freeze({
      budgetId: "budget-build", kind: "TIME" as const, limit: 30, unit: "days",
    })]),
    contractBinding: Object.freeze({
      contractId: "contract-v2", revisionDigest: digest("contract-v2"),
      revisionId: "contract-v2-r1",
    }),
    graphId: "graph-v2-r1",
    graphSnapshotIdentity: digest("graph-snapshot"),
    nodeIntentDigest: digest("node-intent"),
    nodeKey: "node-build",
    policyRevision: digest("policy"),
  });
}

describe("V2 compiler PlannerAdmissionProfile reader", () => {
  it("accepts, detaches, and freezes the exact mapper success image", () => {
    const expectedRequest = request();
    const mapped = structuredClone(compilerNodeAdmissionAuthority(expectedRequest)) as any;
    let received: V2CompilerNodeAdmissionRequest | undefined;
    const accepted = readCompilerAdmissionProfile((value) => {
      received = value;
      return mapped;
    }, expectedRequest);

    expect(received).toBe(expectedRequest);
    expect(accepted).toEqual(mapped);
    expect(Object.keys(accepted!).sort()).toEqual(["authority", "ok", "profileBinding"]);
    expect(Object.keys(accepted!.authority).sort())
      .toEqual(["admissionAmounts", "admissionGatePolicy"]);
    expect(Object.keys(accepted!.profileBinding).sort())
      .toEqual(["nodeKey", "profileId", "revisionDigest", "revisionId", "version"]);
    expect(accepted!.profileBinding).toMatchObject({
      nodeKey: "node-build",
      profileId: "planner-admission-profile:node-build",
      revisionId: "planner-admission-profile:node-build:r1",
      version: PLANNER_ADMISSION_PROFILE_VERSION,
    });
    expect(accepted!.authority.admissionAmounts).toEqual([
      "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
    ].map((purpose) => ({ meter: "runner.authorized_ms", purpose, quantity: 1 })));
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted!.authority)).toBe(true);
    expect(Object.isFrozen(accepted!.authority.admissionAmounts)).toBe(true);
    expect(accepted!.authority.admissionAmounts.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(accepted!.profileBinding)).toBe(true);

    mapped.authority.admissionAmounts[0]!.quantity = 999;
    mapped.profileBinding.profileId = "planner-admission-profile:mutated";
    expect(accepted!.authority.admissionAmounts[0]!.quantity).toBe(1);
    expect(accepted!.profileBinding.profileId)
      .toBe("planner-admission-profile:node-build");
  });

  it("accepts the exact mixed TIME and COMPUTE mapper meter image", () => {
    const mixedRequest = Object.freeze({
      ...request(),
      budgetBindingDigest: qualifiedIdentity("budget-bindings", [
        "node-build",
        "budget-compute", "COMPUTE", "8", "attempts",
        "budget-time", "TIME", "30", "days",
      ]),
      budgetBindings: Object.freeze([
        Object.freeze({ budgetId: "budget-compute", kind: "COMPUTE" as const,
          limit: 8, unit: "attempts" }),
        Object.freeze({ budgetId: "budget-time", kind: "TIME" as const,
          limit: 30, unit: "days" }),
      ]),
    });
    const accepted = readCompilerAdmissionProfile(
      compilerNodeAdmissionAuthority, mixedRequest,
    );
    expect(accepted?.authority.admissionAmounts).toEqual([
      "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
    ].flatMap((purpose) => ["attempt.count", "runner.authorized_ms"]
      .map((meter) => ({ meter, purpose, quantity: 1 }))));
  });

  it("rejects aggregate quantities below the contributing source-budget count", () => {
    const twoTimeBudgets = Object.freeze({
      ...request(),
      budgetBindingDigest: qualifiedIdentity("budget-bindings", [
        "node-build",
        "budget-time-a", "TIME", "30", "days",
        "budget-time-b", "TIME", "40", "days",
      ]),
      budgetBindings: Object.freeze([
        Object.freeze({ budgetId: "budget-time-a", kind: "TIME" as const,
          limit: 30, unit: "days" }),
        Object.freeze({ budgetId: "budget-time-b", kind: "TIME" as const,
          limit: 40, unit: "days" }),
      ]),
    });
    const mapped = structuredClone(compilerNodeAdmissionAuthority(twoTimeBudgets)) as any;
    expect(mapped.authority.admissionAmounts.every(({ quantity }: any) => quantity === 2))
      .toBe(true);
    for (const amount of mapped.authority.admissionAmounts) amount.quantity = 1;
    expect(readCompilerAdmissionProfile(() => mapped, twoTimeBudgets)).toBeUndefined();
  });

  it("rejects a per-meter purpose total impossible for one source budget", () => {
    const expectedRequest = request();
    const mapped = structuredClone(compilerNodeAdmissionAuthority(expectedRequest)) as any;
    for (const amount of mapped.authority.admissionAmounts) {
      amount.quantity = Number.MAX_SAFE_INTEGER;
    }
    expect(readCompilerAdmissionProfile(() => mapped, expectedRequest)).toBeUndefined();
  });

  it.each([
    ["false ok", (value: any) => { value.ok = false; return value; }],
    ["mapper refusal", () => ({ code: "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH",
      layer: "PLANNER_ADMISSION_PROFILE_BINDING", ok: false })],
    ["missing outer key", (value: any) => { delete value.authority; return value; }],
    ["excess outer key", (value: any) => { value.extra = true; return value; }],
    ["missing authority key", (value: any) => {
      delete value.authority.admissionAmounts; return value;
    }],
    ["excess authority key", (value: any) => { value.authority.extra = true; return value; }],
    ["invalid gate vocabulary", (value: any) => {
      value.authority.admissionGatePolicy = "ALLOW"; return value;
    }],
    ["missing binding key", (value: any) => {
      delete value.profileBinding.profileId; return value;
    }],
    ["excess binding key", (value: any) => { value.profileBinding.extra = true; return value; }],
    ["wrong node binding", (value: any) => {
      value.profileBinding.nodeKey = "node-forged"; return value;
    }],
    ["wrong profile version", (value: any) => {
      value.profileBinding.version = "moe-planner-admission-profile-revision/2"; return value;
    }],
    ["invalid profile digest", (value: any) => {
      value.profileBinding.revisionDigest = "not-a-digest"; return value;
    }],
    ["invalid profile id", (value: any) => {
      value.profileBinding.profileId = ""; return value;
    }],
    ["provider meter", (value: any) => {
      value.authority.admissionAmounts[0].meter = "provider.input_tokens"; return value;
    }],
    ["unexpected budget-kind meter", (value: any) => {
      value.authority.admissionAmounts[0].meter = "attempt.count"; return value;
    }],
    ["missing purpose", (value: any) => {
      value.authority.admissionAmounts.shift(); return value;
    }],
    ["duplicate amount pair", (value: any) => {
      value.authority.admissionAmounts.push({ ...value.authority.admissionAmounts[0] });
      return value;
    }],
    ["noncanonical amount order", (value: any) => {
      value.authority.admissionAmounts.reverse(); return value;
    }],
    ["nonpositive amount", (value: any) => {
      value.authority.admissionAmounts[0].quantity = 0; return value;
    }],
    ["fractional amount", (value: any) => {
      value.authority.admissionAmounts[0].quantity = 1.5; return value;
    }],
    ["unsafe amount", (value: any) => {
      value.authority.admissionAmounts[0].quantity = Number.MAX_SAFE_INTEGER + 1; return value;
    }],
  ])("rejects a %s mapper result", (_name, mutate) => {
    const expectedRequest = request();
    const mapped = structuredClone(compilerNodeAdmissionAuthority(expectedRequest)) as any;
    expect(readCompilerAdmissionProfile(() => mutate(mapped), expectedRequest)).toBeUndefined();
  });

  it.each(["outer proxy", "outer accessor", "nested amount accessor", "nested binding proxy"])(
    "rejects a %s without invoking it",
    (kind) => {
      const expectedRequest = request();
      let hostileCalls = 0;
      let value: any = structuredClone(compilerNodeAdmissionAuthority(expectedRequest));
      if (kind === "outer proxy") value = new Proxy(value, {
        ownKeys: (target) => { hostileCalls += 1; return Reflect.ownKeys(target); },
      });
      else if (kind === "outer accessor") Object.defineProperty(
        value, "profileBinding", { enumerable: true,
          get: () => { hostileCalls += 1; throw new Error("must not execute"); } },
      );
      else if (kind === "nested amount accessor") Object.defineProperty(
        value.authority, "admissionAmounts", { enumerable: true,
          get: () => { hostileCalls += 1; throw new Error("must not execute"); } },
      );
      else value.profileBinding = new Proxy(value.profileBinding, {
        ownKeys: (target) => { hostileCalls += 1; return Reflect.ownKeys(target); },
      });

      expect(() => readCompilerAdmissionProfile(() => value, expectedRequest)).not.toThrow();
      expect(readCompilerAdmissionProfile(() => value, expectedRequest)).toBeUndefined();
      expect(hostileCalls).toBe(0);
    },
  );
});
