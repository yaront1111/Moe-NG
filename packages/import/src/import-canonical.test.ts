import { describe, expect, it } from "vitest";

import { DETERMINISTIC_TIME_SENTINEL } from "./import-contract.js";
import {
  canonicalPayload,
  deriveImportedId,
  deriveProvenance,
  orderRecords,
} from "./import-canonical.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Design §21.7: imported ids, ordering, provenance times and canonical payloads derive
 * from source digests and the manifest, NOT from wall-clock import time.
 *
 * The assertions here are all about what the derivation must NOT depend on: caller order,
 * a clock, or a separator that two different field splits could both produce.
 */

const MANIFEST: SourceManifest = Object.freeze({
  digest: "a".repeat(64),
  entries: Object.freeze([
    Object.freeze({ digest: "b".repeat(64), path: "tasks/one.json", size: 12 }),
    Object.freeze({ digest: "c".repeat(64), path: "tasks/two.json", size: 34 }),
  ]),
  version: "moe-import-source-manifest/1",
});

const OTHER_MANIFEST: SourceManifest = Object.freeze({
  ...MANIFEST,
  digest: "d".repeat(64),
});

function record(over: Partial<LegacySourceRecord> = {}): LegacySourceRecord {
  return {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "claim",
    legacyId: "task-1",
    payload: { owner: "alice", state: "OPEN" },
    sourcePath: "tasks/one.json",
    ...over,
  };
}

describe("imported ids derive from source identity plus the manifest digest", () => {
  it("gives the same record the same id on every call", () => {
    expect(deriveImportedId(MANIFEST.digest, record()))
      .toBe(deriveImportedId(MANIFEST.digest, record()));
  });

  it("gives two different sources different ids for the same legacy id", () => {
    // Without the manifest digest in the input, two unrelated legacy projects that both
    // contain `task-1` would import onto the same id and silently merge.
    expect(deriveImportedId(OTHER_MANIFEST.digest, record()))
      .not.toBe(deriveImportedId(MANIFEST.digest, record()));
  });

  it("distinguishes records that a joined key would collide", () => {
    // The classic separator bug: "a" + ":" + "b:c" equals "a:b" + ":" + "c". A digest over
    // a canonical RECORD cannot collide this way; a digest over a joined string can.
    const left = deriveImportedId(MANIFEST.digest, record({ kind: "a", legacyId: "b:c" }));
    const right = deriveImportedId(MANIFEST.digest, record({ kind: "a:b", legacyId: "c" }));
    expect(left).not.toBe(right);
  });

  it("returns a 64-hex digest", () => {
    expect(deriveImportedId(MANIFEST.digest, record())).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("provenance time is the source's own or the deterministic sentinel", () => {
  it("uses the source-declared time and says so", () => {
    const provenance = deriveProvenance(MANIFEST, record());
    if ("outcome" in provenance) throw new Error(`refused: ${provenance.code}`);
    expect(provenance.sourceTime).toBe("2024-03-04T05:06:07.000Z");
    expect(provenance.timeBasis).toBe("SOURCE_DECLARED");
    expect(provenance.sourceDigest).toBe("b".repeat(64));
    expect(provenance.manifestDigest).toBe(MANIFEST.digest);
  });

  it("falls back to the sentinel, never to a clock, and marks the basis", () => {
    const provenance = deriveProvenance(MANIFEST, record({ declaredTime: null }));
    if ("outcome" in provenance) throw new Error(`refused: ${provenance.code}`);
    expect(provenance.sourceTime).toBe(DETERMINISTIC_TIME_SENTINEL);
    expect(provenance.timeBasis).toBe("MANIFEST_SENTINEL");
  });

  it("refuses a record whose source file the manifest never hashed", () => {
    const result = deriveProvenance(MANIFEST, record({ sourcePath: "tasks/absent.json" }));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_RECORD_UNCANONICAL");
    expect(result.layer).toBe("CANONICAL");
  });
});

describe("ordering is a total order over stable keys, never caller order", () => {
  it("produces the same sequence from any input permutation", () => {
    const records = [
      record({ kind: "link", legacyId: "b", sourcePath: "tasks/two.json" }),
      record({ kind: "claim", legacyId: "a", sourcePath: "tasks/one.json" }),
      record({ kind: "claim", legacyId: "b", sourcePath: "tasks/one.json" }),
      record({ kind: "claim", legacyId: "a", sourcePath: "tasks/two.json" }),
    ];
    const key = (entry: LegacySourceRecord): string =>
      `${entry.sourcePath}|${entry.kind}|${entry.legacyId}`;
    const forward = orderRecords(records).map(key);
    const reversed = orderRecords([...records].reverse()).map(key);
    expect(reversed).toEqual(forward);
    expect(forward).toEqual([
      "tasks/one.json|claim|a",
      "tasks/one.json|claim|b",
      "tasks/two.json|claim|a",
      "tasks/two.json|link|b",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const records = [record({ legacyId: "z" }), record({ legacyId: "a" })];
    const before = records.map((entry) => entry.legacyId);
    orderRecords(records);
    expect(records.map((entry) => entry.legacyId)).toEqual(before);
  });
});

describe("canonical payloads reject what a digest cannot represent", () => {
  it("serialises a plain payload with sorted keys", () => {
    const result = canonicalPayload(record({ payload: { b: 2, a: 1 } }));
    expect(result).toBe('{"a":1,"b":2}');
  });

  it("refuses a non-safe integer rather than digesting a lossy value", () => {
    const result = canonicalPayload(record({ payload: { count: Number.MAX_SAFE_INTEGER + 2 } }));
    expect(typeof result === "string").toBe(false);
    if (typeof result === "string") return;
    expect(result.code).toBe("IMPORT_RECORD_UNCANONICAL");
    expect(result.layer).toBe("CANONICAL");
  });

  it("refuses raw bytes, which canonical JSON cannot represent faithfully", () => {
    const result = canonicalPayload(record({ payload: { blob: new Uint8Array([1, 2]) } }));
    expect(typeof result === "string").toBe(false);
    if (typeof result === "string") return;
    expect(result.code).toBe("IMPORT_RECORD_UNCANONICAL");
    expect(result.layer).toBe("CANONICAL");
  });
});
