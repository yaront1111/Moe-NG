import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CODEX_GOLDEN_CASE_IDS,
  CODEX_GOLDEN_CORPUS_DATA_BEGIN,
  CODEX_GOLDEN_CORPUS_DATA_END,
  CODEX_GOLDEN_CORPUS_DIGEST,
  CODEX_GOLDEN_STREAMS,
  codexGoldenCorpusIdentity,
  codexGoldenStreamBytes,
} from "./codex-golden-streams.js";

describe("Codex golden stream corpus", () => {
  it("covers the closed development-only case list exactly once", () => {
    expect(CODEX_GOLDEN_CASE_IDS).toEqual([
      "cancelled", "complete", "crashed", "duplicated", "malformed",
      "reordered", "resumed", "truncated", "version-mismatched",
    ]);
    expect(CODEX_GOLDEN_STREAMS.map((stream) => stream.caseId).sort()).toEqual(
      [...CODEX_GOLDEN_CASE_IDS].sort(),
    );
    expect(CODEX_GOLDEN_STREAMS.every((stream) =>
      stream.label === "DEVELOPMENT_ONLY" && stream.confirmatory === "NOT_CONFIRMATORY",
    )).toBe(true);
  });

  it("pins every case to the raw decoded bytes", () => {
    for (const stream of CODEX_GOLDEN_STREAMS) {
      const bytes = codexGoldenStreamBytes(stream.caseId);
      expect(bytes.byteLength, stream.caseId).toBe(stream.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), stream.caseId).toBe(stream.sha256);
    }
  });

  it("retains literal CRLF bytes and returns fresh mutable copies", () => {
    const first = codexGoldenStreamBytes("complete");
    const second = codexGoldenStreamBytes("complete");
    let crlfPairs = 0;
    for (let index = 1; index < first.length; index += 1) {
      if (first[index - 1] === 0x0d && first[index] === 0x0a) crlfPairs += 1;
    }
    expect(crlfPairs).toBe(3);
    first[0] = 0;
    expect(second[0]).not.toBe(0);
  });

  it("pins the corpus identity and marker protocol", () => {
    expect(codexGoldenCorpusIdentity().digest).toBe(CODEX_GOLDEN_CORPUS_DIGEST);
    expect(CODEX_GOLDEN_CORPUS_DATA_BEGIN).toBe("moe-codex-golden-corpus/1 DATA BEGIN");
    expect(CODEX_GOLDEN_CORPUS_DATA_END).toBe("moe-codex-golden-corpus/1 DATA END");
  });

  it("keeps the test-only corpus off the Node runtime bridge surface", () => {
    expect(existsSync(new URL("./codex-golden-streams.js", import.meta.url))).toBe(false);
  });
});
