/**
 * Pins the small hostile-input primitives that goal, project, policy and cutover import from
 * this module instead of carrying private clones. Each arm is an edge a former clone handled,
 * so a regression here would have been a regression in every one of those areas at once.
 */
import { describe, expect, it } from "vitest";

import { deepFreeze as goalResultsFreeze } from "../goal/goal-results.js";
import {
  validExpectedVersion as goalExpectedVersion, validRef as goalRef,
} from "../goal/goal-validation.js";
import {
  deepFreeze as policyFreeze, strongTruth as policyStrongTruth, validRef as policyRef,
} from "../policy/policy-validation.js";
import { validExpectedVersion as projectExpectedVersion } from "../project/project-validation.js";
import {
  deepFreeze, exact, isRecord, strongTruth, validExpectedVersion, validRef,
} from "./planning-snapshot.js";

const revokedProxy = (): object => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};

describe("isRecord", () => {
  it("admits plain and null-prototype objects only", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], "x", 1, true, () => undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });

  it("fails closed when Array.isArray throws on a revoked proxy", () => {
    expect(isRecord(revokedProxy())).toBe(false);
  });
});

describe("exact", () => {
  it("accepts exactly the named enumerable data properties", () => {
    expect(exact({ a: 1, b: null }, ["a", "b"])).toBe(true);
    expect(exact({}, [])).toBe(true);
  });

  it("refuses a missing, extra, or symbol-keyed member", () => {
    expect(exact({ a: 1 }, ["a", "b"])).toBe(false);
    expect(exact({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    expect(exact({ a: 1, [Symbol("b")]: 2 }, ["a", "b"])).toBe(false);
  });

  it("refuses accessor and non-enumerable members of the right name", () => {
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "a", { enumerable: false, value: 1 });
    expect(exact(accessor, ["a"])).toBe(false);
    expect(exact(hidden, ["a"])).toBe(false);
  });

  it("refuses non-records and fails closed on throwing proxies", () => {
    expect(exact([], [])).toBe(false);
    expect(exact(null, [])).toBe(false);
    expect(exact(revokedProxy(), [])).toBe(false);
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } });
    expect(exact(hostile, [])).toBe(false);
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects, arrays, and symbol-keyed values in place", () => {
    const tag = Symbol("tag");
    const value = { list: [{ leaf: 1 }], [tag]: { hidden: true } };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value[tag])).toBe(true);
  });

  it("passes primitives and null through untouched", () => {
    for (const value of [null, undefined, 0, "x", false]) {
      expect(deepFreeze(value)).toBe(value);
    }
  });

  it("does not descend into a shell that is already frozen", () => {
    const child = { mutable: true };
    const shell = Object.freeze({ child });
    deepFreeze(shell);
    expect(Object.isFrozen(child)).toBe(false);
  });
});

describe("strongTruth, validRef, validExpectedVersion", () => {
  it("grants strong truth only to daemon-verified or human-approved facts", () => {
    expect(strongTruth("DAEMON_VERIFIED")).toBe(true);
    expect(strongTruth("HUMAN_APPROVED")).toBe(true);
    for (const value of ["OBSERVED", "human_approved", "", null, undefined, 1]) {
      expect(strongTruth(value)).toBe(false);
    }
  });

  it("admits any non-empty string as a ref", () => {
    expect(validRef("r")).toBe(true);
    expect(validRef(" ")).toBe(true);
    for (const value of ["", null, undefined, 1, ["r"]]) {
      expect(validRef(value)).toBe(false);
    }
  });

  it("admits only non-negative safe integers as an expected version", () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(validExpectedVersion(value)).toBe(true);
    }
    for (const value of [-1, 1.5, Number.NaN, 2 ** 53, "1", null, undefined]) {
      expect(validExpectedVersion(value)).toBe(false);
    }
  });
});

describe("single source", () => {
  it("is what goal, project, and policy re-export rather than a private clone", () => {
    expect(goalResultsFreeze).toBe(deepFreeze);
    expect(policyFreeze).toBe(deepFreeze);
    expect(goalRef).toBe(validRef);
    expect(policyRef).toBe(validRef);
    expect(policyStrongTruth).toBe(strongTruth);
    expect(goalExpectedVersion).toBe(validExpectedVersion);
    expect(projectExpectedVersion).toBe(validExpectedVersion);
  });
});
