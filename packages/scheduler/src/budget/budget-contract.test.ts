import { describe, expect, it } from "vitest";
import {
  BUDGET_ACCOUNT_STATES, BUDGET_BUCKETS, BUDGET_ISSUE_CODES, BUDGET_MEASUREMENT_COVERAGES,
  BUDGET_MEASUREMENT_SOURCES, BUDGET_POLICY_OUTCOMES, BUDGET_POLICY_RISK_TIERS,
  BUDGET_RESERVE_PURPOSES, BUDGET_TRUTH_CLASSES, MAX_BUDGET_METERS, validateBudgetAccount,
  validateReserveDeclaration, validateUsageMeasurement,
  type BudgetIssueCode, type BudgetValidationResult,
} from "./budget-contract.js";

const DIGEST = "a".repeat(64);
const bucketsFor = (meter: string): Record<string, unknown> => ({
  meter, available: 10, reserved: 4, quarantined: 1, committed: 5,
});
const account = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: "account:goal-1", ownerRef: "goal:1", parentRef: null,
  graphRevisionRef: "graph:rev-1", version: 3, state: "OPEN",
  meters: [bucketsFor("attempt.count")], ...overrides,
});
const measurement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  meter: "runner.authorized_ms", quantity: 1200, coverage: "COMPLETE",
  source: "PROVIDER_REPORTED_COMPLETE", providerRunRef: "run:abc",
  sourceParserVersion: 2, sequence: 7, rawReceiptDigest: DIGEST,
  observedInterval: { startRef: "event:1", endRef: "event:2" }, ...overrides,
});
const reserve = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: "VERIFICATION", meter: "attempt.count", quantity: 1, ...overrides,
});
const codesOf = (result: BudgetValidationResult<unknown>): readonly BudgetIssueCode[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);
const messagesOf = (result: BudgetValidationResult<unknown>): readonly string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.message);
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

describe("budget account validation", () => {
  it("accepts a well-formed account and deeply freezes it", () => {
    const result = validateBudgetAccount(account());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.meters)).toBe(true);
    expect(Object.isFrozen(result.record.meters[0])).toBe(true);
    expect(result.record.meters[0]).toStrictEqual({
      meter: "attempt.count", available: 10, reserved: 4, quarantined: 1, committed: 5,
    });
  });

  it("detaches the accepted record from later mutation of the caller's input", () => {
    const meters = [bucketsFor("attempt.count")];
    const input = account({ meters });
    const result = validateBudgetAccount(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    meters.push(bucketsFor("runner.authorized_ms"));
    (meters[0] as Record<string, unknown>).available = 999;
    input.state = "OVERDRAWN";
    expect(result.record.meters).toHaveLength(1);
    expect(result.record.meters[0]?.available).toBe(10);
    expect(result.record.state).toBe("OPEN");
  });

  it("is deterministic over equal input bytes", () => {
    const first = validateBudgetAccount(account());
    const second = validateBudgetAccount(account());
    expect(first).toStrictEqual(second);
  });

  it("refuses proxy, accessor, prototype-key, and extra-key inputs", () => {
    expectRefusal(validateBudgetAccount(new Proxy(account(), {})), "BUDGET_ACCOUNT_MALFORMED");
    const accessor = account();
    Object.defineProperty(accessor, "version", { get: () => 3, configurable: true });
    expectRefusal(validateBudgetAccount(accessor), "BUDGET_ACCOUNT_MALFORMED");
    expectRefusal(
      validateBudgetAccount(JSON.parse('{"__proto__":{"polluted":true}}')),
      "BUDGET_ACCOUNT_MALFORMED",
    );
    expectRefusal(validateBudgetAccount(account({ extra: 1 })), "BUDGET_ACCOUNT_MALFORMED");
    expectRefusal(validateBudgetAccount(null), "BUDGET_ACCOUNT_MALFORMED");
  });

  it("refuses malformed refs, versions, and states", () => {
    expectRefusal(validateBudgetAccount(account({ accountId: "" })), "BUDGET_ACCOUNT_FIELD_INVALID");
    expectRefusal(validateBudgetAccount(account({ parentRef: "" })), "BUDGET_ACCOUNT_FIELD_INVALID");
    expectRefusal(validateBudgetAccount(account({ version: -1 })), "BUDGET_ACCOUNT_FIELD_INVALID");
    expectRefusal(validateBudgetAccount(account({ version: 1.5 })), "BUDGET_ACCOUNT_FIELD_INVALID");
    expectRefusal(
      validateBudgetAccount(account({ version: Number.MAX_SAFE_INTEGER + 2 })),
      "BUDGET_ACCOUNT_FIELD_INVALID",
    );
    expectRefusal(validateBudgetAccount(account({ state: "OPENED" })), "BUDGET_ACCOUNT_FIELD_INVALID");
  });

  it("refuses negative, fractional, and unsafe bucket amounts", () => {
    for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const meters = [{ ...bucketsFor("attempt.count"), reserved: amount }];
      expectRefusal(validateBudgetAccount(account({ meters })), "BUDGET_METER_BUCKETS_MALFORMED");
    }
    expectRefusal(
      validateBudgetAccount(account({ meters: [bucketsFor("a"), bucketsFor("a")] })),
      "BUDGET_METER_BUCKETS_MALFORMED",
    );
  });

  it("refuses oversized meter lists before reading their elements", () => {
    const meters = Array.from({ length: MAX_BUDGET_METERS + 1 }, (_, index) => bucketsFor(`m${index}`));
    expectRefusal(validateBudgetAccount(account({ meters })), "BUDGET_METER_BUCKETS_MALFORMED");
  });

  it("sorts accumulated issues deterministically rather than by emission order", () => {
    const result = validateBudgetAccount(account({ version: -1, state: "OPENED" }));
    expect(codesOf(result)).toStrictEqual([
      "BUDGET_ACCOUNT_FIELD_INVALID", "BUDGET_ACCOUNT_FIELD_INVALID",
    ]);
    expect(messagesOf(result)).toStrictEqual([...messagesOf(result)].sort());
    expect(messagesOf(result)[0]).toContain("state");
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

describe("reserve declaration validation", () => {
  it("accepts every protected and fan-out purpose, frozen", () => {
    for (const purpose of BUDGET_RESERVE_PURPOSES) {
      const result = validateReserveDeclaration(reserve({ purpose }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(result.record.purpose).toBe(purpose);
    }
  });

  it("refuses unknown purposes, malformed meters, and non-integer quantities", () => {
    expectRefusal(validateReserveDeclaration(reserve({ purpose: "AUDIT" })), "BUDGET_RESERVE_FIELD_INVALID");
    expectRefusal(validateReserveDeclaration(reserve({ meter: "" })), "BUDGET_RESERVE_FIELD_INVALID");
    expectRefusal(validateReserveDeclaration(reserve({ quantity: -1 })), "BUDGET_RESERVE_FIELD_INVALID");
    expectRefusal(validateReserveDeclaration(reserve({ quantity: 1.5 })), "BUDGET_RESERVE_FIELD_INVALID");
    expectRefusal(validateReserveDeclaration(reserve({ extra: 1 })), "BUDGET_RESERVE_MALFORMED");
    expectRefusal(validateReserveDeclaration(undefined), "BUDGET_RESERVE_MALFORMED");
  });
});
