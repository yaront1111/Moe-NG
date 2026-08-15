/**
 * Usage-normalization tests. Two surfaces, both production:
 *
 * 1. `normalizeProviderUsage`, driven END TO END through the real
 *    `launchClaudeWithTelemetry` with the launcher's own fixture ports — never a
 *    hand-built handoff, except where a branch is structurally required but not
 *    reachable through the launcher, which is labelled where it happens.
 * 2. `normalizeUsageMeasurement`, the landed @moe/scheduler AUTHORITY. The
 *    source/coverage matrix, the pricebook rule and the sequence rules are
 *    asserted against it rather than against a copy, because a copy is a second
 *    authority that can silently disagree with the first.
 *
 * ONE CORRECTION TO THE PLAN'S PHRASING, made against the landed authority: the
 * plan says "only COMPLETE may carry a PricebookBinding". The landed rule is
 * NARROWER on one axis and wider on another — only `DERIVED_LIST_PRICE` may
 * carry one, at COMPLETE or PARTIAL, and it MUST carry one. This seam derives no
 * price at all, so it never emits that source and therefore never emits a
 * binding; the assertions below pin the landed rule and the production silence.
 *
 * Every refusal narrows on `layer` BEFORE reading `code`: the CONTRACT arm is
 * typed `BudgetIssueCode` and the MEASUREMENT arm `MeasurementIssueCode`, so
 * reading the code first type-confuses the two arms.
 */
import { describe, expect, it } from "vitest";

import {
  BUDGET_MEASUREMENT_COVERAGES, BUDGET_MEASUREMENT_SOURCES, MEASUREMENT_ISSUE_LAYERS,
  SUPPORTED_SOURCE_PARSER_VERSIONS, normalizeUsageMeasurement,
  type BudgetMeasurementCoverage, type BudgetMeasurementSource, type LayeredIssue,
  type NormalizedMeasurement, type PricebookBinding, type UsageMeasurementRecord,
} from "@moe/scheduler";

import {
  boundaryHarness, dependencies, request, selectionWith,
} from "../claude/claude-launcher-test-fixtures.js";
import {
  launchClaudeWithTelemetry, type ClaudeTelemetryHandoff,
} from "./claude-telemetry-launch.js";
import {
  PROVIDER_USAGE_METERS, type ProviderUsageResult,
} from "./provider-usage-contracts.js";
import { normalizeProviderUsage } from "./provider-usage-normalization.js";

const RUN_REF = {
  provider: "claude", runRef: "run:usage:1", effectIntentId: "intent:1",
  attemptRef: "attempt:1", epoch: 3,
} as const;
const LIMITS = { stdoutBytes: 65_536, stderrBytes: 65_536, tailBytes: 4_096, timeoutMs: 1_000 };
const METERS = Object.values(PROVIDER_USAGE_METERS);

const line = (record: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schemaVersion: "claude-stream-json/1", ...record })}\n`;
const usageOf = (usage: Readonly<Record<string, number>>, seq = 2, turns = 3): string =>
  line({ seq, type: "result", subtype: "success", num_turns: turns, usage });
const INIT = line({ seq: 1, type: "system", subtype: "init", model: "claude-opus-5-20260514" });
const COMPLETE_STREAM = `${INIT}${usageOf({ input_tokens: 11, output_tokens: 7,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 5 })}`;
/** Two of four counts present: the PARTIAL arm, and never a summed substitute. */
const PARTIAL_STREAM = `${INIT}${usageOf({ input_tokens: 4, cache_creation_input_tokens: 1 })}`;
/** A terminal record that reports its sequence and NO usage block: fully blind counts. */
const NO_USAGE_STREAM = `${INIT}${line({ seq: 2, type: "result", subtype: "success",
  num_turns: 3 })}`;

async function handoffOf(options: {
  readonly stdout?: string; readonly providerRunRef?: unknown;
  readonly overrides?: Parameters<typeof request>[0];
} = {}): Promise<ClaudeTelemetryHandoff> {
  const harness = boundaryHarness({
    stdout: Buffer.from(options.stdout ?? COMPLETE_STREAM, "utf8"),
  });
  const result = await launchClaudeWithTelemetry({
    providerRunRef: options.providerRunRef ?? RUN_REF,
    request: request({ limits: LIMITS, ...options.overrides }),
    options: { platform: "win32", deps: dependencies(harness, []) },
  });
  if (!result.ok) throw new Error(`telemetry launch refused: ${result.code}/${result.layer}`);
  return result.handoff;
}
async function usageOfRun(options: Parameters<typeof handoffOf>[0] = {},
  priors?: readonly NormalizedMeasurement[]): Promise<ProviderUsageResult> {
  return normalizeProviderUsage(await handoffOf(options), { priors: priors ?? [] });
}
const measured = (result: ProviderUsageResult): readonly NormalizedMeasurement[] => {
  if (!result.ok) throw new Error(`usage refused: ${result.code}/${result.layer}`);
  return result.measurements;
};
/** Narrows on LAYER first; the code is only read inside the narrowed arm. */
const measurementCodes = (issues: readonly LayeredIssue[]): readonly string[] =>
  issues.filter((issue) => issue.layer === "MEASUREMENT").map((issue) => issue.code);
const contractCodes = (issues: readonly LayeredIssue[]): readonly string[] =>
  issues.filter((issue) => issue.layer === "CONTRACT").map((issue) => issue.code);

describe("normalizeProviderUsage — production path", () => {
  it("normalizes one measurement per token meter through the scheduler authority", async () => {
    const result = await usageOfRun();
    if (!result.ok) throw new Error(`usage refused: ${result.code}/${result.layer}`);
    expect(METERS.length).toBe(4);
    expect(result.measurements.map((entry) => entry.measurement.meter)).toEqual(METERS);
    expect(result.coverage).toBe("COMPLETE");
    expect(result.source).toBe("PROVIDER_REPORTED_COMPLETE");
    const quantities = result.measurements.map((entry) => entry.measurement.quantity);
    // The observed 0 stays a MEASURED zero; that is the fact `null` is kept apart from.
    expect(quantities).toEqual([11, 7, 0, 5]);
    for (const entry of result.measurements) {
      expect(entry.measurement.coverage).toBe("COMPLETE");
      expect(entry.measurement.source).toBe("PROVIDER_REPORTED_COMPLETE");
      expect(SUPPORTED_SOURCE_PARSER_VERSIONS)
        .toContain(entry.measurement.sourceParserVersion);
      expect(entry.measurement.rawReceiptDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.measurement.sequence).toBe(2);
      expect(entry.pricebookBinding).toBeNull();
      // `identity` is computed by the normalizer; a hand-built record has none.
      expect(entry.identity).toContain(entry.measurement.meter);
    }
  });

  it("binds the observed interval and the run identity from the launch, never a placeholder",
    async () => {
      const handoff = await handoffOf();
      const [first] = measured(await usageOfRun());
      expect(handoff.launch.startedAt).not.toBeNull();
      expect(first?.measurement.observedInterval)
        .toEqual({ startRef: handoff.launch.startedAt, endRef: handoff.launch.completedAt });
      expect(first?.measurement.providerRunRef).toContain(RUN_REF.runRef);
      expect(first?.measurement.providerRunRef).toContain(RUN_REF.attemptRef);
    });

  it("reports an UNKNOWN token fact as null and NEVER as zero", async () => {
    // The terminal record arrived and named its sequence, so the run IS
    // measurable — it simply reports no usage block. Every count is therefore
    // unmeasured while every other fact the authority needs is present.
    const result = await usageOfRun({ stdout: NO_USAGE_STREAM });
    if (!result.ok) throw new Error(`usage refused: ${result.code}/${result.layer}`);
    expect(result.coverage).toBe("UNKNOWN");
    expect(result.source).toBe("UNKNOWN");
    for (const entry of result.measurements) {
      expect(entry.measurement.quantity).toBeNull();
      expect(entry.measurement.quantity).not.toBe(0);
      expect(entry.measurement.coverage).toBe("UNKNOWN");
      expect(entry.measurement.source).toBe("UNKNOWN");
      expect(entry.pricebookBinding).toBeNull();
    }
    // A `?? 0` anywhere in the mapping fails here rather than inside a consumer.
    expect(JSON.stringify(result.measurements)).not.toContain("\"quantity\":0");
    expect(result.costBasis).toEqual({
      basis: "UNPRICED", coverage: "UNKNOWN", source: "UNKNOWN",
      pricedMeters: [], pricebookBinding: null, spendMicros: null,
      unpricedReason: "COVERAGE_UNKNOWN",
    });
  });

  it("keeps a partially observed run PARTIAL, unpriced, and unmixed", async () => {
    const result = await usageOfRun({ stdout: PARTIAL_STREAM });
    if (!result.ok) throw new Error(`usage refused: ${result.code}/${result.layer}`);
    expect(result.coverage).toBe("PARTIAL");
    expect(result.source).toBe("PROVIDER_REPORTED_PARTIAL");
    const byMeter = new Map(result.measurements.map((e) => [e.measurement.meter, e.measurement]));
    expect(byMeter.get(PROVIDER_USAGE_METERS.inputTokens)?.quantity).toBe(4);
    expect(byMeter.get(PROVIDER_USAGE_METERS.inputTokens)?.coverage).toBe("PARTIAL");
    expect(byMeter.get(PROVIDER_USAGE_METERS.inputTokens)?.source)
      .toBe("PROVIDER_REPORTED_PARTIAL");
    expect(byMeter.get(PROVIDER_USAGE_METERS.outputTokens)?.quantity).toBeNull();
    expect(byMeter.get(PROVIDER_USAGE_METERS.outputTokens)?.coverage).toBe("UNKNOWN");
    expect(byMeter.get(PROVIDER_USAGE_METERS.outputTokens)?.source).toBe("UNKNOWN");
    expect(result.measurements.every((entry) => entry.pricebookBinding === null)).toBe(true);
    expect(result.costBasis.unpricedReason).toBe("COVERAGE_INCOMPLETE");
    expect(result.costBasis.spendMicros).toBeNull();
    expect(result.costBasis.pricedMeters).toEqual([
      PROVIDER_USAGE_METERS.inputTokens, PROVIDER_USAGE_METERS.cacheCreationInputTokens,
    ]);
  });

  it("publishes a cost basis with no spend even when every count is COMPLETE", async () => {
    const result = await usageOfRun();
    if (!result.ok) throw new Error(`usage refused: ${result.code}/${result.layer}`);
    expect(result.costBasis.basis).toBe("PROVIDER_REPORTED_TOKENS");
    expect(result.costBasis.pricebookBinding).toBeNull();
    expect(result.costBasis.spendMicros).toBeNull();
    expect(result.costBasis.unpricedReason).toBe("NO_PRICEBOOK_ON_THIS_SEAM");
    // No micros FIGURE anywhere, even on the arm where every count is measured.
    expect(JSON.stringify(result.costBasis)).not.toMatch(/Micros":\s*-?\d/u);
  });

  it("refuses a run whose interval was never observed, at its own layer and code", async () => {
    // The selection gate refuses this launch, so no process ran and no interval
    // exists; INTERVAL is the FIRST guard, ahead of sequence and receipt.
    const result = await usageOfRun({
      overrides: { launchSelection: selectionWith({ selectedModelId: "claude-haiku-4-5" }) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unlaunched run produced a usage measurement");
    expect(result.layer).toBe("USAGE_INPUT");
    expect(result.code).toBe("PROVIDER_USAGE_INTERVAL_UNOBSERVED");
    expect(result.upstream).toEqual([]);
  });

  /**
   * A run with no observation sequence cannot be placed in a monotonic stream,
   * so it yields NO measurement rather than an unordered one. Both arms below
   * reach that guard from different directions: a capture holding no terminal
   * record at all, and one the launcher's own bound cut short.
   */
  const SEQUENCELESS_CASES: readonly (readonly [string, Parameters<typeof handoffOf>[0]])[] = [
    ["a capture holding no terminal record", { stdout: INIT }],
    ["a capture cut at the launcher's bound",
      { overrides: { limits: { ...LIMITS, stdoutBytes: 16 } } }],
  ];

  it("pins a non-empty sequenceless table", () => {
    expect(SEQUENCELESS_CASES.length).toBe(2);
  });

  it.each(SEQUENCELESS_CASES)("refuses %s, which carries no sequence", async (_label, options) => {
    const result = await usageOfRun(options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a run with no sequence produced a measurement");
    expect(result.layer).toBe("USAGE_INPUT");
    expect(result.code).toBe("PROVIDER_USAGE_SEQUENCE_UNKNOWN");
    // Nothing was measured, so no count could have been summed from a prefix.
    expect(JSON.stringify(result)).not.toContain("quantity");
  });

  it("refuses an unreadable stdout receipt rather than substituting a placeholder", async () => {
    // Not reachable through the launcher today — an OBSERVED run always yields a
    // sha256 receipt — so this defensive branch is driven by taking a REAL
    // production handoff and removing exactly that one fact.
    const real = await handoffOf();
    const blinded: ClaudeTelemetryHandoff = {
      ...real,
      stdoutReceiptDigest: { known: false, code: "TELEMETRY_CAPTURE_UNDECODABLE",
        layer: "TELEMETRY_CAPTURE" },
    };
    const result = normalizeProviderUsage(blinded, { priors: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unreadable receipt produced a measurement");
    expect(result.layer).toBe("USAGE_INPUT");
    expect(result.code).toBe("PROVIDER_USAGE_RECEIPT_UNKNOWN");
  });

  /**
   * The context is the one input a CALLER supplies, so every hostile shape must
   * come back as a typed refusal rather than a throw. A revoked proxy is listed
   * by name because `Array.isArray` THROWS on one, and an accessor is listed
   * because it is the caller's own code running inside the read that decides
   * whether to trust the caller.
   */
  const HOSTILE_CONTEXTS: readonly (readonly [string, () => unknown])[] = [
    ["a prior that is not a normalizer-issued record",
      () => ({ priors: [{ identity: 1 }] })],
    ["a prior carrying no measurement", () => ({ priors: [{ identity: "x" }] })],
    ["a sparse prior array", () => ({ priors: Array.from({ length: 2 }) })],
    ["priors that are not an array at all", () => ({ priors: "provider.input_tokens" })],
    ["a context with no own priors property", () => ({})],
    ["an accessor that runs caller code", () => Object.defineProperty({}, "priors", {
      get: () => { throw new Error("accessor ran"); }, configurable: true })],
    ["a revoked proxy as the context", () => {
      const revocable = Proxy.revocable({ priors: [] }, {});
      revocable.revoke();
      return revocable.proxy;
    }],
    ["a revoked proxy as the priors array", () => {
      const revocable = Proxy.revocable([] as unknown[], {});
      revocable.revoke();
      return { priors: revocable.proxy };
    }],
  ];

  it("pins a non-empty hostile-context table", () => {
    expect(HOSTILE_CONTEXTS.length).toBe(8);
  });

  it.each(HOSTILE_CONTEXTS)("refuses %s without throwing", async (_label, make) => {
    const handoff = await handoffOf();
    const result = normalizeProviderUsage(
      handoff, make() as unknown as Parameters<typeof normalizeProviderUsage>[1]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a hostile context was accepted");
    expect(result.layer).toBe("USAGE_INPUT");
    expect(result.code).toBe("PROVIDER_USAGE_PRIOR_UNREADABLE");
  });

  it("still accepts the ordinary empty-priors context", async () => {
    const measurements = measured(await usageOfRun());
    expect(measurements.length).toBe(4);
  });
});

describe("normalizeProviderUsage — redelivery and stream monotonicity", () => {
  it("returns the REFERENCE-IDENTICAL prior record on an identical redelivery", async () => {
    const first = measured(await usageOfRun());
    const again = measured(await usageOfRun({}, first));
    expect(again.length).toBe(4);
    for (const [index, entry] of again.entries()) {
      expect(entry).toBe(first[index]);
    }
  });

  const REDELIVERY_CASES: readonly (readonly [string, Parameters<typeof handoffOf>[0], string])[] = [
    ["the same sequence carrying different bytes",
      { stdout: `${INIT}${usageOf({ input_tokens: 12, output_tokens: 7,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 5 })}` },
      "BUDGET_OBSERVATION_IDENTITY_CONFLICT"],
    ["a sequence that rewinds behind the prior",
      { stdout: usageOf({ input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5 }, 1) },
      "BUDGET_OBSERVATION_SEQUENCE_REGRESSION"],
    ["another provider run's stream", { providerRunRef: { ...RUN_REF, runRef: "run:usage:2" } },
      "BUDGET_OBSERVATION_STREAM_MISMATCH"],
  ];

  it("pins a non-empty redelivery table", () => {
    expect(REDELIVERY_CASES.length).toBe(3);
  });

  it.each(REDELIVERY_CASES)("refuses %s", async (_label, options, code) => {
    const priors = measured(await usageOfRun());
    const result = await usageOfRun(options, priors);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`a non-monotonic redelivery was accepted: ${code}`);
    expect(result.layer).toBe("USAGE_AUTHORITY");
    expect(result.code).toBe("PROVIDER_USAGE_AUTHORITY_REFUSED");
    // The scheduler's own layer and code travel verbatim, narrowed on layer.
    expect(measurementCodes(result.upstream)).toContain(code);
  });

  it("refuses a sequence that skips the observation the prior expects", async () => {
    const priors = measured(await usageOfRun({ stdout: usageOf({ input_tokens: 1,
      output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, 1, 1) }));
    expect(priors[0]?.measurement.sequence).toBe(1);
    const skipped = `${INIT}${line({ seq: 2, type: "assistant",
      message: { model: "claude-opus-5-20260514" } })}${usageOf({ input_tokens: 11,
      output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 }, 3)}`;
    const result = await usageOfRun({ stdout: skipped }, priors);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a skipped sequence was accepted");
    expect(measurementCodes(result.upstream)).toContain("BUDGET_OBSERVATION_SEQUENCE_GAP");
  });
});

/**
 * The AUTHORITY sweep. Every case is generated from the two frozen scheduler
 * vocabularies and asserts its own exact non-zero cardinality first — a sweep
 * that silently produced zero cases would otherwise pass while testing nothing.
 */
const PRICEBOOK: PricebookBinding = Object.freeze({
  pricebookRevisionRef: "pricebook:rev-7", unitPriceMicros: 250, pricedAtRef: "priced:2026-08-15",
});
const measurementFor = (
  source: BudgetMeasurementSource, coverage: BudgetMeasurementCoverage,
): UsageMeasurementRecord => Object.freeze({
  meter: PROVIDER_USAGE_METERS.inputTokens,
  quantity: coverage === "UNKNOWN" ? null : 11,
  coverage, source, providerRunRef: "run:sweep:1",
  sourceParserVersion: SUPPORTED_SOURCE_PARSER_VERSIONS[0], sequence: 1,
  rawReceiptDigest: "a".repeat(64),
  observedInterval: { startRef: "start:1", endRef: "end:1" },
});
const MATRIX: readonly (readonly [BudgetMeasurementSource, BudgetMeasurementCoverage])[] =
  BUDGET_MEASUREMENT_SOURCES.flatMap((source) =>
    BUDGET_MEASUREMENT_COVERAGES.map((coverage) => [source, coverage] as const));
/** Exactly what the landed SOURCE_COVERAGES table permits, transcribed by hand. */
const ALLOWED: Readonly<Record<BudgetMeasurementSource, readonly BudgetMeasurementCoverage[]>> = {
  PROVIDER_REPORTED_COMPLETE: ["COMPLETE"], PROVIDER_REPORTED_PARTIAL: ["PARTIAL"],
  DERIVED_LIST_PRICE: ["COMPLETE", "PARTIAL"], SUBSCRIPTION_QUOTA: ["COMPLETE", "PARTIAL"],
  ACTUAL_BILLED: ["COMPLETE", "PARTIAL"], UNKNOWN: ["UNKNOWN"],
};

describe("scheduler measurement authority", () => {
  it("generates the full 6 x 3 matrix and covers both vocabularies by name", () => {
    expect(BUDGET_MEASUREMENT_SOURCES.length).toBe(6);
    expect(BUDGET_MEASUREMENT_COVERAGES.length).toBe(3);
    expect(MATRIX.length).toBe(18);
    expect([...new Set(MATRIX.map(([source]) => source))]).toEqual([...BUDGET_MEASUREMENT_SOURCES]);
    expect([...new Set(MATRIX.map(([, coverage]) => coverage))])
      .toEqual([...BUDGET_MEASUREMENT_COVERAGES]);
    expect(MATRIX.filter(([source, coverage]) => ALLOWED[source].includes(coverage)).length).toBe(9);
    expect(MATRIX.filter(([source, coverage]) => !ALLOWED[source].includes(coverage)).length)
      .toBe(9);
    expect(MEASUREMENT_ISSUE_LAYERS).toEqual(["CONTRACT", "MEASUREMENT"]);
  });

  it.each(MATRIX)("judges source %s at coverage %s", (source, coverage) => {
    // A binding is attached to exactly the one source that is REQUIRED to carry
    // one; every other source carrying one is an uncorrelated billing claim.
    const derived = source === "DERIVED_LIST_PRICE";
    const verdict = normalizeUsageMeasurement({
      measurement: measurementFor(source, coverage),
      pricebookBinding: derived ? PRICEBOOK : null, truncated: false,
    });
    if (ALLOWED[source].includes(coverage)) {
      if (!verdict.ok) throw new Error(`${source}/${coverage} refused`);
      expect(verdict.record.pricebookBinding).toEqual(derived ? PRICEBOOK : null);
      expect(verdict.record.measurement.quantity).toBe(coverage === "UNKNOWN" ? null : 11);
      return;
    }
    if (verdict.ok) throw new Error(`${source}/${coverage} was accepted`);
    expect(measurementCodes(verdict.issues))
      .toContain("BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
  });

  it("refuses a pricebook binding on a source that did not derive it", () => {
    const verdict = normalizeUsageMeasurement({
      measurement: measurementFor("PROVIDER_REPORTED_COMPLETE", "COMPLETE"),
      pricebookBinding: PRICEBOOK, truncated: false,
    });
    if (verdict.ok) throw new Error("a provider-reported row acquired a price");
    expect(measurementCodes(verdict.issues))
      .toEqual(["BUDGET_OBSERVATION_UNCORRELATED_BILLING_CLAIM"]);
  });

  it("refuses a COMPLETE claim over a truncated receipt", () => {
    const verdict = normalizeUsageMeasurement({
      measurement: measurementFor("PROVIDER_REPORTED_COMPLETE", "COMPLETE"),
      pricebookBinding: null, truncated: true,
    });
    if (verdict.ok) throw new Error("a truncated receipt claimed COMPLETE coverage");
    expect(measurementCodes(verdict.issues))
      .toEqual(["BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM"]);
  });

  it("refuses a parser version outside the supported set", () => {
    expect(SUPPORTED_SOURCE_PARSER_VERSIONS).toEqual([1, 2]);
    const verdict = normalizeUsageMeasurement({
      measurement: { ...measurementFor("PROVIDER_REPORTED_COMPLETE", "COMPLETE"),
        sourceParserVersion: 3 },
      pricebookBinding: null, truncated: false,
    });
    if (verdict.ok) throw new Error("an unreadable parser version claimed COMPLETE coverage");
    expect(measurementCodes(verdict.issues))
      .toEqual(["BUDGET_OBSERVATION_PARSER_VERSION_UNSUPPORTED"]);
  });

  it("refuses an envelope carrying any key beyond the exact three", () => {
    const verdict = normalizeUsageMeasurement({
      measurement: measurementFor("UNKNOWN", "UNKNOWN"), pricebookBinding: null,
      truncated: false, costUsd: 1,
    });
    if (verdict.ok) throw new Error("a widened envelope was accepted");
    expect(measurementCodes(verdict.issues)).toEqual(["BUDGET_OBSERVATION_MALFORMED"]);
  });

  it("refuses an UNKNOWN coverage carrying a quantity, at the CONTRACT layer", () => {
    const verdict = normalizeUsageMeasurement({
      measurement: { ...measurementFor("UNKNOWN", "UNKNOWN"), quantity: 0 },
      pricebookBinding: null, truncated: false,
    });
    if (verdict.ok) throw new Error("an UNKNOWN coverage carried a measured zero");
    // The layer matters: this is the CONTRACT arm answering, not the MEASUREMENT one.
    expect(contractCodes(verdict.issues))
      .toEqual(["BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH"]);
    expect(measurementCodes(verdict.issues)).toEqual([]);
  });
});
