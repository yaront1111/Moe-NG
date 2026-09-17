import { decodeBoundedJsonBytes } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { exactKeys, isRecord } from "./cutover-shape.js";

const decoded = (text: string): unknown => {
  const result = decodeBoundedJsonBytes(new TextEncoder().encode(text));
  if (!result.ok) throw new Error(`fixture did not decode: ${text}`);
  return result.value;
};

describe("isRecord admits the bodies a cutover codec decodes", () => {
  it("accepts a decoded body, which carries a null prototype, and a plain literal", () => {
    expect(isRecord(decoded('{"a":1}'))).toBe(true);
    expect(isRecord(decoded("{}"))).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("refuses arrays, null and primitives", () => {
    for (const value of [decoded("[]"), decoded("[1]"), [], null, undefined, "{}", 0, true]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe("exactKeys closes the roster in both directions", () => {
  it("accepts exactly the roster, in any order, on a decoded body", () => {
    const body = decoded('{"b":2,"a":1}');
    expect(exactKeys(body, ["a", "b"])).toBe(true);
    expect(exactKeys(body, ["b", "a"])).toBe(true);
    expect(exactKeys(decoded("{}"), [])).toBe(true);
  });

  it("refuses a missing key, an extra key and a same-sized body naming another key", () => {
    const body = decoded('{"a":1,"b":2}');
    expect(exactKeys(body, ["a", "b", "c"])).toBe(false);
    expect(exactKeys(body, ["a"])).toBe(false);
    expect(exactKeys(body, ["a", "c"])).toBe(false);
    expect(exactKeys(decoded('{"a":1}'), [])).toBe(false);
  });

  it("asks for OWN keys: an inherited member never satisfies the roster", () => {
    const inherited = Object.create({ a: 1 }) as Record<string, unknown>;
    inherited["b"] = 2;
    expect(exactKeys(inherited, ["a"])).toBe(false);
    expect(exactKeys(inherited, ["b"])).toBe(true);
  });

  it("refuses everything isRecord refuses, roster or no roster", () => {
    for (const value of [decoded("[]"), null, undefined, "{}", 7]) {
      expect(exactKeys(value, [])).toBe(false);
      expect(exactKeys(value, ["a"])).toBe(false);
    }
  });
});
