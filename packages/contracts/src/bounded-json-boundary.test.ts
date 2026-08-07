import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import * as contracts from "@moe/contracts";
import type {
  BoundedJsonDecodeError,
  BoundedJsonDecodeResult,
  JsonValue,
} from "@moe/contracts";

const encoder = new TextEncoder();

function bytes(source: string): Uint8Array {
  return encoder.encode(source);
}

function expectOk(result: BoundedJsonDecodeResult): JsonValue {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, received ${result.code}`);
  }
  return result.value;
}

function expectCode(
  result: BoundedJsonDecodeResult,
  code: BoundedJsonDecodeError["code"],
): BoundedJsonDecodeError {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) {
    throw new Error("expected bounded JSON failure");
  }
  return result;
}

describe("bounded JSON package contract", () => {
  it("exports the byte decoder from the package root", () => {
    expect(contracts).toHaveProperty("decodeBoundedJsonBytes");
    expect(typeof Reflect.get(contracts, "decodeBoundedJsonBytes")).toBe("function");
  });

  it("accepts an exact one-MiB body and rejects N+1 before decoding", () => {
    const { MAX_JSON_BODY_BYTES, MAX_JSON_STRING_UTF8_BYTES } = contracts;
    const finalLength = MAX_JSON_BODY_BYTES - 13 - 3 * MAX_JSON_STRING_UTF8_BYTES;
    const exact = bytes(
      `["${"a".repeat(MAX_JSON_STRING_UTF8_BYTES)}",` +
        `"${"b".repeat(MAX_JSON_STRING_UTF8_BYTES)}",` +
        `"${"c".repeat(MAX_JSON_STRING_UTF8_BYTES)}",` +
        `"${"d".repeat(finalLength)}"]`,
    );
    expect(exact.byteLength).toBe(MAX_JSON_BODY_BYTES);
    expect(expectOk(contracts.decodeBoundedJsonBytes(exact))).toHaveLength(4);

    const oversizedInvalidUtf8 = new Uint8Array(MAX_JSON_BODY_BYTES + 1);
    oversizedInvalidUtf8[0] = 0xff;
    expectCode(
      contracts.decodeBoundedJsonBytes(oversizedInvalidUtf8),
      "JSON_BODY_LIMIT_EXCEEDED",
    );
  });

  it("accepts depth 64 and rejects depth 65", () => {
    const depth64 = `${"[".repeat(contracts.MAX_JSON_DEPTH)}null${"]".repeat(
      contracts.MAX_JSON_DEPTH,
    )}`;
    expect(expectOk(contracts.decodeBoundedJsonBytes(bytes(depth64)))).toBeDefined();
    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(`[${depth64}]`)),
      "JSON_DEPTH_LIMIT_EXCEEDED",
    );
  });

  it("measures decoded string values in UTF-8 bytes at N and N+1", () => {
    const asciiN = "a".repeat(contracts.MAX_JSON_STRING_UTF8_BYTES);
    expect(expectOk(contracts.decodeBoundedJsonBytes(bytes(JSON.stringify(asciiN))))).toBe(
      asciiN,
    );
    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(JSON.stringify(`${asciiN}a`))),
      "JSON_STRING_LIMIT_EXCEEDED",
    );

    const multibyteN = "é".repeat(contracts.MAX_JSON_STRING_UTF8_BYTES / 2);
    expect(expectOk(contracts.decodeBoundedJsonBytes(bytes(JSON.stringify(multibyteN))))).toBe(
      multibyteN,
    );
    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(JSON.stringify(`${multibyteN}a`))),
      "JSON_STRING_LIMIT_EXCEEDED",
    );

    const escapedN = `"${"\\u00e9".repeat(contracts.MAX_JSON_STRING_UTF8_BYTES / 2)}"`;
    expect(expectOk(contracts.decodeBoundedJsonBytes(bytes(escapedN)))).toBe(multibyteN);
    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(`${escapedN.slice(0, -1)}\\u0061"`)),
      "JSON_STRING_LIMIT_EXCEEDED",
    );
  });

  it("applies the same UTF-8 boundary to decoded object keys", () => {
    const keyN = "k".repeat(contracts.MAX_JSON_STRING_UTF8_BYTES);
    const decoded = expectOk(
      contracts.decodeBoundedJsonBytes(bytes(`{${JSON.stringify(keyN)}:null}`)),
    );
    expect(Object.keys(decoded as object)).toEqual([keyN]);

    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(`{${JSON.stringify(`${keyN}k`)}:null}`)),
      "JSON_STRING_LIMIT_EXCEEDED",
    );
  });

  it("enforces decoded string bytes before scanning an attacker-controlled suffix", () => {
    const oversizedEscapes = `"${"\\n".repeat(
      contracts.MAX_JSON_STRING_UTF8_BYTES + 1,
    )}\\x"`;
    expect(oversizedEscapes.length).toBeLessThan(contracts.MAX_JSON_BODY_BYTES);
    expectCode(
      contracts.decodeBoundedJsonBytes(bytes(oversizedEscapes)),
      "JSON_STRING_LIMIT_EXCEEDED",
    );
  });

  it("accepts Buffer and snapshots bytes into a deeply frozen value", () => {
    const input = Buffer.from('{"items":[1,{"ready":true}]}', "utf8");
    const result = contracts.decodeBoundedJsonBytes(input);
    const value = expectOk(result);
    input.fill(0x20);

    expect(Object.isFrozen(result)).toBe(true);
    expect(value).toEqual({ items: [1, { ready: true }] });
    expect(Object.isFrozen(value)).toBe(true);
    const root = value as Readonly<Record<string, JsonValue>>;
    expect(Object.isFrozen(root.items)).toBe(true);
    const items = root.items as readonly JsonValue[];
    expect(Object.isFrozen(items[1])).toBe(true);
  });

  it("returns frozen stable errors without reflecting attacker bytes", () => {
    const result = expectCode(
      contracts.decodeBoundedJsonBytes(bytes('{"secret-password":')),
      "JSON_SYNTAX_INVALID",
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.message).not.toContain("secret-password");
    expect(Object.isFrozen(contracts.BOUNDED_JSON_ERROR_CODES)).toBe(true);
  });
});
