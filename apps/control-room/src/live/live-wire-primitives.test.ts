import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { exactDataRecord, isRecord, listOf, sha256Hex } from "./live-wire-primitives.js";

describe("isRecord", () => {
  it("admits any non-null, non-array object and nothing else", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
    for (const value of [null, undefined, [], "text", 0, true, () => ({})]) {
      expect(isRecord(value), String(value)).toBe(false);
    }
  });
});

describe("exactDataRecord", () => {
  it("snapshots exactly the expected own data keys into a frozen null-prototype copy", () => {
    const source = { code: "X", layer: "L" };
    const snapshot = exactDataRecord(source, ["layer", "code"]);
    expect(snapshot).toEqual({ code: "X", layer: "L" });
    expect(snapshot).not.toBe(source);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("admits a null-prototype object and an empty key set", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { ok: true });
    expect(exactDataRecord(bare, ["ok"])).toEqual({ ok: true });
    expect(exactDataRecord({}, [])).toEqual({});
  });

  it("refuses non-objects, arrays and foreign prototypes", () => {
    for (const value of [null, undefined, "text", 1, [], ["code"]]) {
      expect(exactDataRecord(value, ["code"]), String(value)).toBeNull();
    }
    class Frame { code = "X"; }
    expect(exactDataRecord(new Frame(), ["code"])).toBeNull();
    expect(exactDataRecord(Object.create({ inherited: 1 }) as object, [])).toBeNull();
  });

  it("refuses a missing, extra, or symbol key", () => {
    expect(exactDataRecord({ code: "X" }, ["code", "layer"])).toBeNull();
    expect(exactDataRecord({ code: "X", layer: "L", extra: 1 }, ["code", "layer"])).toBeNull();
    expect(exactDataRecord({ code: "X", [Symbol("s")]: 1 }, ["code", "s"])).toBeNull();
  });

  it("refuses an accessor or a non-enumerable key without running the getter", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "code", {
      enumerable: true, get: () => { reads += 1; return "X"; },
    });
    expect(exactDataRecord(accessor, ["code"])).toBeNull();
    expect(reads).toBe(0);
    const hidden = Object.defineProperty({}, "code", { enumerable: false, value: "X" });
    expect(exactDataRecord(hidden, ["code"])).toBeNull();
  });

  it("answers null instead of throwing when a proxy trap throws", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(exactDataRecord(hostile, [])).toBeNull();
  });
});

describe("listOf", () => {
  const text = (item: unknown): string | null => (typeof item === "string" ? item : null);

  it("maps every item into a frozen list, and keeps an empty list a list", () => {
    const list = listOf(["a", "b"], text);
    expect(list).toEqual(["a", "b"]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(listOf([], text)).toEqual([]);
  });

  it("refuses a non-array and the whole list when one item fails its guard", () => {
    expect(listOf({ 0: "a", length: 1 }, text)).toBeNull();
    expect(listOf("ab", text)).toBeNull();
    const seen: unknown[] = [];
    const tracked = (item: unknown): string | null => { seen.push(item); return text(item); };
    expect(listOf(["a", 1, "c"], tracked)).toBeNull();
    expect(seen).toEqual(["a", 1]);
  });
});

describe("sha256Hex", () => {
  it("digests the UTF-8 bytes into lower-case hex, matching node:crypto", async () => {
    for (const text of ["", "{\"goalRef\":\"g-1\"}", "café \u{1F600}"]) {
      const expected = createHash("sha256").update(text, "utf8").digest("hex");
      await expect(sha256Hex(text)).resolves.toBe(expected);
    }
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
