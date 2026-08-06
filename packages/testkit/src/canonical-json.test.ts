import { describe, expect, it } from "vitest";

import { CANONICAL_JSON_VERSION, canonicalize } from "./canonical-json.js";

const MAX_CANONICAL_DEPTH = 64;
const MAX_STRING_UTF8_BYTES = 256 * 1024;

describe("canonicalize", () => {
  it("sorts object keys recursively while preserving array order", async () => {
    expect(
      canonicalize({
        z: [{ beta: 2, alpha: 1 }, 3],
        a: { truth: true, empty: null },
      }),
    ).toBe('{"a":{"empty":null,"truth":true},"z":[{"alpha":1,"beta":2},3]}');
  });

  it("uses JSON scalar encoding", async () => {
    expect(canonicalize({ text: "line\nquote\"", negativeZero: -0 })).toBe(
      '{"negativeZero":0,"text":"line\\nquote\\\""}',
    );
  });

  it("publishes the canonicalizer version", async () => {
    expect(CANONICAL_JSON_VERSION).toBe("moe-canonical-json/1");
  });

  it("uses UTF-16 code-unit ordering for object keys", async () => {
    expect(
      canonicalize({
        "דּ": 7,
        "😀": 6,
        "€": 5,
        "ö": 4,
        "\u0080": 3,
        "1": 2,
        "\r": 1,
      }),
    ).toBe('{"\\r":1,"1":2,"":3,"ö":4,"€":5,"😀":6,"דּ":7}');
  });

  it("uses ECMAScript number serialization", async () => {
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0, Number.MIN_VALUE])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27,0,5e-324]",
    );
  });

  it("accepts valid surrogate pairs without Unicode normalization", async () => {
    expect(canonicalize(["😀", "é", "e\u0301"])).toBe('["😀","é","é"]');
  });

  it.each(["\uD800", "\uDC00", `valid-prefix-\uD800`])(
    "rejects a lone surrogate in a string value %#",
    async (value) => {
      expect(() => canonicalize(value)).toThrowError(
        "Unsupported canonical JSON value: lone surrogate",
      );
    },
  );

  it("rejects a lone surrogate in an object key", async () => {
    expect(() => canonicalize({ ["\uD800"]: true })).toThrowError(
      "Unsupported canonical JSON value: lone surrogate",
    );
  });

  it("accepts canonical depth 64 and rejects depth 65", async () => {
    let depth64: unknown = null;
    for (let depth = 0; depth < MAX_CANONICAL_DEPTH; depth += 1) {
      depth64 = [depth64];
    }

    expect(canonicalize(depth64)).toBe(
      `${"[".repeat(MAX_CANONICAL_DEPTH)}null${"]".repeat(MAX_CANONICAL_DEPTH)}`,
    );
    expect(() => canonicalize([depth64])).toThrowError(
      "Unsupported canonical JSON value: maximum depth 64 exceeded",
    );
  });

  it("accepts a 256 KiB UTF-8 string and rejects the next byte", async () => {
    const maximum = "a".repeat(MAX_STRING_UTF8_BYTES);

    expect(canonicalize(maximum).length).toBe(MAX_STRING_UTF8_BYTES + 2);
    expect(() => canonicalize(`${maximum}a`)).toThrowError(
      "Unsupported canonical JSON value: string exceeds 262144 UTF-8 bytes",
    );
  });

  it.each([
    [undefined, "undefined"],
    [Number.NaN, "non-finite number"],
    [Number.POSITIVE_INFINITY, "non-finite number"],
    [1n, "bigint"],
    [Symbol("evidence"), "symbol"],
    [() => "evidence", "function"],
    [new Date("2026-08-06T00:00:00.000Z"), "non-plain object"],
    [new Uint8Array([1]), "non-plain object"],
  ])("rejects unsupported value %#", async (value, reason) => {
    expect(() => canonicalize(value)).toThrowError(`Unsupported canonical JSON value: ${reason}`);
  });

  it("rejects cyclic references", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalize(cyclic)).toThrowError(
      "Unsupported canonical JSON value: cyclic reference",
    );
  });

  it("rejects sparse arrays", async () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";

    expect(() => canonicalize(sparse)).toThrowError(
      "Unsupported canonical JSON value: sparse array",
    );
  });

  it("rejects accessor properties", async () => {
    const value = Object.defineProperty({}, "unstable", {
      enumerable: true,
      get: () => "computed",
    });

    expect(() => canonicalize(value)).toThrowError(
      "Unsupported canonical JSON value: accessor property",
    );
  });

  it("rejects enumerable symbol-keyed properties", async () => {
    const value = { visible: true } as Record<PropertyKey, unknown>;
    value[Symbol("hidden")] = "unaddressable";

    expect(() => canonicalize(value)).toThrowError(
      "Unsupported canonical JSON value: symbol-keyed property",
    );
  });

  it("rejects proxies before invoking serialization traps", async () => {
    let trapCalls = 0;
    const value = new Proxy(
      { stable: true },
      {
        ownKeys: () => {
          trapCalls += 1;
          return ["stable"];
        },
      },
    );

    expect(() => canonicalize(value)).toThrowError("Unsupported canonical JSON value: proxy");
    expect(trapCalls).toBe(0);
  });

  it("rejects enumerable non-index array properties", async () => {
    const value = [1] as unknown[] & { note?: string };
    value.note = "hidden from JSON";

    expect(() => canonicalize(value)).toThrowError(
      "Unsupported canonical JSON value: non-index array property",
    );
  });

  it("rejects symbol-keyed array properties", async () => {
    const value = [1] as unknown[] & Record<PropertyKey, unknown>;
    value[Symbol("note")] = "hidden from JSON";

    expect(() => canonicalize(value)).toThrowError(
      "Unsupported canonical JSON value: symbol-keyed property",
    );
  });

  it("accepts shared acyclic references and rejects indirect cycles", async () => {
    const shared = { stable: true };
    const object: { array?: unknown[] } = {};
    const array = [object];
    object.array = array;

    expect(canonicalize({ left: shared, right: shared })).toBe(
      '{"left":{"stable":true},"right":{"stable":true}}',
    );
    expect(() => canonicalize(object)).toThrowError(
      "Unsupported canonical JSON value: cyclic reference",
    );
  });
});
