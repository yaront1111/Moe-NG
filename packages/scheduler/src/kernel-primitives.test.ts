import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compareStrings, deepFreeze, exactRecord, frame, isRef, isSafeCount, oneOf,
} from "./kernel-primitives.js";

describe("deepFreeze", () => {
  it("freezes nested records and arrays in place and returns the same reference", () => {
    const value = { outer: { inner: [1, { leaf: "x" }] } };
    const frozen = deepFreeze(value);
    expect(frozen).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
    expect(Object.isFrozen(value.outer.inner[1])).toBe(true);
  });

  it("passes primitives and null through untouched", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze("text")).toBe("text");
  });

  it("stops at a value that is already frozen, leaving its children as they were", () => {
    const child = { mutable: true };
    const parent = Object.freeze({ child });
    deepFreeze(parent);
    expect(Object.isFrozen(child)).toBe(false);
  });
});

describe("compareStrings", () => {
  it("orders by UTF-16 code unit, not by locale collation", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("same", "same")).toBe(0);
    expect(compareStrings("Z", "a")).toBe(-1);
    expect(compareStrings("z", "é")).toBe(-1);
    expect(["b", "B", "a", "é"].sort(compareStrings)).toStrictEqual(["B", "a", "b", "é"]);
  });
});

describe("oneOf", () => {
  const VALUES = ["OPEN", "CLOSED"] as const;

  it("accepts only a string member of the vocabulary", () => {
    expect(oneOf("OPEN", VALUES)).toBe(true);
    expect(oneOf("open", VALUES)).toBe(false);
    expect(oneOf("toString", VALUES)).toBe(false);
    expect(oneOf(["OPEN"], VALUES)).toBe(false);
    expect(oneOf(null, VALUES)).toBe(false);
    expect(oneOf("OPEN", [])).toBe(false);
  });
});

describe("isRef", () => {
  it("accepts any non-empty string with no upper bound", () => {
    expect(isRef("x")).toBe(true);
    expect(isRef("r".repeat(10_000))).toBe(true);
    expect(isRef("")).toBe(false);
    expect(isRef(1)).toBe(false);
    expect(isRef(null)).toBe(false);
  });
});

describe("isSafeCount", () => {
  it("accepts a safe nonnegative integer up to Number.MAX_SAFE_INTEGER", () => {
    expect(isSafeCount(0)).toBe(true);
    expect(isSafeCount(42)).toBe(true);
    expect(isSafeCount(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects -0, negatives, fractions, NaN, infinities, unsafe magnitudes and non-numbers", () => {
    for (const value of [-0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1, "1", 1n, null]) {
      expect([value, isSafeCount(value)]).toStrictEqual([value, false]);
    }
  });
});

describe("exactRecord", () => {
  it("copies a plain record carrying exactly the named own data properties", () => {
    const input = { a: 1, b: undefined };
    const output = exactRecord(input, ["a", "b"]);
    expect(output).toStrictEqual({ a: 1, b: undefined });
    expect(output).not.toBe(input);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(exactRecord(bare, ["a"])).toStrictEqual({ a: 1 });
  });

  it("refuses a missing, extra, symbol-keyed or prototype-carried key", () => {
    expect(exactRecord({ a: 1 }, ["a", "b"])).toBeNull();
    expect(exactRecord({ a: 1, b: 2 }, ["a"])).toBeNull();
    expect(exactRecord({ a: 1, [Symbol("s")]: 2 }, ["a"])).toBeNull();
    const inherited = Object.create({ a: 1 }) as Record<string, unknown>;
    expect(exactRecord(inherited, ["a"])).toBeNull();
  });

  it("refuses an accessor without invoking it", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "a", {
      enumerable: true, get: () => { reads += 1; return 1; },
    });
    expect(exactRecord(hostile, ["a"])).toBeNull();
    expect(reads).toBe(0);
  });

  it("refuses proxies, arrays, class instances and non-objects", () => {
    expect(exactRecord(new Proxy({ a: 1 }, {}), ["a"])).toBeNull();
    expect(exactRecord([1], ["0"])).toBeNull();
    expect(exactRecord(new (class { a = 1; })(), ["a"])).toBeNull();
    expect(exactRecord(null, [])).toBeNull();
    expect(exactRecord("a", [])).toBeNull();
  });
});

describe("frame", () => {
  it("length-prefixes a token by UTF-16 code units", () => {
    expect(frame("")).toBe("0:");
    expect(frame("abc")).toBe("3:abc");
    expect(frame("\u{1F600}")).toBe("2:\u{1F600}");
  });

  it("keeps a concatenation injective across a moved boundary", () => {
    expect(frame("a") + frame("bc")).not.toBe(frame("ab") + frame("c"));
    expect(frame("1:a")).not.toBe(frame("1") + frame("a"));
  });
});

it("publishes exactly the one-line LF runtime bridge beside the module", () => {
  const bridge = readFileSync(new URL("./kernel-primitives.js", import.meta.url), "utf8");
  expect(bridge).toBe('export * from "./kernel-primitives.ts";\n');
});
