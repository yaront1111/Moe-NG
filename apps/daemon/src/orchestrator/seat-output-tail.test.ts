import { describe, expect, it } from "vitest";

import { createOutputTail } from "./seat-output-tail.js";

const MAX_BYTES = 16_384;

/** A seeded PRNG so the property loop is reproducible; mulberry32. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function byteLength(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
}

describe("createOutputTail", () => {
  it("keeps only the last 40 of 100 pushed lines, in order", () => {
    const tail = createOutputTail();
    for (let index = 0; index < 100; index += 1) tail.push(`line ${index}\n`);
    const lines = tail.lines();
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("line 60");
    expect(lines[39]).toBe("line 99");
  });

  it("bounds a 64 KiB single chunk to the last 16 KiB, split on newlines", () => {
    const tail = createOutputTail();
    // 64 lines of 1023 bytes each = exactly 64 KiB with the newlines. Under the 40-line cap, so
    // it is the BYTE bound that has to do the work here: 16384 / 1023 leaves 16 lines.
    const chunk = Array.from(
      { length: 64 },
      (_v, i) => `${String(i).padStart(4, "0")}${"x".repeat(1019)}`,
    ).join("\n");
    expect(Buffer.byteLength(`${chunk}\n`, "utf8")).toBe(64 * 1024);
    tail.push(`${chunk}\n`);
    const lines = tail.lines();
    expect(lines.length).toBe(16);
    expect(byteLength(lines)).toBeLessThanOrEqual(MAX_BYTES);
    expect(tail.bytes()).toBe(16 * 1023);
    expect((lines[0] as string).startsWith("0048")).toBe(true);
    expect((lines[15] as string).startsWith("0063")).toBe(true);
  });

  it("drops a single line longer than maxBytes down to its last maxBytes without hanging", () => {
    const tail = createOutputTail();
    tail.push(`${"y".repeat(1_000_000)}\n`);
    expect(tail.bytes()).toBeLessThanOrEqual(MAX_BYTES);
    const lines = tail.lines();
    expect(lines.length).toBe(1);
    expect((lines[0] as string).length).toBeLessThanOrEqual(MAX_BYTES);
    // The TAIL of the line survives, not its head: the refusal sentence trails the noise.
    expect((lines[0] as string).endsWith("y")).toBe(true);
  });

  it("strips CR from CRLF input", () => {
    const tail = createOutputTail();
    tail.push("alpha\r\nbeta\r\n");
    expect(tail.lines()).toEqual(["alpha", "beta"]);
    expect(tail.lines().some((line) => line.includes("\r"))).toBe(false);
  });

  it("joins a line split across two pushes and surfaces a partial trailing line", () => {
    const tail = createOutputTail();
    tail.push("You've hit your ses");
    // The partial line is already readable — a seat that dies mid-line still yields its last words.
    expect(tail.lines()).toEqual(["You've hit your ses"]);
    tail.push("sion limit\n");
    expect(tail.lines()).toEqual(["You've hit your session limit"]);
  });

  it("keeps a UTF-8 sequence intact when it is split across two pushes", () => {
    const tail = createOutputTail();
    const encoded = Buffer.from("resets 12:10am · done\n", "utf8");
    const split = encoded.indexOf(0xC2) + 1;
    tail.push(encoded.subarray(0, split));
    tail.push(encoded.subarray(split));
    expect(tail.lines()).toEqual(["resets 12:10am · done"]);
    expect(tail.lines()[0]).not.toContain("�");
  });

  it("accepts strings and Buffers alike", () => {
    const tail = createOutputTail();
    tail.push("one\n");
    tail.push(Buffer.from("two\n", "utf8"));
    expect(tail.lines()).toEqual(["one", "two"]);
  });

  it("honours explicit bounds — the line cap first, then the byte cap", () => {
    // maxLines alone would keep bbbb/cccc/dddd (12 bytes); maxBytes 11 then drops one more.
    const tail = createOutputTail({ maxBytes: 11, maxLines: 3 });
    tail.push("aaaa\nbbbb\ncccc\ndddd\n");
    expect(tail.lines()).toEqual(["cccc", "dddd"]);
    expect(tail.bytes()).toBe(8);
    const lineCapped = createOutputTail({ maxBytes: 1024, maxLines: 3 });
    lineCapped.push("aaaa\nbbbb\ncccc\ndddd\n");
    expect(lineCapped.lines()).toEqual(["bbbb", "cccc", "dddd"]);
  });

  it("returns a frozen copy that later pushes cannot mutate", () => {
    const tail = createOutputTail();
    tail.push("first\n");
    const snapshot = tail.lines();
    expect(Object.isFrozen(snapshot)).toBe(true);
    tail.push("second\n");
    expect(snapshot).toEqual(["first"]);
  });

  it("never exceeds either bound across random chunk sizes", () => {
    const random = prng(0x5EA7);
    const tail = createOutputTail();
    let pushes = 0;
    for (let round = 0; round < 400; round += 1) {
      const size = 1 + Math.floor(random() * 900);
      const body = Array.from({ length: size }, () => (random() < 0.08 ? "\n" : "z")).join("");
      tail.push(body);
      pushes += 1;
      expect(tail.bytes()).toBeLessThanOrEqual(MAX_BYTES);
      expect(byteLength(tail.lines())).toBeLessThanOrEqual(MAX_BYTES);
      expect(tail.lines().length).toBeLessThanOrEqual(40);
    }
    // The sweep must actually have run: a zero-round loop would pass every assertion above.
    expect(pushes).toBe(400);
    expect(tail.lines().length).toBeGreaterThan(0);
  });
});
