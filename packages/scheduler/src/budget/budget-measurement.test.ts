/**
 * Mutation checklist — the production check each refusal test pins (epic reason-code rail).
 * _MALFORMED: readObservation envelope guard. _SOURCE_COVERAGE_MISMATCH: the SOURCE_COVERAGES matrix.
 * _PRICEBOOK_BINDING_INVALID: readPricebookBinding plus the DERIVED_LIST_PRICE requirement.
 * _UNCORRELATED_BILLING_CLAIM: a binding carried by a non-derived source. _TRUNCATED_COMPLETION_CLAIM:
 * a truncated receipt claiming COMPLETE. _PARSER_VERSION_UNSUPPORTED: unreadable version, known
 * coverage. _IDENTITY_CONFLICT: same identity, different bytes. _SEQUENCE_GAP / _SEQUENCE_REGRESSION:
 * the monotonic guards. _STREAM_MISMATCH: a foreign providerRunRef. CONTRACT codes: contract layer.
 */
import { describe, expect, it } from "vitest";
import { BUDGET_ISSUE_CODES, BUDGET_MEASUREMENT_SOURCES } from "./budget-contract.js";
import {
  MEASUREMENT_ISSUE_CODES, SUPPORTED_SOURCE_PARSER_VERSIONS, normalizeUsageMeasurement,
  projectBudgetFact, type MeasurementIssueLayer, type MeasurementResult,
  type NormalizedMeasurement,
} from "./budget-measurement.js";

type Bag = Record<string, unknown>;
const DIGEST = "a".repeat(64);
const measurement = (o: Bag = {}): Bag => ({
  meter: "runner.authorized_ms", quantity: 1200, coverage: "COMPLETE",
  source: "PROVIDER_REPORTED_COMPLETE", providerRunRef: "run:abc", sourceParserVersion: 2,
  sequence: 7, rawReceiptDigest: DIGEST,
  observedInterval: { startRef: "event:1", endRef: "event:2" }, ...o,
});
const binding = (o: Bag = {}): Bag => ({
  pricebookRevisionRef: "pricebook:rev-9", unitPriceMicros: 2500, pricedAtRef: "event:1", ...o,
});
const observation = (o: Bag = {}): Bag =>
  ({ measurement: measurement(), pricebookBinding: null, truncated: false, ...o });
const of = (m: Bag, o: Bag = {}): Bag => observation({ measurement: measurement(m), ...o });
const derived = (o: Bag = {}): Bag =>
  of({ source: "DERIVED_LIST_PRICE" }, { pricebookBinding: binding(), ...o });
const unknown = (m: Bag = {}): Bag =>
  of({ coverage: "UNKNOWN", source: "UNKNOWN", quantity: null, ...m });
function refusal(result: MeasurementResult<unknown>, layer: MeasurementIssueLayer, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => `${issue.layer}:${issue.code}`)).toContain(`${layer}:${code}`);
}
function accepted(result: MeasurementResult<NormalizedMeasurement>): NormalizedMeasurement {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpectedly refused: ${JSON.stringify(result.issues)}`);
  return result.record;
}

describe("measurement issue layering", () => {
  it("keeps the measurement-truth codes disjoint from the contract codes", () => {
    const contract = new Set<string>(BUDGET_ISSUE_CODES);
    for (const code of MEASUREMENT_ISSUE_CODES) expect(contract.has(code)).toBe(false);
    expect(MEASUREMENT_ISSUE_CODES.length).toBe(10);
    expect(Object.isFrozen(MEASUREMENT_ISSUE_CODES)).toBe(true);
    expect(SUPPORTED_SOURCE_PARSER_VERSIONS).toStrictEqual([1, 2]);
  });
  it("refuses at the contract layer first and adds no measurement-layer noise", () => {
    const result = normalizeUsageMeasurement(of({ rawReceiptDigest: "ab" }));
    refusal(result, "CONTRACT", "BUDGET_MEASUREMENT_FIELD_INVALID");
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.layer === "CONTRACT")).toBe(true);
  });
  it("sends hostile measurements to the contract layer and hostile envelopes to its own", () => {
    refusal(normalizeUsageMeasurement(observation({ measurement: new Proxy(measurement(), {}) })),
      "CONTRACT", "BUDGET_MEASUREMENT_MALFORMED");
    refusal(normalizeUsageMeasurement(of({ extra: 1 })), "CONTRACT", "BUDGET_MEASUREMENT_MALFORMED");
    refusal(normalizeUsageMeasurement(of({ source: "ADAPTER_REPORTED" })),
      "CONTRACT", "BUDGET_MEASUREMENT_FIELD_INVALID");
    for (const hostile of [
      new Proxy(observation(), {}), observation({ extra: 1 }), undefined,
      Object.create({ measurement: measurement() }) as Bag,
      Object.defineProperty(observation(), "truncated", { get: () => false, configurable: true }),
    ]) refusal(normalizeUsageMeasurement(hostile), "MEASUREMENT", "BUDGET_OBSERVATION_MALFORMED");
  });
});

describe("measurement acceptance and fact projection", () => {
  it("retains all nine measurement fields in a deeply frozen record", () => {
    const record = accepted(normalizeUsageMeasurement(observation()));
    expect(record.measurement).toStrictEqual({
      meter: "runner.authorized_ms", quantity: 1200, coverage: "COMPLETE",
      source: "PROVIDER_REPORTED_COMPLETE", providerRunRef: "run:abc", sourceParserVersion: 2,
      sequence: 7, rawReceiptDigest: DIGEST,
      observedInterval: { startRef: "event:1", endRef: "event:2" },
    });
    expect(record.identity).toBe("7:run:abc|20:runner.authorized_ms|7");
    expect(record.pricebookBinding).toBeNull();
    expect(record.truncated).toBe(false);
    for (const v of [record, record.measurement, record.measurement.observedInterval]) expect(Object.isFrozen(v)).toBe(true);
  });
  it("detaches the record from the caller and repeats deep-equal over equal bytes", () => {
    const interval = { startRef: "event:1", endRef: "event:2" };
    const input = observation({ measurement: measurement({ observedInterval: interval }) });
    const first = accepted(normalizeUsageMeasurement(input));
    interval.endRef = "event:99";
    (input as { truncated: boolean }).truncated = true;
    expect(first.measurement.observedInterval.endRef).toBe("event:2");
    expect(first.truncated).toBe(false);
    expect(accepted(normalizeUsageMeasurement(observation()))).toStrictEqual(first);
  });
  it("projects a structurally PolicyFactInput-compatible frozen fact with no risk tier", () => {
    const fact = projectBudgetFact(accepted(normalizeUsageMeasurement(observation())));
    expect(Object.keys(fact).sort()).toStrictEqual(["factId", "tier", "truthClass"]);
    expect(fact).toStrictEqual({
      factId: "budget.usage:PROVIDER_REPORTED_COMPLETE:7:run:abc|20:runner.authorized_ms|7",
      tier: null, truthClass: "AGENT_REPORTED",
    });
    expect(Object.isFrozen(fact)).toBe(true);
  });
});

describe("coverage truth discipline", () => {
  it("keeps an UNKNOWN measurement null-quantity and projects an UNKNOWN fact", () => {
    const record = accepted(normalizeUsageMeasurement(unknown()));
    expect(record.measurement.quantity).toBeNull();
    expect(record.measurement.coverage).toBe("UNKNOWN");
    expect(projectBudgetFact(record)).toStrictEqual({
      factId: "budget.usage:UNKNOWN:7:run:abc|20:runner.authorized_ms|7", tier: null, truthClass: "UNKNOWN",
    });
  });
  it("refuses every path that launders UNKNOWN into a value or a stronger claim", () => {
    for (const q of [0, 1200]) refusal(normalizeUsageMeasurement(unknown({ quantity: q })),
      "CONTRACT", "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH");
    for (const source of ["PROVIDER_REPORTED_COMPLETE", "ACTUAL_BILLED", "DERIVED_LIST_PRICE"]) {
      refusal(normalizeUsageMeasurement(unknown({ source })),
        "MEASUREMENT", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
    }
    refusal(normalizeUsageMeasurement(of({ source: "UNKNOWN", coverage: "COMPLETE" })),
      "MEASUREMENT", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
  });
  it("keeps PARTIAL an exact unresolved lower bound rather than a completion", () => {
    for (const quantity of [0, 5]) {
      const record = accepted(normalizeUsageMeasurement(
        of({ coverage: "PARTIAL", source: "PROVIDER_REPORTED_PARTIAL", quantity })));
      expect(record.measurement.quantity).toBe(quantity);
      expect(record.measurement.coverage).toBe("PARTIAL");
      expect(projectBudgetFact(record).truthClass).toBe("AGENT_REPORTED");
    }
  });
  it("sweeps the full source-by-coverage matrix and refuses each inconsistent pair", () => {
    const consistent = new Set([
      "PROVIDER_REPORTED_COMPLETE|COMPLETE", "PROVIDER_REPORTED_PARTIAL|PARTIAL",
      "DERIVED_LIST_PRICE|COMPLETE", "DERIVED_LIST_PRICE|PARTIAL", "SUBSCRIPTION_QUOTA|COMPLETE",
      "SUBSCRIPTION_QUOTA|PARTIAL", "ACTUAL_BILLED|COMPLETE", "ACTUAL_BILLED|PARTIAL",
      "UNKNOWN|UNKNOWN",
    ]);
    let accepts = 0;
    let refusals = 0;
    for (const source of BUDGET_MEASUREMENT_SOURCES) {
      for (const coverage of ["COMPLETE", "PARTIAL", "UNKNOWN"]) {
        const input = of({ source, coverage, quantity: coverage === "UNKNOWN" ? null : 3 },
          { pricebookBinding: source === "DERIVED_LIST_PRICE" ? binding() : null });
        if (consistent.has(`${source}|${coverage}`)) {
          accepted(normalizeUsageMeasurement(input));
          accepts += 1;
        } else {
          refusal(normalizeUsageMeasurement(input), "MEASUREMENT",
            "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
          refusals += 1;
        }
      }
    }
    expect([accepts, refusals]).toStrictEqual([9, 9]);
  });
});

describe("derived list price binding", () => {
  it("binds a derived price to an immutable pricebook revision without claiming actual cost", () => {
    const caller = binding() as { unitPriceMicros: number };
    const record = accepted(normalizeUsageMeasurement(derived({ pricebookBinding: caller })));
    expect(record.pricebookBinding).toStrictEqual({
      pricebookRevisionRef: "pricebook:rev-9", unitPriceMicros: 2500, pricedAtRef: "event:1",
    });
    expect(Object.isFrozen(record.pricebookBinding)).toBe(true);
    expect(Object.isFrozen(caller)).toBe(false);
    caller.unitPriceMicros = 9;
    expect(record.pricebookBinding?.unitPriceMicros).toBe(2500);
    const fact = projectBudgetFact(record);
    expect(fact.factId).toContain("DERIVED_LIST_PRICE");
    expect(fact.truthClass).toBe("UNKNOWN");
  });
  it("refuses a derived measurement without a well-formed integer-micros binding", () => {
    refusal(normalizeUsageMeasurement(derived({ pricebookBinding: null })),
      "MEASUREMENT", "BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID");
    for (const override of [
      { unitPriceMicros: 2500.5 }, { unitPriceMicros: -1 }, { unitPriceMicros: "2500" },
      { pricebookRevisionRef: "" }, { pricedAtRef: 7 }, { extra: 1 },
    ]) {
      refusal(normalizeUsageMeasurement(derived({ pricebookBinding: binding(override) })),
        "MEASUREMENT", "BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID");
    }
    refusal(normalizeUsageMeasurement(derived({ pricebookBinding: new Proxy(binding(), {}) })),
      "MEASUREMENT", "BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID");
  });
  it("refuses a billing or provider source that carries a pricebook binding", () => {
    for (const source of ["ACTUAL_BILLED", "PROVIDER_REPORTED_COMPLETE", "SUBSCRIPTION_QUOTA"]) {
      refusal(normalizeUsageMeasurement(of({ source }, { pricebookBinding: binding() })),
        "MEASUREMENT", "BUDGET_OBSERVATION_UNCORRELATED_BILLING_CLAIM");
    }
  });
});

describe("monotonic identity", () => {
  const prior = accepted(normalizeUsageMeasurement(observation()));
  it("treats a duplicate same-identity same-bytes observation as a deterministic no-op", () => {
    expect(accepted(normalizeUsageMeasurement(observation(), prior))).toBe(prior);
  });
  it("accepts only the immediate successor of the prior sequence", () => {
    expect(accepted(normalizeUsageMeasurement(of({ sequence: 8 }), prior)).measurement.sequence).toBe(8);
    refusal(normalizeUsageMeasurement(of({ sequence: 10 }), prior),
      "MEASUREMENT", "BUDGET_OBSERVATION_SEQUENCE_GAP");
    for (const sequence of [6, 0]) {
      refusal(normalizeUsageMeasurement(of({ sequence }), prior),
        "MEASUREMENT", "BUDGET_OBSERVATION_SEQUENCE_REGRESSION");
    }
    refusal(normalizeUsageMeasurement(of({ meter: "attempt.count" }), prior),
      "MEASUREMENT", "BUDGET_OBSERVATION_SEQUENCE_REGRESSION");
  });
  it("fails closed on same identity with different bytes and on a foreign stream", () => {
    for (const override of [{ rawReceiptDigest: "b".repeat(64) }, { quantity: 1201 }]) {
      refusal(normalizeUsageMeasurement(of(override), prior),
        "MEASUREMENT", "BUDGET_OBSERVATION_IDENTITY_CONFLICT");
    }
    refusal(normalizeUsageMeasurement(observation({ truncated: true }), prior),
      "MEASUREMENT", "BUDGET_OBSERVATION_IDENTITY_CONFLICT");
    refusal(normalizeUsageMeasurement(of({ providerRunRef: "run:zzz" }), prior),
      "MEASUREMENT", "BUDGET_OBSERVATION_STREAM_MISMATCH");
    const left = accepted(normalizeUsageMeasurement(of({ providerRunRef: "run|x", meter: "y" })));
    const right = accepted(normalizeUsageMeasurement(of({ providerRunRef: "run", meter: "x|y" })));
    expect(left.identity).not.toBe(right.identity);
  });
});

describe("truncation and parser provenance", () => {
  it("never lets a truncated receipt claim COMPLETE coverage", () => {
    refusal(normalizeUsageMeasurement(observation({ truncated: true })),
      "MEASUREMENT", "BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM");
    const partial = accepted(normalizeUsageMeasurement(
      of({ coverage: "PARTIAL", source: "PROVIDER_REPORTED_PARTIAL" }, { truncated: true })));
    expect(partial.truncated).toBe(true);
    expect(accepted(normalizeUsageMeasurement(unknown())).truncated).toBe(false);
  });
  it("keeps an unsupported parser version UNKNOWN instead of inventing completion", () => {
    for (const c of ["COMPLETE", "PARTIAL"]) {
      refusal(normalizeUsageMeasurement(of({ coverage: c, source: `PROVIDER_REPORTED_${c}`, sourceParserVersion: 9 })),
        "MEASUREMENT", "BUDGET_OBSERVATION_PARSER_VERSION_UNSUPPORTED");
    }
    const stale = accepted(normalizeUsageMeasurement(unknown({ sourceParserVersion: 9 })));
    expect(stale.measurement.sourceParserVersion).toBe(9);
    expect(projectBudgetFact(stale).truthClass).toBe("UNKNOWN");
  });
});
