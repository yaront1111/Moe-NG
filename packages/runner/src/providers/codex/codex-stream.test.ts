import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_FRAMED_LINES } from "./codex-stream-anomalies.js";
import {
  CODEX_ACCEPTED_SCHEMA_VERSIONS,
  MAX_INLINE_STREAM_BYTES,
  MAX_INSPECTABLE_TAIL_BYTES,
  recordCodexStream,
  type RecordCodexStreamInput,
} from "./codex-stream.js";

const encoder = new TextEncoder();
const effect = { effectIntentId: "effect-1", attemptRef: "attempt-1", epoch: 7 };
const event = (
  seq: number,
  type = "assistant",
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ schemaVersion: "codex-stream-json/1", seq, type, ...extra });
const stream = (
  records: readonly (Record<string, unknown> | string)[],
  ending = "\n",
): Uint8Array => encoder.encode(records.map((entry) =>
  typeof entry === "string" ? entry : JSON.stringify(entry)).join(ending) + ending);
const record = (rawBytes: Uint8Array, overrides: Partial<RecordCodexStreamInput> = {}) =>
  recordCodexStream({ rawBytes, effect, acceptedSchemaVersions: CODEX_ACCEPTED_SCHEMA_VERSIONS, ...overrides });

const CORPUS_BEGIN = "moe-codex-golden-corpus/1 DATA BEGIN";
const CORPUS_END = "moe-codex-golden-corpus/1 DATA END";

interface GoldenCase {
  readonly caseId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawBase64: string;
}

function loadGoldenCorpus(): ReadonlyMap<string, Uint8Array> {
  const source = readFileSync(fileURLToPath(new URL(
    "../../../../../packages/testkit/src/providers/codex/codex-golden-streams.ts",
    import.meta.url,
  )), "utf8");
  const start = source.lastIndexOf(CORPUS_BEGIN);
  const end = source.lastIndexOf(CORPUS_END);
  if (start < 0 || end <= start) throw new Error("Codex corpus markers are absent");
  const block = source.slice(start + CORPUS_BEGIN.length, end);
  const parsed = JSON.parse(
    block.slice(block.indexOf("`") + 1, block.lastIndexOf("`")),
  ) as { readonly cases: readonly GoldenCase[] };
  const corpus = new Map<string, Uint8Array>();
  for (const entry of parsed.cases) {
    const bytes = new Uint8Array(Buffer.from(entry.rawBase64, "base64"));
    if (bytes.byteLength !== entry.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Codex corpus case ${entry.caseId} does not match its raw-byte pin`);
    }
    corpus.set(entry.caseId, bytes);
  }
  return corpus;
}

const GOLDEN = loadGoldenCorpus();

function goldenRecord(caseId: string) {
  const rawBytes = GOLDEN.get(caseId);
  if (rawBytes === undefined) throw new Error(`missing Codex golden case ${caseId}`);
  const result = record(rawBytes);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.record;
}

describe("Codex structured/raw stream", () => {
  it("drives every pinned golden case to its exact typed outcome", () => {
    const expected = [
      ["complete", "COMPLETED", []],
      ["cancelled", "CANCELLED", []],
      ["crashed", "INCOMPLETE", []],
      ["duplicated", "COMPLETED", ["DUPLICATE_EVENT"]],
      ["reordered", "COMPLETED", ["OUT_OF_ORDER"]],
      ["malformed", "UNKNOWN", ["MALFORMED_RECORD"]],
      ["truncated", "UNKNOWN", ["TRUNCATION"]],
      ["resumed", "REFUSED_RESUME_UNSUPPORTED", ["RESUME_DISCONTINUITY"]],
      ["version-mismatched", "UNKNOWN_SCHEMA", ["UNKNOWN_SCHEMA_VERSION"]],
    ] as const;
    expect(GOLDEN.size).toBe(9);
    for (const [caseId, disposition, anomalies] of expected) {
      const output = goldenRecord(caseId);
      expect(output.disposition, caseId).toBe(disposition);
      expect(output.anomalies, caseId).toEqual(anomalies);
    }
  });

  it("binds CRLF structured events and exact raw bytes to one frozen effect", () => {
    const rawBytes = stream([
      event(1, "system"),
      event(2, "result", { subtype: "success" }),
    ], "\r\n");
    const result = record(rawBytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.disposition).toBe("COMPLETED");
    expect(result.record.anomalies).toEqual([]);
    expect(result.record.events.map((entry) => entry.declaredSequence)).toEqual([1, 2]);
    expect(result.record.events.every((entry) =>
      entry.effectIntentId === "effect-1" && entry.attemptRef === "attempt-1" && entry.epoch === 7,
    )).toBe(true);
    expect(result.record.raw).toMatchObject({
      kind: "INLINE",
      byteLength: rawBytes.byteLength,
      sha256: createHash("sha256").update(rawBytes).digest("hex"),
    });
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.events)).toBe(true);
  });

  it("distinguishes reordering from a real sequence gap", () => {
    const reordered = record(stream([event(1), event(3), event(2), event(4, "result")]));
    const gapped = record(stream([event(1), event(3, "result")]));
    expect(reordered.ok && reordered.record.anomalies).toContain("OUT_OF_ORDER");
    expect(reordered.ok && reordered.record.anomalies).not.toContain("GAP");
    expect(gapped.ok && gapped.record.anomalies).toContain("GAP");
  });

  it("counts a malformed record as an occupied sequence slot", () => {
    const result = record(stream([event(1), "{malformed", event(3, "result")]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.anomalies).toContain("MALFORMED_RECORD");
    expect(result.record.anomalies).not.toContain("GAP");
    expect(result.record.disposition).toBe("UNKNOWN");
  });

  it("suppresses gap analysis across a counter regression", () => {
    const result = record(stream([event(8), event(9), event(2), event(20, "result")]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.anomalies).toContain("COUNTER_REGRESSION");
    expect(result.record.anomalies).not.toContain("GAP");
  });

  it("keys unsupported resume on resumedFrom rather than the first sequence", () => {
    const highOrigin = record(stream([event(7), event(8, "result")]));
    const resumed = record(stream([
      event(7, "system", { resumedFrom: "run-previous" }),
      event(8, "result"),
    ]));
    expect(highOrigin.ok && highOrigin.record.anomalies).not.toContain("RESUME_DISCONTINUITY");
    expect(resumed.ok && resumed.record).toMatchObject({
      disposition: "REFUSED_RESUME_UNSUPPORTED",
      anomalies: expect.arrayContaining(["RESUME_DISCONTINUITY"]),
    });
  });

  it("keeps unknown stream schema separate from pre-activation capability change", () => {
    const result = record(stream([
      { ...event(1), schemaVersion: "codex-stream-json/2" },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.disposition).toBe("UNKNOWN_SCHEMA");
    expect(result.record.anomalies).toContain("UNKNOWN_SCHEMA_VERSION");
    expect(JSON.stringify(result.record)).not.toContain("PROVIDER_CAPABILITY_CHANGED");
  });

  it("retains bounded tails while its digest still covers every raw byte", () => {
    const prefix = stream([event(1)]);
    const rawBytes = new Uint8Array(MAX_INLINE_STREAM_BYTES + 1).fill(0x78);
    rawBytes.set(prefix);
    const result = record(rawBytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.raw).toMatchObject({
      kind: "ARTIFACT_REF",
      artifactRequired: true,
      byteLength: rawBytes.byteLength,
      sha256: createHash("sha256").update(rawBytes).digest("hex"),
    });
    expect(Buffer.from(result.record.raw.tailBase64, "base64")).toHaveLength(
      MAX_INSPECTABLE_TAIL_BYTES,
    );
    expect(result.record.events[0]?.lineBase64).toBeNull();
  });

  it("refuses an unbounded event count with its stable reason code", () => {
    const rawBytes = new Uint8Array((MAX_FRAMED_LINES + 1) * 2);
    for (let index = 0; index < rawBytes.length; index += 2) {
      rawBytes[index] = 0x78;
      rawBytes[index + 1] = 0x0a;
    }
    expect(record(rawBytes)).toMatchObject({
      ok: false,
      code: "CODEX_STREAM_EVENT_LIMIT_EXCEEDED",
    });
  });

  it.each([
    ["bytes", { rawBytes: null }, "CODEX_STREAM_BYTES_INVALID"],
    ["effect identity", { effect: { ...effect, epoch: -1 } }, "CODEX_STREAM_EFFECT_IDENTITY_INVALID"],
    ["schema allowlist", { acceptedSchemaVersions: [] }, "CODEX_STREAM_SCHEMA_ALLOWLIST_EMPTY"],
  ])("refuses invalid %s with the stable code", (_label, overrides, code) => {
    const result = record(stream([event(1)]), overrides as Partial<RecordCodexStreamInput>);
    expect(result).toMatchObject({ ok: false, code });
  });
});
