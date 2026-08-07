import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_GOLDEN_CASE_IDS,
  CLAUDE_GOLDEN_CORPUS_DATA_END,
  CLAUDE_GOLDEN_CORPUS_DATA_BEGIN,
  CLAUDE_GOLDEN_CORPUS_DIGEST,
  CLAUDE_GOLDEN_CORPUS_VERSION,
  CLAUDE_GOLDEN_STREAMS,
  claudeGoldenCorpusIdentity,
  claudeGoldenStream,
  claudeGoldenStreamBytes,
} from "./claude-golden-streams.js";

/**
 * The closed corpus the design names, written out longhand rather than derived
 * from the module under test. A corpus that defines its own completeness target
 * can never fail this assertion.
 */
const DESIGN_CASE_IDS = [
  "cancelled",
  "complete",
  "crashed",
  "duplicated",
  "malformed",
  "reordered",
  "resumed",
  "truncated",
  "version-mismatched",
] as const;

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("./claude-golden-streams.ts", import.meta.url)),
  "utf8",
);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("claude golden stream corpus", () => {
  it("covers exactly the closed design corpus", () => {
    expect([...CLAUDE_GOLDEN_CASE_IDS].sort()).toEqual([...DESIGN_CASE_IDS].sort());
    expect(CLAUDE_GOLDEN_STREAMS.map((stream) => stream.caseId).sort()).toEqual(
      [...DESIGN_CASE_IDS].sort(),
    );
    expect(CLAUDE_GOLDEN_STREAMS).toHaveLength(DESIGN_CASE_IDS.length);
  });

  it("labels every fixture DEVELOPMENT_ONLY and NOT_CONFIRMATORY", () => {
    for (const stream of CLAUDE_GOLDEN_STREAMS) {
      expect(`${stream.caseId}:${stream.label}:${stream.confirmatory}`).toBe(
        `${stream.caseId}:DEVELOPMENT_ONLY:NOT_CONFIRMATORY`,
      );
      expect(stream.expectation.length).toBeGreaterThan(0);
      expect(Object.isFrozen(stream)).toBe(true);
    }
    expect(Object.isFrozen(CLAUDE_GOLDEN_STREAMS)).toBe(true);
  });

  it("round-trips every payload byte for byte against its pinned digest", () => {
    for (const stream of CLAUDE_GOLDEN_STREAMS) {
      const bytes = claudeGoldenStreamBytes(stream.caseId);
      expect(bytes.byteLength).toBe(stream.byteLength);
      expect(Buffer.from(bytes).toString("base64")).toBe(stream.rawBase64);
      expect(claudeGoldenStreamBytes(stream.caseId)).toEqual(bytes);
    }
  });

  it("preserves literal CRLF bytes that a committed text fixture would lose", () => {
    const bytes = claudeGoldenStreamBytes("complete");
    let carriageReturns = 0;
    for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
      if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
        carriageReturns += 1;
      }
    }
    expect(carriageReturns).toBe(3);
    expect(claudeGoldenStreamBytes("cancelled").includes(0x0d)).toBe(false);
  });

  it("pins a corpus digest that is stable across repeated builds", () => {
    expect(claudeGoldenCorpusIdentity().digest).toBe(CLAUDE_GOLDEN_CORPUS_DIGEST);
    expect(claudeGoldenCorpusIdentity().digest).toBe(claudeGoldenCorpusIdentity().digest);
    expect(CLAUDE_GOLDEN_CORPUS_VERSION).toBe("moe-claude-golden-corpus/1");
  });

  it("keeps the marker-delimited data block extractable by an out-of-package reader", () => {
    expect(occurrences(MODULE_SOURCE, CLAUDE_GOLDEN_CORPUS_DATA_BEGIN)).toBe(2);
    expect(occurrences(MODULE_SOURCE, CLAUDE_GOLDEN_CORPUS_DATA_END)).toBe(2);
    const start = MODULE_SOURCE.lastIndexOf(CLAUDE_GOLDEN_CORPUS_DATA_BEGIN);
    const end = MODULE_SOURCE.lastIndexOf(CLAUDE_GOLDEN_CORPUS_DATA_END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = MODULE_SOURCE.slice(start + CLAUDE_GOLDEN_CORPUS_DATA_BEGIN.length, end);
    const jsonStart = block.indexOf("`");
    const jsonEnd = block.lastIndexOf("`");
    const parsed: unknown = JSON.parse(block.slice(jsonStart + 1, jsonEnd));
    expect((parsed as { corpusVersion: string }).corpusVersion).toBe(CLAUDE_GOLDEN_CORPUS_VERSION);
    expect((parsed as { cases: readonly unknown[] }).cases).toHaveLength(DESIGN_CASE_IDS.length);
  });

  it("rejects an unknown case id instead of returning an empty stream", () => {
    expect(() => claudeGoldenStream("nope" as never)).toThrow(/unknown claude golden case/u);
    expect(() => claudeGoldenStreamBytes("nope" as never)).toThrow(/unknown claude golden case/u);
  });
});
