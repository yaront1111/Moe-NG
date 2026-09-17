import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  dataRecord, decodeJsonOrNull, exact, freezeDeep, hash, isObject, payloadRef, ref,
} from "./json-record-shape.js";

const encoder = new TextEncoder();

const decoded = (text: string): JsonValue => {
  const result = decodeBoundedJsonBytes(encoder.encode(text));
  if (!result.ok) throw new Error(`fixture did not decode: ${text}`);
  return result.value;
};

describe("isObject admits only what the bounded decoder produces", () => {
  it("accepts a decoded object, which carries a null prototype", () => {
    expect(isObject(decoded('{"a":1}'))).toBe(true);
    expect(isObject(decoded("{}"))).toBe(true);
  });

  it("refuses an object literal: its Object.prototype says it never came through the decoder", () => {
    expect(isObject({ a: 1 } as unknown as JsonValue)).toBe(false);
  });

  it("refuses every non-object JSON value and an absent member", () => {
    for (const value of [null, undefined, "{}", 0, true, decoded("[]"), decoded("[{}]")]) {
      expect(isObject(value)).toBe(false);
    }
  });
});

describe("exact is a closed roster check", () => {
  const body = decoded('{"b":2,"a":1}') as JsonObject;

  it("accepts exactly the roster, in any order", () => {
    expect(exact(body, ["a", "b"])).toBe(true);
    expect(exact(decoded("{}") as JsonObject, [])).toBe(true);
  });

  it("refuses a missing key, an extra key, and a same-sized body naming a different key", () => {
    expect(exact(body, ["a", "b", "c"])).toBe(false);
    expect(exact(body, ["a"])).toBe(false);
    expect(exact(body, ["a", "c"])).toBe(false);
  });
});

describe("ref is a non-empty string", () => {
  it("accepts any non-empty string, including whitespace", () => {
    expect(ref("receipt-1")).toBe(true);
    expect(ref(" ")).toBe(true);
  });

  it("refuses the empty string, non-strings and an absent member", () => {
    for (const value of ["", undefined, null, 1, false, decoded("[]"), decoded("{}")]) {
      expect(ref(value)).toBe(false);
    }
  });
});

describe("payloadRef reads one member as a reference or answers null", () => {
  const payload = decoded('{"goalId":"goal-1","blank":"","count":3,"nested":{"goalId":"x"},'
    + '"none":null,"list":["goal-1"]}') as JsonObject;

  it("returns the member itself when it is a non-empty string", () => {
    expect(payloadRef(payload, "goalId")).toBe("goal-1");
  });

  it("answers null for an empty string, a non-string, null and an absent key", () => {
    for (const key of ["blank", "count", "nested", "none", "list", "absent"]) {
      expect(payloadRef(payload, key)).toBeNull();
    }
  });
});

describe("decodeJsonOrNull folds every decoder refusal into null", () => {
  it("returns the bounded decoder's value, null prototype included", () => {
    const value = decodeJsonOrNull(encoder.encode('{"a":[1,"b"]}'));
    expect(value).toEqual({ a: [1, "b"] });
    expect(isObject(value)).toBe(true);
    expect(decodeJsonOrNull(encoder.encode('"text"'))).toBe("text");
  });

  it("answers null for a stored JSON null exactly as for undecodable bytes", () => {
    expect(decodeJsonOrNull(encoder.encode("null"))).toBeNull();
    for (const bytes of [
      new Uint8Array(0), encoder.encode("{"), encoder.encode('{"a":1,"a":2}'),
      Uint8Array.of(0x7b, 0xff, 0x7d),
    ]) {
      expect(decodeJsonOrNull(bytes)).toBeNull();
    }
  });
});

describe("hash is sha256 hex over the JSON text of the parts", () => {
  it("matches pinned vectors, so a stored id minted before consolidation still re-derives", () => {
    expect(hash([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect(hash(["receipt-id", "p", null]))
      .toBe("b1980ac6928bf7eb60ddfdc3964a16d1021092043c97e1dbf691b8e6d91283ee");
  });

  it("is order-sensitive and type-sensitive", () => {
    expect(hash(["a", 1])).toBe("135f17a475a61afdeeaf3759ad2e45ad1c7abb192395abe47e41fc8e395dc1a9");
    expect(hash([1, "a"])).toBe("2010945388e2de98f5651051478912aa4ff38bb13a2cdb1a2c257bb97fbf98ff");
    expect(hash(["1"])).not.toBe(hash([1]));
  });
});

describe("freezeDeep freezes the whole own-key graph and returns the same reference", () => {
  it("freezes nested objects, arrays and symbol-keyed members", () => {
    const hidden = Symbol("hidden");
    const nested = { list: [{ leaf: 1 }] };
    const value = { nested, [hidden]: { deep: true } };
    Object.defineProperty(value, "quiet", { enumerable: false, value: { inner: [] } });

    expect(freezeDeep(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.list)).toBe(true);
    expect(Object.isFrozen(nested.list[0])).toBe(true);
    expect(Object.isFrozen(value[hidden])).toBe(true);
    const quiet = (value as unknown as { quiet: { inner: unknown[] } }).quiet;
    expect(Object.isFrozen(quiet)).toBe(true);
    expect(Object.isFrozen(quiet.inner)).toBe(true);
  });

  it("does not descend into a root that is already frozen", () => {
    const child = { leaf: 1 };
    const root = Object.freeze({ child });
    expect(freezeDeep(root)).toBe(root);
    expect(Object.isFrozen(child)).toBe(false);
  });

  it("returns primitives and null unchanged", () => {
    expect(freezeDeep(null)).toBeNull();
    expect(freezeDeep(undefined)).toBeUndefined();
    expect(freezeDeep("text")).toBe("text");
    expect(freezeDeep(7)).toBe(7);
  });
});

describe("dataRecord is a prototype-agnostic record view", () => {
  it("returns the same object for a literal, a null-prototype object and a decoded object", () => {
    const literal = { a: 1 };
    const bare = Object.create(null) as Record<string, unknown>;
    const fromBytes = decoded('{"a":1}');
    expect(dataRecord(literal)).toBe(literal);
    expect(dataRecord(bare)).toBe(bare);
    expect(dataRecord(fromBytes)).toBe(fromBytes);
  });

  it("answers null for arrays, null, undefined and primitives", () => {
    for (const value of [[], [{}], null, undefined, "{}", 0, false]) {
      expect(dataRecord(value)).toBeNull();
    }
  });
});
