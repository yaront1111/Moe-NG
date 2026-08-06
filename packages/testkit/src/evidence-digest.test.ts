import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  identifyCanonicalEvidence,
  identifyEvidence,
  snapshotEvidenceBytes,
} from "./evidence-digest.js";

describe("identifyEvidence", () => {
  it("identifies exact bytes with lowercase SHA-256 and a portable object path", async () => {
    const bytes = new TextEncoder().encode("abc");

    expect(identifyEvidence(bytes)).toEqual({
      algorithm: "sha256",
      byteLength: 3,
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      identityVersion: "moe-evidence-identity/1",
      objectPath:
        "objects/sha256/ba/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("distinguishes a trailing line feed", async () => {
    expect(identifyEvidence(new TextEncoder().encode("abc\n")).digest).toBe(
      "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
    );
  });

  it("identifies empty evidence", async () => {
    expect(identifyEvidence(new Uint8Array()).digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes only the exact typed-array view", async () => {
    const backing = new Uint8Array([120, 97, 98, 99, 121]);

    expect(identifyEvidence(backing.subarray(1, 4))).toMatchObject({
      byteLength: 3,
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(identifyEvidence(Buffer.from(backing.buffer).subarray(1, 4))).toMatchObject({
      byteLength: 3,
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("uses the intrinsic byte length instead of an overridden getter", async () => {
    class MisreportedLength extends Uint8Array {
      public override get byteLength(): number {
        return 999;
      }
    }

    expect(identifyEvidence(new MisreportedLength([97, 98, 99]))).toMatchObject({
      byteLength: 3,
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("rejects an intrinsic byte length over a caller ceiling before copying", () => {
    class MisreportedLength extends Uint8Array {
      public override get byteLength(): number {
        return 1;
      }
    }

    expect(() => snapshotEvidenceBytes(new MisreportedLength([1, 2, 3]), 2)).toThrowError(
      "Evidence bytes exceed 2 bytes",
    );
  });

  it("rejects shared backing memory", async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(3));

    expect(() => identifyEvidence(shared)).toThrowError(
      "Unsupported evidence bytes: shared backing buffer",
    );
  });

  it("rejects cross-realm shared backing memory", async () => {
    const crossRealmSharedBuffer = runInNewContext("new SharedArrayBuffer(3)") as SharedArrayBuffer;

    expect(crossRealmSharedBuffer instanceof SharedArrayBuffer).toBe(false);
    expect(() => identifyEvidence(new Uint8Array(crossRealmSharedBuffer))).toThrowError(
      "Unsupported evidence bytes: shared backing buffer",
    );
  });

  it.each([
    new Uint16Array([0x6261, 0x0063]),
    new Uint8ClampedArray([97, 98, 99]),
    new DataView(new Uint8Array([97, 98, 99]).buffer),
  ])("rejects a non-Uint8Array binary view %#", async (wrongView) => {
    expect(() => identifyEvidence(wrongView as unknown as Uint8Array)).toThrowError(
      "Unsupported evidence bytes: Uint8Array required",
    );
  });

  it("binds the canonicalizer version into canonical evidence identity", async () => {
    expect(identifyCanonicalEvidence({ b: 2, a: 1 })).toMatchObject({
      byteLength: 13,
      canonicalizerVersion: "moe-canonical-json/1",
      digest: "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
      identityVersion: "moe-evidence-identity/1",
    });
  });
});
