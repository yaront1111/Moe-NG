import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../canonical.js";
import { MAX_FRAMED_LINES } from "./claude-stream-anomalies.js";
import {
  CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  MAX_INLINE_STREAM_BYTES,
  MAX_INSPECTABLE_TAIL_BYTES,
  recordClaudeStream,
  type ClaudeStreamAnomaly,
  type ClaudeStreamRecord,
  type MoeEffectIdentity,
} from "./claude-stream.js";

/**
 * The runner cannot import the testkit corpus — `packages/runner` typechecks
 * with `rootDir: "src"`, so a relative import across packages fails its own
 * gate. The corpus is read as data instead, through the marker contract the
 * testkit suite asserts from the producing side, and every fixture is
 * re-verified against its pinned digest BEFORE any assertion consumes it. A
 * fixture that drifted by one byte fails here, loudly, rather than silently
 * changing what these tests mean.
 */
const CORPUS_BEGIN = "moe-claude-golden-corpus/1 DATA BEGIN";
const CORPUS_END = "moe-claude-golden-corpus/1 DATA END";

interface GoldenCase {
  readonly caseId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawBase64: string;
}

function loadGoldenCorpus(): ReadonlyMap<string, Uint8Array> {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../packages/testkit/src/providers/claude/claude-golden-streams.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const start = source.lastIndexOf(CORPUS_BEGIN);
  const end = source.lastIndexOf(CORPUS_END);
  if (start < 0 || end <= start) {
    throw new Error("golden corpus markers are missing from the testkit module");
  }
  const block = source.slice(start + CORPUS_BEGIN.length, end);
  const json = block.slice(block.indexOf("`") + 1, block.lastIndexOf("`"));
  const parsed = JSON.parse(json) as { readonly cases: readonly GoldenCase[] };
  const corpus = new Map<string, Uint8Array>();
  for (const entry of parsed.cases) {
    const bytes = new Uint8Array(Buffer.from(entry.rawBase64, "base64"));
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`golden case ${entry.caseId} decodes to the wrong length`);
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`golden case ${entry.caseId} does not match its pinned digest`);
    }
    corpus.set(entry.caseId, bytes);
  }
  return corpus;
}

const CORPUS = loadGoldenCorpus();

const EFFECT: MoeEffectIdentity = Object.freeze({
  effectIntentId: "effect-intent-golden",
  attemptRef: "attempt-1",
  epoch: 3,
});

function golden(caseId: string): Uint8Array {
  const bytes = CORPUS.get(caseId);
  if (bytes === undefined) {
    throw new Error(`golden case ${caseId} is absent from the corpus`);
  }
  return bytes;
}

function recordOrThrow(bytes: Uint8Array): ClaudeStreamRecord {
  const result = recordClaudeStream({
    rawBytes: bytes,
    effect: EFFECT,
    acceptedSchemaVersions: CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  });
  if (!result.ok) {
    throw new Error(`stream record failed: ${result.code} ${result.message}`);
  }
  return result.record;
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function line(seq: number, type = "assistant"): string {
  return `{"schemaVersion":"claude-stream-json/1","seq":${seq},"type":"${type}","text":"t"}`;
}

function anomaliesOf(record: ClaudeStreamRecord): readonly ClaudeStreamAnomaly[] {
  return record.anomalies;
}

describe("claude stream corpus dispositions", () => {
  it("drives every golden case to its exact typed outcome", () => {
    const expected: ReadonlyArray<readonly [string, string, readonly ClaudeStreamAnomaly[]]> = [
      ["complete", "COMPLETED", []],
      ["cancelled", "CANCELLED", []],
      ["crashed", "INCOMPLETE", []],
      ["duplicated", "COMPLETED", ["DUPLICATE_EVENT"]],
      ["reordered", "COMPLETED", ["OUT_OF_ORDER"]],
      ["malformed", "UNKNOWN", ["MALFORMED_RECORD"]],
      ["truncated", "UNKNOWN", ["TRUNCATION"]],
      ["resumed", "REFUSED_RESUME_UNSUPPORTED", ["RESUME_DISCONTINUITY"]],
      ["version-mismatched", "UNKNOWN_SCHEMA", ["UNKNOWN_SCHEMA_VERSION"]],
    ];
    for (const [caseId, disposition, anomalies] of expected) {
      const record = recordOrThrow(golden(caseId));
      expect(`${caseId}:${record.disposition}`).toBe(`${caseId}:${disposition}`);
      expect(`${caseId}:${anomaliesOf(record).join(",")}`).toBe(`${caseId}:${anomalies.join(",")}`);
    }
  });

  it("keeps an unknown schema version distinct from a wrapper capability change", () => {
    const record = recordOrThrow(golden("version-mismatched"));
    expect(record.disposition).toBe("UNKNOWN_SCHEMA");
    expect(JSON.stringify(record)).not.toContain("PROVIDER_CAPABILITY_CHANGED");
  });
});

describe("order and byte preservation", () => {
  it("preserves delivery order rather than sorting by declared sequence", () => {
    const record = recordOrThrow(golden("reordered"));
    expect(record.events.map((event) => event.declaredSequence)).toEqual([1, 3, 2, 4]);
    expect(record.events.map((event) => event.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("preserves every line byte for byte, including CRLF", () => {
    const bytes = golden("complete");
    const record = recordOrThrow(bytes);
    const rejoined = record.events
      .map((event) => Buffer.from(event.lineBase64 ?? "", "base64").toString("utf8"))
      .join("\r\n");
    expect(`${rejoined}\r\n`).toBe(Buffer.from(bytes).toString("utf8"));
    for (const event of record.events) {
      const lineBytes = new Uint8Array(Buffer.from(event.lineBase64 ?? "", "base64"));
      expect(event.lineSha256).toBe(sha256Hex(lineBytes));
      expect(event.byteLength).toBe(lineBytes.byteLength);
      expect(lineBytes.includes(0x0d)).toBe(false);
    }
  });

  it("binds the caller-supplied effect identity onto every event", () => {
    const record = recordOrThrow(golden("duplicated"));
    expect(record.events.length).toBeGreaterThan(0);
    for (const event of record.events) {
      expect(event.effectIntentId).toBe(EFFECT.effectIntentId);
      expect(event.attemptRef).toBe(EFFECT.attemptRef);
      expect(event.epoch).toBe(EFFECT.epoch);
    }
    expect(record.effect).toEqual(EFFECT);
  });

  it("records the malformed line without pretending it parsed", () => {
    const record = recordOrThrow(golden("malformed"));
    const broken = record.events.filter((event) => event.declaredSequence === null);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.type).toBeNull();
    expect(broken[0]?.lineSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("closed anomaly detection", () => {
  it("detects a gap in the sequence counter", () => {
    const record = recordOrThrow(utf8([line(1, "system"), line(4), ""].join("\n")));
    expect(record.anomalies).toEqual(["GAP"]);
    expect(record.disposition).toBe("UNKNOWN");
  });

  it("separates a counter restart from a merely late record", () => {
    const regressed = recordOrThrow(
      utf8([line(5, "system"), line(6), line(1), ""].join("\n")),
    );
    expect(regressed.anomalies).toEqual(["COUNTER_REGRESSION"]);
    const late = recordOrThrow(utf8([line(1, "system"), line(3), line(2), ""].join("\n")));
    expect(late.anomalies).toEqual(["OUT_OF_ORDER"]);
  });

  it("reports each anomaly kind once, in vocabulary order", () => {
    const record = recordOrThrow(
      utf8(
        [
          line(1, "system"),
          line(1),
          line(5),
          "{not json",
          `{"schemaVersion":"claude-stream-json/9","seq":6,"type":"assistant"}`,
          `{"schemaVersion":"claude-stream-json/1","seq":7,"type":"res`,
        ].join("\n"),
      ),
    );
    expect(record.anomalies).toEqual([
      "DUPLICATE_EVENT",
      "GAP",
      "MALFORMED_RECORD",
      "TRUNCATION",
      "UNKNOWN_SCHEMA_VERSION",
    ]);
  });

  it("treats an empty stream as incomplete rather than complete", () => {
    const record = recordOrThrow(utf8(""));
    expect(record.disposition).toBe("INCOMPLETE");
    expect(record.events).toEqual([]);
    expect(record.raw.byteLength).toBe(0);
  });
});

describe("bounded retention", () => {
  it("retains a small stream inline with a complete digest", () => {
    const bytes = golden("complete");
    const record = recordOrThrow(bytes);
    expect(record.raw.kind).toBe("INLINE");
    expect(record.raw.sha256).toBe(sha256Hex(bytes));
    expect(record.raw.byteLength).toBe(bytes.byteLength);
    if (record.raw.kind !== "INLINE") return;
    expect(Buffer.from(record.raw.rawBase64, "base64").equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps digest coverage over every byte once inline retention overflows", () => {
    const filler = "x".repeat(1023);
    const chunk = `{"schemaVersion":"claude-stream-json/1","seq":1,"type":"assistant","text":"${filler}"}`;
    const parts: string[] = [];
    let total = 0;
    while (total <= MAX_INLINE_STREAM_BYTES) {
      parts.push(chunk);
      total += chunk.length + 1;
    }
    const bytes = utf8(`${parts.join("\n")}\n`);
    expect(bytes.byteLength).toBeGreaterThan(MAX_INLINE_STREAM_BYTES);
    const record = recordOrThrow(bytes);
    expect(record.raw.kind).toBe("ARTIFACT_REF");
    expect(record.raw.byteLength).toBe(bytes.byteLength);
    expect(record.raw.sha256).toBe(sha256Hex(bytes));
    if (record.raw.kind !== "ARTIFACT_REF") return;
    expect(record.raw.artifactRequired).toBe(true);
    const tail = new Uint8Array(Buffer.from(record.raw.tailBase64, "base64"));
    expect(tail.byteLength).toBe(MAX_INSPECTABLE_TAIL_BYTES);
    expect(Buffer.from(tail).equals(Buffer.from(bytes.subarray(bytes.byteLength - tail.byteLength)))).toBe(
      true,
    );
    expect(JSON.stringify(record).length).toBeLessThan(MAX_INLINE_STREAM_BYTES);
  });

  it("drops a single oversized line to digest-only rather than buffering it", () => {
    const huge = `{"schemaVersion":"claude-stream-json/1","seq":1,"type":"assistant","text":"${"y".repeat(
      MAX_INSPECTABLE_TAIL_BYTES,
    )}"}`;
    const record = recordOrThrow(utf8(`${huge}\n`));
    expect(record.events).toHaveLength(1);
    expect(record.events[0]?.lineBase64).toBeNull();
    expect(record.events[0]?.byteLength).toBe(huge.length);
    expect(record.events[0]?.lineSha256).toBe(sha256Hex(utf8(huge)));
  });
});

describe("record integrity", () => {
  it("is deep frozen and digest bound", () => {
    const record = recordOrThrow(golden("complete"));
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.events)).toBe(true);
    expect(Object.isFrozen(record.events[0])).toBe(true);
    expect(record.recordDigest).toMatch(/^[0-9a-f]{64}$/u);
    const again = recordOrThrow(golden("complete"));
    expect(again.recordDigest).toBe(record.recordDigest);
    const other = recordOrThrow(golden("cancelled"));
    expect(other.recordDigest).not.toBe(record.recordDigest);
  });

  it("refuses a capture with more records than it will hold, rather than keeping a prefix", () => {
    const overLimit = `${Array.from({ length: MAX_FRAMED_LINES + 1 }, () => "{}").join("\n")}\n`;
    const result = recordClaudeStream({
      rawBytes: utf8(overLimit),
      effect: EFFECT,
      acceptedSchemaVersions: CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_STREAM_EVENT_LIMIT_EXCEEDED");
  });

  it("refuses an unusable effect identity or an empty schema allowlist", () => {
    const badEffect = recordClaudeStream({
      rawBytes: golden("complete"),
      effect: { effectIntentId: "", attemptRef: "attempt-1", epoch: 3 },
      acceptedSchemaVersions: CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
    });
    expect(badEffect.ok).toBe(false);
    if (badEffect.ok) return;
    expect(badEffect.code).toBe("CLAUDE_STREAM_EFFECT_IDENTITY_INVALID");

    const noAllowlist = recordClaudeStream({
      rawBytes: golden("complete"),
      effect: EFFECT,
      acceptedSchemaVersions: [],
    });
    expect(noAllowlist.ok).toBe(false);
    if (noAllowlist.ok) return;
    expect(noAllowlist.code).toBe("CLAUDE_STREAM_SCHEMA_ALLOWLIST_EMPTY");
  });
});
