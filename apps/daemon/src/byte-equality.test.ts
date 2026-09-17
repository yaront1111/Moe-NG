import { describe, expect, it } from "vitest";

import { sameBinaryBytes, sameBytes } from "./byte-equality.js";

/** The typed pairs both functions must answer identically: the domain the callers declare. */
const TYPED_PAIRS: readonly (readonly [string, Uint8Array, Uint8Array, boolean])[] = [
  ["identical contents", Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3), true],
  ["one differing byte", Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3), false],
  ["a prefix of the other", Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3), false],
  ["the longer one first", Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2), false],
  ["two empty views", new Uint8Array(0), new Uint8Array(0), true],
  ["empty against one byte", new Uint8Array(0), Uint8Array.of(0), false],
  ["a zero byte is a byte", Uint8Array.of(0), Uint8Array.of(0), true],
];

describe("sameBytes compares the bytes a view names", () => {
  it.each(TYPED_PAIRS)("%s", (_name, left, right, expected) => {
    expect(sameBytes(left, right)).toBe(expected);
  });

  it("compares a subarray as its window, never as the buffer behind it", () => {
    const backing = Uint8Array.of(9, 1, 2, 9);
    const window = backing.subarray(1, 3);
    expect(sameBytes(window, Uint8Array.of(1, 2))).toBe(true);
    expect(sameBytes(window, backing)).toBe(false);
  });

  it("answers on contents, not on class: a Buffer of the same bytes is the same bytes", () => {
    expect(sameBytes(Buffer.from([1, 2, 3]), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(sameBytes(Buffer.from([1, 2, 3]), Uint8Array.of(1, 2, 4))).toBe(false);
  });
});

describe("sameBinaryBytes adds the guard its readers refuse on", () => {
  it.each(TYPED_PAIRS)("%s, exactly as sameBytes", (_name, left, right, expected) => {
    expect(sameBinaryBytes(left, right)).toBe(expected);
  });

  it("refuses a non-view instead of throwing, which is what a broken store row looks like", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    for (const impostor of ["abc", [1, 2, 3], null, undefined, { byteLength: 3 }, 3]) {
      const lie = impostor as unknown as Uint8Array;
      expect(sameBinaryBytes(lie, bytes)).toBe(false);
      expect(sameBinaryBytes(bytes, lie)).toBe(false);
    }
    expect(sameBinaryBytes(
      "ab" as unknown as Uint8Array,
      "ab" as unknown as Uint8Array,
    )).toBe(false);
  });

  it("refuses two plain arrays that sameBytes would have compared element by element", () => {
    const left = [1, 2] as unknown as Uint8Array;
    const right = [1, 2, 3] as unknown as Uint8Array;
    expect(sameBinaryBytes(left, right)).toBe(false);
  });
});
