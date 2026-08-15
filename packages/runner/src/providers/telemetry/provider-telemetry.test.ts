/**
 * Contract and parser tests for the provider telemetry seam.
 *
 * Every vocabulary length below is a HAND-WRITTEN literal, never derived from
 * the array under test: a count read off the export would move with it and
 * police nothing. The sweeps further down assert their case tables by name
 * against those same frozen vocabularies, so a member added without a case
 * fails here rather than being silently skipped.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CLAUDE_STREAM_ANOMALIES } from "../claude/claude-stream-anomalies.js";
import type { ClaudeStreamEvidence } from "../claude/claude-launcher.js";
import {
  CLAUDE_MODEL_EVIDENCE_PATTERNS,
  CLAUDE_RESULT_SUBTYPES,
  CLAUDE_RESULT_TELEMETRY_VERSION,
  CLAUDE_TELEMETRY_ANOMALY_REFUSALS,
  parseClaudeResultTelemetry,
  type ClaudeResultTelemetry,
} from "./claude-result-telemetry.js";
import {
  PROVIDER_CONCURRENCY_FACTS,
  PROVIDER_COUNT_COVERAGE_CLASSES,
  PROVIDER_INFRASTRUCTURE_OUTCOMES,
  PROVIDER_TELEMETRY_CODES,
  PROVIDER_TELEMETRY_CONTRACT_VERSION,
  PROVIDER_TELEMETRY_LAYERS,
  PROVIDER_TERMINAL_OUTCOMES,
  countCoverage,
  knownCount,
  readCount,
  readText,
  snapshotRunRef,
  unknownFact,
  type ProviderQuantity,
} from "./provider-telemetry-contracts.js";

const ABSENT = unknownFact("TELEMETRY_USAGE_ABSENT", "TELEMETRY_RESULT");

describe("provider telemetry vocabularies", () => {
  it("pins every closed vocabulary by exact hand-written cardinality and membership", () => {
    expect(PROVIDER_TELEMETRY_CONTRACT_VERSION).toBe("moe-provider-telemetry/1");

    expect(PROVIDER_TERMINAL_OUTCOMES.length).toBe(6);
    expect([...PROVIDER_TERMINAL_OUTCOMES]).toEqual([
      "COMPLETED", "CANCELLED", "MAX_TURNS_EXHAUSTED", "ERROR_DURING_EXECUTION", "REFUSED",
      "UNKNOWN",
    ]);

    expect(PROVIDER_INFRASTRUCTURE_OUTCOMES.length).toBe(10);
    expect([...PROVIDER_INFRASTRUCTURE_OUTCOMES]).toEqual([
      "NONE", "PROCESS_SIGNALLED", "EXIT_UNOBSERVED", "CAPTURE_TRUNCATED", "CAPTURE_INCOMPLETE",
      "SCHEMA_UNSUPPORTED", "STREAM_ANOMALOUS", "LAUNCH_REFUSED", "LAUNCH_NOT_ATTEMPTED", "UNKNOWN",
    ]);

    expect(PROVIDER_COUNT_COVERAGE_CLASSES.length).toBe(3);
    expect([...PROVIDER_COUNT_COVERAGE_CLASSES]).toEqual(["COMPLETE", "PARTIAL", "UNKNOWN"]);

    expect(PROVIDER_CONCURRENCY_FACTS.length).toBe(2);
    expect([...PROVIDER_CONCURRENCY_FACTS])
      .toEqual(["DECLARED_CEILING_ONLY", "NO_CONCURRENCY_FACTS"]);

    expect(PROVIDER_TELEMETRY_CODES.length).toBe(15);
    expect(PROVIDER_TELEMETRY_LAYERS.length).toBe(5);
    expect([...PROVIDER_TELEMETRY_LAYERS]).toEqual([
      "TELEMETRY_INPUT", "TELEMETRY_LAUNCH", "TELEMETRY_CAPTURE", "TELEMETRY_SCHEMA",
      "TELEMETRY_RESULT",
    ]);
  });

  it("freezes every vocabulary so a consumer cannot widen it in place", () => {
    for (const vocabulary of [
      PROVIDER_TERMINAL_OUTCOMES, PROVIDER_INFRASTRUCTURE_OUTCOMES,
      PROVIDER_COUNT_COVERAGE_CLASSES, PROVIDER_CONCURRENCY_FACTS, PROVIDER_TELEMETRY_CODES,
      PROVIDER_TELEMETRY_LAYERS,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
    }
  });
});

describe("quantity discipline", () => {
  it("refuses to turn an absent, null, fractional or string field into a number", () => {
    const source = { present: 7, fractional: 1.5, negative: -1, text: "3", nulled: null };
    for (const key of ["missing", "fractional", "negative", "text", "nulled"]) {
      const fact = readCount(source, key, ABSENT);
      expect(fact.known, `${key} must stay unmeasured`).toBe(false);
      // Asserted directly, so a future `?? 0` fails HERE and not in a consumer.
      expect(fact).not.toBe(0);
      expect(fact.known === false ? fact.code : "known").toBe("TELEMETRY_USAGE_ABSENT");
      expect(fact.known === false ? fact.layer : "known").toBe("TELEMETRY_RESULT");
    }
    expect(readCount(source, "present", ABSENT)).toEqual({ known: true, value: 7 });
  });

  it("keeps an observed zero readable while an absent count stays unknown", () => {
    // The two must not collapse into each other in either direction: a provider
    // that really reported 0 cached tokens measured something.
    expect(readCount({ zero: 0 }, "zero", ABSENT)).toEqual({ known: true, value: 0 });
    expect(readCount(null, "zero", ABSENT)).toEqual(ABSENT);
    expect(knownCount(0)).toEqual({ known: true, value: 0 });
    expect(knownCount(1.5)).toBeNull();
    expect(knownCount(Number.NaN)).toBeNull();
  });

  it("reads bounded text and refuses anything else", () => {
    expect(readText({ model: "claude-opus-5-20260514" }, "model", ABSENT))
      .toEqual({ known: true, value: "claude-opus-5-20260514" });
    expect(readText({ model: "" }, "model", ABSENT)).toEqual(ABSENT);
    expect(readText({ model: "has space" }, "model", ABSENT)).toEqual(ABSENT);
    expect(readText({ model: 5 }, "model", ABSENT)).toEqual(ABSENT);
    expect(readText(null, "model", ABSENT)).toEqual(ABSENT);
  });
});

describe("count coverage", () => {
  const known = (value: number): ProviderQuantity => {
    const fact = knownCount(value);
    if (fact === null) throw new Error(`fixture ${value} is not a countable quantity`);
    return fact;
  };

  /**
   * The sweep is the DoD's count-coverage arm: every class must be produced by
   * the production classifier, and the table asserts its own exact size before
   * iterating so a table that generated nothing could not pass.
   */
  const CASES: readonly (readonly [string, readonly ProviderQuantity[], string])[] = [
    ["all measured", [known(1), known(0)], "COMPLETE"],
    ["one measured, one absent", [known(1), ABSENT], "PARTIAL"],
    ["none measured", [ABSENT, ABSENT], "UNKNOWN"],
    ["nothing to measure", [], "UNKNOWN"],
  ];

  it("covers every declared coverage class with a non-empty case table", () => {
    expect(CASES.length).toBe(4);
    expect([...new Set(CASES.map(([, , expected]) => expected))].sort())
      .toEqual([...PROVIDER_COUNT_COVERAGE_CLASSES].sort());
  });

  it.each(CASES)("classifies %s as %s", (_label, facts, expected) => {
    expect(countCoverage(facts)).toBe(expected);
  });
});

describe("run reference", () => {
  const REF = {
    provider: "claude", runRef: "run:1", effectIntentId: "intent:1", attemptRef: "attempt:1",
    epoch: 3,
  };

  it("adopts an exact reference and refuses every malformed variant totally", () => {
    expect(snapshotRunRef(REF)).toEqual(REF);
    const REJECTED: readonly (readonly [string, unknown])[] = [
      ["not an object", "run:1"],
      ["null", null],
      ["foreign provider", { ...REF, provider: "codex" }],
      ["empty run ref", { ...REF, runRef: "" }],
      ["missing effect", { ...REF, effectIntentId: undefined }],
      ["whitespace attempt", { ...REF, attemptRef: "attempt 1" }],
      ["fractional epoch", { ...REF, epoch: 1.5 }],
      ["negative epoch", { ...REF, epoch: -1 }],
    ];
    expect(REJECTED.length).toBe(8);
    expect(REJECTED.filter(([, value]) => snapshotRunRef(value) !== null)).toEqual([]);
  });
});

/**
 * Parser cases. Every capture below is built by the SAME helper the launcher's
 * own `captureStream` would produce — base64 of the exact bytes, the sha256 over
 * all of them — so an evidence record that disagrees with its digest is a
 * deliberate case rather than an accident of the fixture.
 */
const RUN_REF = {
  provider: "claude", runRef: "run:telemetry:1", effectIntentId: "intent:1",
  attemptRef: "attempt:1", epoch: 3,
} as const;

const line = (record: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schemaVersion: "claude-stream-json/1", ...record })}\n`;

const initLine = (seq: number, model: string): string =>
  line({ seq, type: "system", subtype: "init", model });

const resultLine = (seq: number, record: Readonly<Record<string, unknown>> = {}): string =>
  line({ seq, type: "result", subtype: "success", num_turns: 3,
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5 },
    ...record });

function evidenceOf(
  text: string, overrides: Partial<ClaudeStreamEvidence> = {},
): ClaudeStreamEvidence {
  const bytes = Buffer.from(text, "utf8");
  return {
    capturedBase64: bytes.toString("base64"), tailBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: false, complete: true, ...overrides,
  };
}

const parsed = (text: string, overrides: Partial<ClaudeStreamEvidence> = {}) =>
  parseClaudeResultTelemetry({ providerRunRef: RUN_REF, stdout: evidenceOf(text, overrides) });

function telemetryOf(text: string): ClaudeResultTelemetry {
  const verdict = parsed(text);
  if (!verdict.ok) throw new Error(`fixture refused: ${verdict.code}/${verdict.layer}`);
  return verdict.telemetry;
}

describe("claude structured result parser", () => {
  const CLEAN = `${initLine(1, "claude-opus-5-20260514")}${resultLine(2)}`;

  it("binds the pinned parser version, run ref, sequence and raw receipt digest", () => {
    const telemetry = telemetryOf(CLEAN);
    expect(telemetry.parserVersion).toBe("moe-claude-result-telemetry/1");
    expect(CLAUDE_RESULT_TELEMETRY_VERSION).toBe("moe-claude-result-telemetry/1");
    expect(telemetry.providerRunRef).toEqual(RUN_REF);
    expect(telemetry.sequence).toEqual({ known: true, value: 2 });
    expect(telemetry.recordCount).toBe(2);
    // Reused verbatim rather than re-hashed: the launcher's digest already
    // covers every captured byte, including bytes beyond the inline bound.
    expect(telemetry.rawReceiptDigest).toBe(evidenceOf(CLEAN).sha256);
  });

  it("reads exact token and step observations, with an observed zero kept observed", () => {
    const telemetry = telemetryOf(CLEAN);
    expect(telemetry.tokens).toEqual({
      inputTokens: { known: true, value: 11 }, outputTokens: { known: true, value: 7 },
      cacheCreationInputTokens: { known: true, value: 0 },
      cacheReadInputTokens: { known: true, value: 5 }, coverage: "COMPLETE",
    });
    expect(telemetry.steps).toEqual({ turns: { known: true, value: 3 }, coverage: "COMPLETE" });
    expect(telemetry.terminal).toBe("COMPLETED");
    expect(telemetry.infrastructure).toBe("NONE");
  });

  it("reads observed model evidence out of the provider's own init record", () => {
    expect(telemetryOf(CLEAN).observedModel).toEqual({
      modelId: { known: true, value: "claude-opus-5-20260514" },
      snapshotKind: "DATED_SNAPSHOT", snapshotEvidence: { known: true, value: "20260514" },
    });
    expect(telemetryOf(`${initLine(1, "anthropic.claude-opus-5-v1:0")}${resultLine(2)}`)
      .observedModel.snapshotKind).toBe("BUILD_STAMP");
    // An id carrying neither form leaves the KIND unknown while the id itself
    // stays observed: absence of evidence never becomes evidence of a kind.
    const plain = telemetryOf(`${initLine(1, "claude-opus-5")}${resultLine(2)}`).observedModel;
    expect(plain.modelId).toEqual({ known: true, value: "claude-opus-5" });
    expect(plain.snapshotKind).toBe("UNKNOWN");
    expect(plain.snapshotEvidence)
      .toEqual({ known: false, code: "TELEMETRY_MODEL_ABSENT", layer: "TELEMETRY_RESULT" });
    expect(Object.keys(CLAUDE_MODEL_EVIDENCE_PATTERNS).sort())
      .toEqual(["BUILD_STAMP", "DATED_SNAPSHOT"]);
  });

  it("refuses a run whose init records disagree about the model", () => {
    const observed = telemetryOf(
      `${initLine(1, "claude-opus-5-20260514")}${initLine(2, "claude-sonnet-5-20260514")}` +
        `${resultLine(3)}`,
    ).observedModel;
    expect(observed.modelId)
      .toEqual({ known: false, code: "TELEMETRY_MODEL_AMBIGUOUS", layer: "TELEMETRY_RESULT" });
    expect(observed.snapshotKind).toBe("UNKNOWN");
  });

  it("maps only the frozen supported subtypes and leaves any other UNKNOWN", () => {
    const SUPPORTED = Object.entries(CLAUDE_RESULT_SUBTYPES);
    expect(SUPPORTED.length).toBe(4);
    for (const [subtype, expected] of SUPPORTED) {
      expect(telemetryOf(resultLine(1, { subtype })).terminal, subtype).toBe(expected);
    }
    expect(telemetryOf(resultLine(1, { subtype: "error_unmapped" })).terminal).toBe("UNKNOWN");
    // A prototype-borrowed key must not resolve through the frozen map.
    expect(telemetryOf(resultLine(1, { subtype: "constructor" })).terminal).toBe("UNKNOWN");
  });

  it("maps every landed stream anomaly to an exact refusal, with none left over", () => {
    expect(CLAUDE_TELEMETRY_ANOMALY_REFUSALS.length).toBe(8);
    expect(CLAUDE_TELEMETRY_ANOMALY_REFUSALS.map(([anomaly]) => anomaly).sort())
      .toEqual([...CLAUDE_STREAM_ANOMALIES].sort());
  });
});
