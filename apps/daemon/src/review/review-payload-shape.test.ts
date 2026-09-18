import { describe, expect, it } from "vitest";

import {
  ECHOED_KEYS, ECHOED_STRING_CHARS, describeJson, describeKeys, exactKeysDetail,
  unexpectedKeysDetail,
} from "./review-payload-shape.js";

/**
 * The header's own promise: a refusal must never grow with the caller's own bytes. Keys are the
 * one caller-supplied thing the roster helpers echo, so a caller who sends fifty 300-character
 * keys must still get a detail of a few hundred bytes — at most ECHOED_KEYS keys, each cut at
 * ECHOED_STRING_CHARS, and a count for the rest.
 */

const ROSTER = Object.freeze(["findings", "packageItems", "round", "subjectRef"] as const);
const ONE_KIB = 1024;

/** Fifty distinct keys of 300 characters each: 15 000 bytes of caller key material. */
function hostilePayload(): Record<string, number> {
  const payload: Record<string, number> = {};
  for (let index = 0; index < 50; index += 1) {
    payload[`k${String(index).padStart(2, "0")}${"x".repeat(297)}`] = index;
  }
  return payload;
}

describe("describeKeys bounds what a refusal echoes", () => {
  it("lists a short roster verbatim", () => {
    expect(describeKeys(["reviewer"])).toBe("reviewer");
    expect(describeKeys(["a", "b"])).toBe("a, b");
  });

  it("cuts a long key at ECHOED_STRING_CHARS and marks the cut", () => {
    const key = "y".repeat(ECHOED_STRING_CHARS + 1);
    expect(describeKeys([key])).toBe(`${"y".repeat(ECHOED_STRING_CHARS)}...`);
    // Exactly at the bound is echoed whole: the cut is for what EXCEEDS it.
    expect(describeKeys(["z".repeat(ECHOED_STRING_CHARS)])).toBe("z".repeat(ECHOED_STRING_CHARS));
  });

  it("lists at most ECHOED_KEYS keys and counts the rest", () => {
    const keys = Array.from({ length: ECHOED_KEYS + 3 }, (_, index) => `k${String(index)}`);
    expect(describeKeys(keys)).toBe(`${keys.slice(0, ECHOED_KEYS).join(", ")} +3 more`);
    // Exactly ECHOED_KEYS is listed whole with no "+0 more".
    expect(describeKeys(keys.slice(0, ECHOED_KEYS))).toBe(keys.slice(0, ECHOED_KEYS).join(", "));
  });

  it("pins the two bounds the header quotes", () => {
    expect(ECHOED_KEYS).toBe(8);
    expect(ECHOED_STRING_CHARS).toBe(64);
  });
});

describe("a roster refusal stays under 1 KiB against 50 keys of 300 chars", () => {
  it("unexpectedKeysDetail names 8 bounded keys and +42 more", () => {
    const detail = unexpectedKeysDetail(hostilePayload(), ROSTER);
    expect(detail).not.toBeNull();
    expect(Buffer.byteLength(detail!, "utf8")).toBeLessThan(ONE_KIB);
    expect(detail).toContain(`k00${"x".repeat(ECHOED_STRING_CHARS - 3)}...`);
    expect(detail).toContain("+42 more");
    expect(detail).not.toContain("k08");
    // Every listed key is cut: no whole 300-character key survived into the sentence.
    expect(detail).not.toContain("x".repeat(ECHOED_STRING_CHARS));
  });

  it("exactKeysDetail bounds the unexpected side and lists the missing roster whole", () => {
    const detail = exactKeysDetail(hostilePayload(), ROSTER);
    expect(detail).not.toBeNull();
    expect(Buffer.byteLength(detail!, "utf8")).toBeLessThan(ONE_KIB);
    expect(detail).toContain("missing: findings, packageItems, round, subjectRef");
    expect(detail).toContain("+42 more");
  });

  it("describeJson cuts an echoed string value at the same bound", () => {
    const shown = describeJson("v".repeat(ECHOED_STRING_CHARS * 5));
    expect(shown).toBe(`string ${JSON.stringify(`${"v".repeat(ECHOED_STRING_CHARS)}...`)}`);
  });
});
