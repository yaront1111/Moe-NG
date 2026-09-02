import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  readBoundedFoundationInputFile,
  type FoundationInputReadOps,
} from "./foundation-input-bounded-read.js";

describe("bounded foundation input reads", () => {
  it("reads an exact-limit regular file and refuses one byte beyond it", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-foundation-bounded-read-"));
    const exact = join(root, "exact.bin");
    const oversized = join(root, "oversized.bin");
    writeFileSync(exact, Buffer.from("abcd", "utf8"));
    writeFileSync(oversized, Buffer.from("abcde", "utf8"));
    try {
      expect(readBoundedFoundationInputFile(exact, 4)).toEqual({
        bytes: Buffer.from("abcd", "utf8"),
        kind: "BYTES",
      });
      expect(readBoundedFoundationInputFile(oversized, 4)).toEqual({ kind: "TOO_LARGE" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds a file that grows after its descriptor size was checked", () => {
    const requested: number[] = [];
    const close = vi.fn();
    const ops: FoundationInputReadOps = {
      close,
      fstat: () => ({ isFile: () => true, size: 1 }),
      open: () => 17,
      read: (_handle, buffer, offset, length) => {
        requested.push(length);
        buffer.fill(0x61, offset, offset + length);
        return length;
      },
    };

    expect(readBoundedFoundationInputFile("growing.bin", 16, ops))
      .toEqual({ kind: "TOO_LARGE" });
    expect(requested).toEqual([17]);
    expect(requested.reduce((total, length) => total + length, 0)).toBe(17);
    expect(close).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("closes the descriptor when a bounded read faults", () => {
    const failure = new Error("read fault");
    const close = vi.fn();
    const ops: FoundationInputReadOps = {
      close,
      fstat: () => ({ isFile: () => true, size: 1 }),
      open: () => 23,
      read: () => { throw failure; },
    };

    expect(() => readBoundedFoundationInputFile("fault.bin", 16, ops)).toThrow(failure);
    expect(close).toHaveBeenCalledExactlyOnceWith(23);
  });
});
