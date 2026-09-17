import { describe, expect, it } from "vitest";

import { deepFreeze, isRecord } from "./value-primitives.js";

describe("isRecord admits a record of any prototype", () => {
  it("accepts a literal, a decoded null-prototype body and a class instance", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["a"] = 1;
    class Held { public readonly a = 1; }
    for (const value of [{}, { a: 1 }, bare, new Held(), new Date(0)]) {
      expect(isRecord(value)).toBe(true);
    }
  });

  it("refuses arrays, null and every primitive, including a function", () => {
    for (const value of [[], [{ a: 1 }], null, undefined, "", "{}", 0, 1, false, Symbol("s")]) {
      expect(isRecord(value)).toBe(false);
    }
    expect(isRecord(() => ({}))).toBe(false);
  });
});

describe("deepFreeze freezes the own enumerable string-keyed graph", () => {
  it("returns the same reference and freezes nested objects and arrays", () => {
    const nested = { list: [{ leaf: 1 }] };
    const value = { nested, scalar: 7 };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.list)).toBe(true);
    expect(Object.isFrozen(nested.list[0])).toBe(true);
  });

  it("terminates on a cycle, because the root is frozen before the walk descends", () => {
    const parent: Record<string, unknown> = {};
    const child: Record<string, unknown> = { parent };
    parent["child"] = child;
    expect(deepFreeze(parent)).toBe(parent);
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("leaves an already-frozen root's children alone: the early exit is the whole walk", () => {
    const child = { leaf: 1 };
    const root = Object.freeze({ child });
    expect(deepFreeze(root)).toBe(root);
    expect(Object.isFrozen(child)).toBe(false);
  });

  it("reaches own enumerable string keys only, so symbols and hidden members stay writable", () => {
    const symbolKey = Symbol("held");
    const hidden = { inner: 1 };
    const symbolMember = { deep: true };
    const value: Record<PropertyKey, unknown> = { [symbolKey]: symbolMember };
    Object.defineProperty(value, "quiet", { enumerable: false, value: hidden });

    deepFreeze(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(symbolMember)).toBe(false);
    expect(Object.isFrozen(hidden)).toBe(false);
  });

  it("returns null, undefined and primitives unchanged", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze("text")).toBe("text");
    expect(deepFreeze(7)).toBe(7);
  });
});
