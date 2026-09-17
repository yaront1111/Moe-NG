import { describe, expect, it } from "vitest";
import {
  BUDGET_ACCOUNT_STATES, BUDGET_BUCKETS, BUDGET_ISSUE_CODES, BUDGET_MEASUREMENT_COVERAGES,
  BUDGET_MEASUREMENT_SOURCES, BUDGET_POLICY_OUTCOMES, BUDGET_POLICY_RISK_TIERS,
  BUDGET_RESERVE_PURPOSES, BUDGET_TRUTH_CLASSES, validateUsageMeasurement,
  type BudgetIssueCode, type BudgetValidationResult,
} from "./budget-contract.js";

const DIGEST = "a".repeat(64);
const measurement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  meter: "runner.authorized_ms", quantity: 1200, coverage: "COMPLETE",
  source: "PROVIDER_REPORTED_COMPLETE", providerRunRef: "run:abc",
  sourceParserVersion: 2, sequence: 7, rawReceiptDigest: DIGEST,
  observedInterval: { startRef: "event:1", endRef: "event:2" }, ...overrides,
});
const codesOf = (result: BudgetValidationResult<unknown>): readonly BudgetIssueCode[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);
function expectRefusal(result: BudgetValidationResult<unknown>, code: BudgetIssueCode): void {
  expect(result.ok).toBe(false);
  expect(codesOf(result)).toContain(code);
}

describe("budget vocabulary", () => {
  it("pins the design's account state, bucket, and coverage spellings", () => {
    expect(BUDGET_ACCOUNT_STATES).toStrictEqual([
      "OPEN", "SETTLING", "CLOSED", "CLOSED_WITH_UNKNOWN_LIABILITY", "OVERDRAWN",
    ]);
    expect(BUDGET_BUCKETS).toStrictEqual(["AVAILABLE", "RESERVED", "QUARANTINED", "COMMITTED"]);
    expect(BUDGET_MEASUREMENT_COVERAGES).toStrictEqual(["COMPLETE", "PARTIAL", "UNKNOWN"]);
  });

  it("pins the benchmark-bound measurement source set exactly", () => {
    expect(BUDGET_MEASUREMENT_SOURCES).toStrictEqual([
      "PROVIDER_REPORTED_COMPLETE", "PROVIDER_REPORTED_PARTIAL", "DERIVED_LIST_PRICE",
      "SUBSCRIPTION_QUOTA", "ACTUAL_BILLED", "UNKNOWN",
    ]);
  });

  it("carries the local reserve purposes and string-identical policy/truth mirrors", () => {
    expect(BUDGET_RESERVE_PURPOSES).toStrictEqual([
      "VERIFICATION", "REVIEW", "ACCEPTANCE_PROCESSING", "CONTINGENCY",
      "INPUT_MATERIALIZATION", "INTEGRATION",
    ]);
    expect(BUDGET_POLICY_OUTCOMES).toStrictEqual([
      "ALLOW", "REQUIRE_HUMAN_APPROVAL", "HOLD_UNKNOWN", "DENY",
    ]);
    expect(BUDGET_POLICY_RISK_TIERS).toStrictEqual(["R0", "R1", "R2", "R3"]);
    expect(BUDGET_TRUTH_CLASSES).toStrictEqual([
      "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
    ]);
  });

  it("freezes every exported vocabulary", () => {
    for (const vocabulary of [
      BUDGET_ACCOUNT_STATES, BUDGET_BUCKETS, BUDGET_MEASUREMENT_COVERAGES,
      BUDGET_MEASUREMENT_SOURCES, BUDGET_RESERVE_PURPOSES, BUDGET_POLICY_OUTCOMES,
      BUDGET_POLICY_RISK_TIERS, BUDGET_TRUTH_CLASSES, BUDGET_ISSUE_CODES,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
    }
  });
});

describe("usage measurement validation", () => {
  it("accepts a complete measurement and freezes its nested interval", () => {
    const result = validateUsageMeasurement(measurement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.observedInterval)).toBe(true);
    expect(result.record.observedInterval).toStrictEqual({ startRef: "event:1", endRef: "event:2" });
  });

  it("detaches the nested interval from the caller's input", () => {
    const observedInterval = { startRef: "event:1", endRef: "event:2" };
    const result = validateUsageMeasurement(measurement({ observedInterval }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    observedInterval.endRef = "event:99";
    expect(result.record.observedInterval.endRef).toBe("event:2");
  });

  it("never lets UNKNOWN coverage carry a quantity, and never converts it to zero", () => {
    const unknown = validateUsageMeasurement(
      measurement({ coverage: "UNKNOWN", source: "UNKNOWN", quantity: null }),
    );
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.record.quantity).toBeNull();
    for (const quantity of [0, 1200]) {
      expectRefusal(
        validateUsageMeasurement(measurement({ coverage: "UNKNOWN", source: "UNKNOWN", quantity })),
        "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH",
      );
    }
  });

  it("requires an integer quantity for COMPLETE and PARTIAL coverage", () => {
    for (const coverage of ["COMPLETE", "PARTIAL"]) {
      expectRefusal(
        validateUsageMeasurement(measurement({ coverage, quantity: null })),
        "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH",
      );
    }
    expect(validateUsageMeasurement(measurement({ coverage: "PARTIAL", quantity: 0 })).ok).toBe(true);
    for (const quantity of [-1, 12.5, Number.NaN]) {
      expectRefusal(
        validateUsageMeasurement(measurement({ quantity })),
        "BUDGET_MEASUREMENT_FIELD_INVALID",
      );
    }
  });

  it("refuses malformed digests, versions, sequences, and vocabulary values", () => {
    expectRefusal(validateUsageMeasurement(measurement({ rawReceiptDigest: "A".repeat(64) })),
      "BUDGET_MEASUREMENT_FIELD_INVALID");
    expectRefusal(validateUsageMeasurement(measurement({ rawReceiptDigest: "ab" })),
      "BUDGET_MEASUREMENT_FIELD_INVALID");
    expectRefusal(validateUsageMeasurement(measurement({ sequence: -1 })),
      "BUDGET_MEASUREMENT_FIELD_INVALID");
    expectRefusal(validateUsageMeasurement(measurement({ sourceParserVersion: 1.5 })),
      "BUDGET_MEASUREMENT_FIELD_INVALID");
    expectRefusal(validateUsageMeasurement(measurement({ source: "ADAPTER_REPORTED" })),
      "BUDGET_MEASUREMENT_FIELD_INVALID");
    expectRefusal(validateUsageMeasurement(measurement({ extra: 1 })), "BUDGET_MEASUREMENT_MALFORMED");
    expectRefusal(validateUsageMeasurement(new Proxy(measurement(), {})), "BUDGET_MEASUREMENT_MALFORMED");
  });
});
