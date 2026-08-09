import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  decodeBoundedJsonBytes,
  type BoundedJsonDecodeError,
  type BoundedJsonDecodeResult,
  type JsonValue,
} from "./index.js";

const encoder = new TextEncoder();

function bytes(source: string): Uint8Array {
  return encoder.encode(source);
}

function expectCode(
  result: BoundedJsonDecodeResult,
  code: BoundedJsonDecodeError["code"],
): void {
  expect(result).toMatchObject({ ok: false, code });
}

function expectOk(result: BoundedJsonDecodeResult): JsonValue {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, received ${result.code}`);
  }
  return result.value;
}

describe("bounded JSON hostile input", () => {
  it("distinguishes fatal UTF-8 from JSON syntax", () => {
    expectCode(decodeBoundedJsonBytes(Uint8Array.of(0xff)), "JSON_UTF8_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes("{")), "JSON_SYNTAX_INVALID");
    expectCode(
      decodeBoundedJsonBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)),
      "JSON_SYNTAX_INVALID",
    );
  });

  it("rejects duplicate decoded keys", () => {
    expectCode(decodeBoundedJsonBytes(bytes('{"a":1,"a":2}')), "JSON_DUPLICATE_KEY");
    expectCode(
      decodeBoundedJsonBytes(bytes('{"a":1,"\\u0061":2}')),
      "JSON_DUPLICATE_KEY",
    );
  });

  it("reports malformed duplicate members as syntax before duplicate semantics", () => {
    expectCode(decodeBoundedJsonBytes(bytes('{"a":1,"a"}')), "JSON_SYNTAX_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes('{"a":1,"a":}')), "JSON_SYNTAX_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes('{"a":1,"a":2}x')), "JSON_SYNTAX_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes('[{"a":1,"a":2},]')), "JSON_SYNTAX_INVALID");
    expectCode(
      decodeBoundedJsonBytes(bytes('{"outer":{"a":1,"a":2},}')),
      "JSON_SYNTAX_INVALID",
    );
  });

  it("rejects escaped lone surrogates but accepts a valid pair", () => {
    expectCode(decodeBoundedJsonBytes(bytes('"\\ud800"')), "JSON_UNICODE_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes('"\\udc00"')), "JSON_UNICODE_INVALID");
    expect(expectOk(decodeBoundedJsonBytes(bytes('"\\ud83d\\ude00"')))).toBe("😀");
  });

  it("rejects non-finite numeric results and malformed number grammar", () => {
    expectCode(decodeBoundedJsonBytes(bytes("1e400")), "JSON_NUMBER_RANGE_INVALID");
    for (const source of ["01", "+1", "1.", "1e", "--1", "NaN", "Infinity"]) {
      expectCode(decodeBoundedJsonBytes(bytes(source)), "JSON_SYNTAX_INVALID");
    }
  });

  it("terminates and accepts finite numbers at end of input", () => {
    for (const [source, expected] of [
      ["0", 0],
      ["-0", -0],
      ["12", 12],
      ["1.25", 1.25],
      ["1e2", 100],
    ] as const) {
      expect(expectOk(decodeBoundedJsonBytes(bytes(source)))).toBe(expected);
    }
  });

  it("rejects number lexemes that lose value or exceed interoperable integer precision", () => {
    for (const source of [
      "1e-324",
      "-1e-324",
      "9007199254740992",
      "9007199254740993",
      "9007199254740990.5",
      "0.10000000000000001",
      "1e20",
    ]) {
      expectCode(decodeBoundedJsonBytes(bytes(source)), "JSON_NUMBER_RANGE_INVALID");
    }

    for (const source of ["0.1", "1.2300", "1e2", "5e-324", "1e-100", "9007199254740991"]) {
      expectOk(decodeBoundedJsonBytes(bytes(source)));
    }
  });

  it("rejects trailing tokens and literal control characters", () => {
    expectCode(decodeBoundedJsonBytes(bytes("{} []")), "JSON_SYNTAX_INVALID");
    expectCode(decodeBoundedJsonBytes(bytes('"line\nfeed"')), "JSON_SYNTAX_INVALID");
  });

  it("fails closed for proxies and unsupported binary shapes", () => {
    const proxy = new Proxy(bytes("null"), {
      get() {
        throw new Error("proxy trap must not execute");
      },
    });
    const revoked = Proxy.revocable(bytes("null"), {});
    revoked.revoke();
    for (const input of [
      proxy,
      revoked.proxy,
      "null",
      null,
      bytes("null").buffer,
      new DataView(new ArrayBuffer(4)),
      new Uint16Array(2),
      new Uint8ClampedArray(2),
    ]) {
      expectCode(decodeBoundedJsonBytes(input), "JSON_INPUT_TYPE_INVALID");
    }
  });

  it("refuses forged objects carrying Uint8Array.prototype without the brand", () => {
    const bare = Object.create(Uint8Array.prototype) as object;
    const dressed = Object.create(Uint8Array.prototype, {
      buffer: { value: bytes("null").buffer },
      byteLength: { value: 4 },
      byteOffset: { value: 0 },
      length: { value: 4 },
    }) as object;
    for (const forged of [bare, dressed]) {
      expectCode(decodeBoundedJsonBytes(forged), "JSON_INPUT_TYPE_INVALID");
    }
  });

  it("accepts a plain same-realm Uint8Array and a cross-realm Uint8Array", () => {
    expect(expectOk(decodeBoundedJsonBytes(bytes("[1,2]")))).toEqual([1, 2]);

    const foreign = runInNewContext(
      "Uint8Array.from([0x6e, 0x75, 0x6c, 0x6c])",
    ) as Uint8Array;
    expect(foreign).not.toBeInstanceOf(Uint8Array);
    expect(expectOk(decodeBoundedJsonBytes(foreign))).toBeNull();
  });

  it("keeps the decoder module free of node: import specifiers (browser-safe)", async () => {
    const source = await readFile(new URL("./bounded-json.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/["']node:/);
  });

  it("rejects shared, resizable, and detached backing stores", () => {
    expectCode(
      decodeBoundedJsonBytes(new Uint8Array(new SharedArrayBuffer(4))),
      "JSON_INPUT_TYPE_INVALID",
    );

    const ResizableArrayBuffer = ArrayBuffer as typeof ArrayBuffer & {
      new (byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
    };
    const resizable = new ResizableArrayBuffer(4, { maxByteLength: 8 });
    expectCode(
      decodeBoundedJsonBytes(new Uint8Array(resizable)),
      "JSON_INPUT_TYPE_INVALID",
    );

    const detachable = new ArrayBuffer(4);
    const detachedView = new Uint8Array(detachable);
    structuredClone(detachable, { transfer: [detachable] });
    expectCode(decodeBoundedJsonBytes(detachedView), "JSON_INPUT_TYPE_INVALID");
  });

  it("snapshots a typed-array subclass without invoking overridden accessors", () => {
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        throw new Error("untrusted byteLength getter");
      }

      override get buffer(): ArrayBuffer {
        throw new Error("untrusted buffer getter");
      }

      override get byteOffset(): number {
        throw new Error("untrusted byteOffset getter");
      }

      override [Symbol.iterator](): ArrayIterator<number> {
        throw new Error("untrusted iterator");
      }
    }

    const hostile = new HostileBytes(bytes('{"safe":true}'));
    expect(expectOk(decodeBoundedJsonBytes(hostile))).toEqual({ safe: true });
  });

  it("uses null-prototype records and treats magic keys as inert data", () => {
    const value = expectOk(
      decodeBoundedJsonBytes(bytes('{"__proto__":{"polluted":true},"constructor":1}')),
    );
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value as object)).toEqual(["__proto__", "constructor"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("does not sort non-index keys and makes no source-order identity claim", () => {
    const source = bytes('{"b":1,"a":[true,null]}');
    const first = expectOk(decodeBoundedJsonBytes(source));
    const second = expectOk(decodeBoundedJsonBytes(source));
    expect(first).toEqual(second);
    expect(Object.keys(first as object)).toEqual(["b", "a"]);

    const indexed = expectOk(decodeBoundedJsonBytes(bytes('{"2":2,"1":1,"a":0}')));
    expect(Object.keys(indexed as object)).toEqual(["1", "2", "a"]);
  });
});
