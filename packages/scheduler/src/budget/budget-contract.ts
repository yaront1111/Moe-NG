/**
 * Budget contract vocabulary (design section 11). Types and validation ONLY: zero movement
 * authority, so no allocate, settle, transfer, or refund operation is exported. Ledger
 * transfers, protected reservations, and settlement belong to the sibling budget children.
 *
 * Provenance, because not every set below is design-pinned. DESIGN-PINNED: account states
 * (design 591), the four conserved buckets (592-597), measurement coverage (634), and the six
 * measurement sources, which design 20.5 line 1260 (benchmark binding T-D1) pins as exactly
 * what a provider adapter may emit. LOCAL: reserve purposes — design 587 protects "mandatory
 * verification, eligible review, final acceptance processing, and contingency" plus fan-out
 * "input materialization and integration" in PROSE only, so these identifiers are this
 * module's spelling of that sentence rather than design-pinned strings. MIRRORED, divergence
 * risk: policy outcomes/tiers copy packages/core/src/policy/policy-contract.ts:17-30 and truth
 * classes copy packages/contracts/src/runtime/runtime-vocabulary.ts:61-63 string-identically;
 * @moe/scheduler depends on neither package by design, so they cannot be imported and must be
 * re-diffed by value whenever the canonical files change.
 *
 * Meters are open bounded identifiers, not a closed set: design 11.2 fixes attempt.count,
 * runner.authorized_ms, and verification.authorized_ms but admits provider-specific meters.
 * Amounts are safe nonnegative integers because design 11.2 forbids floating-point currency
 * or token accounting. Design 11.3: UNKNOWN is never converted to zero, so an unknown
 * quantity is `null` and a measured zero stays a different, knowable fact.
 *
 * The local makeIssue/sortIssues clones repeat the dependencies, authority, and admission
 * subtrees; consolidation stays blocked because graph-internal's GraphIssueCode is a closed
 * union that cannot admit BUDGET_* codes. The code-free primitives come from kernel-primitives.
 */
import {
  compareStrings, deepFreeze, exactRecord, isSafeCount, oneOf,
} from "../kernel-primitives.js";

export const BUDGET_ACCOUNT_STATES = Object.freeze([
  "OPEN", "SETTLING", "CLOSED", "CLOSED_WITH_UNKNOWN_LIABILITY", "OVERDRAWN"] as const);
export const BUDGET_BUCKETS = Object.freeze([
  "AVAILABLE", "RESERVED", "QUARANTINED", "COMMITTED"] as const);
export const BUDGET_MEASUREMENT_COVERAGES = Object.freeze(["COMPLETE", "PARTIAL", "UNKNOWN"] as const);
export const BUDGET_MEASUREMENT_SOURCES = Object.freeze([
  "PROVIDER_REPORTED_COMPLETE", "PROVIDER_REPORTED_PARTIAL", "DERIVED_LIST_PRICE",
  "SUBSCRIPTION_QUOTA", "ACTUAL_BILLED", "UNKNOWN"] as const);
export const BUDGET_RESERVE_PURPOSES = Object.freeze([
  "VERIFICATION", "REVIEW", "ACCEPTANCE_PROCESSING", "CONTINGENCY",
  "INPUT_MATERIALIZATION", "INTEGRATION"] as const);
export const BUDGET_POLICY_OUTCOMES = Object.freeze([
  "ALLOW", "REQUIRE_HUMAN_APPROVAL", "HOLD_UNKNOWN", "DENY"] as const);
export const BUDGET_POLICY_RISK_TIERS = Object.freeze(["R0", "R1", "R2", "R3"] as const);
export const BUDGET_TRUTH_CLASSES = Object.freeze([
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"] as const);
export const BUDGET_ISSUE_CODES = Object.freeze([
  "BUDGET_ACCOUNT_MALFORMED", "BUDGET_ACCOUNT_FIELD_INVALID", "BUDGET_METER_BUCKETS_MALFORMED",
  "BUDGET_MEASUREMENT_MALFORMED", "BUDGET_MEASUREMENT_FIELD_INVALID",
  "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH",
  "BUDGET_RESERVE_MALFORMED", "BUDGET_RESERVE_FIELD_INVALID"] as const);

export type BudgetAccountState = (typeof BUDGET_ACCOUNT_STATES)[number];
export type BudgetMeasurementCoverage = (typeof BUDGET_MEASUREMENT_COVERAGES)[number];
export type BudgetMeasurementSource = (typeof BUDGET_MEASUREMENT_SOURCES)[number];
export type BudgetReservePurpose = (typeof BUDGET_RESERVE_PURPOSES)[number];
export type BudgetPolicyOutcome = (typeof BUDGET_POLICY_OUTCOMES)[number];
export type BudgetPolicyRiskTier = (typeof BUDGET_POLICY_RISK_TIERS)[number];
export type BudgetTruthClass = (typeof BUDGET_TRUTH_CLASSES)[number];
export type BudgetIssueCode = (typeof BUDGET_ISSUE_CODES)[number];

/** Direct per-meter buckets. Root roll-ups are derived elsewhere and never stored (design 607). */
export interface BudgetMeterBuckets {
  readonly meter: string; readonly available: number; readonly reserved: number;
  readonly quarantined: number; readonly committed: number;
}
export interface BudgetAccountRecord {
  readonly accountId: string; readonly ownerRef: string; readonly parentRef: string | null;
  readonly graphRevisionRef: string; readonly version: number; readonly state: BudgetAccountState;
  readonly meters: readonly BudgetMeterBuckets[];
}
export interface ObservedIntervalRefs { readonly startRef: string; readonly endRef: string }
export interface UsageMeasurementRecord {
  readonly meter: string; readonly quantity: number | null;
  readonly coverage: BudgetMeasurementCoverage; readonly source: BudgetMeasurementSource;
  readonly providerRunRef: string; readonly sourceParserVersion: number;
  readonly sequence: number; readonly rawReceiptDigest: string;
  readonly observedInterval: ObservedIntervalRefs;
}
export interface BudgetIssue { readonly code: BudgetIssueCode; readonly message: string }
export type BudgetValidationResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly issues: readonly BudgetIssue[] };

export const MAX_BUDGET_METERS = 64;
const MAX_REF_LENGTH = 512;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MEASUREMENT_KEYS = ["meter", "quantity", "coverage", "source", "providerRunRef",
  "sourceParserVersion", "sequence", "rawReceiptDigest", "observedInterval"] as const;

function makeIssue(code: BudgetIssueCode, message: string): BudgetIssue { return deepFreeze({ code, message }); }
function sortIssues(issues: readonly BudgetIssue[]): BudgetIssue[] {
  return [...issues].sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
}
function fail<T>(...issues: readonly BudgetIssue[]): BudgetValidationResult<T> {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
function accept<T>(record: T): BudgetValidationResult<T> { return deepFreeze({ ok: true, record }); }
function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH;
}
function isDigest(value: unknown): value is string { return typeof value === "string" && HEX_64.test(value); }

/** Zero-authority shape validation. Accepting a measurement commits no spend. */
export function validateUsageMeasurement(input: unknown): BudgetValidationResult<UsageMeasurementRecord> {
  const item = exactRecord(input, MEASUREMENT_KEYS);
  const interval = item === null ? null : exactRecord(item.observedInterval, ["startRef", "endRef"]);
  if (item === null || interval === null) {
    return fail(makeIssue("BUDGET_MEASUREMENT_MALFORMED", "usage measurement record is malformed"));
  }
  const issues: BudgetIssue[] = [];
  const field = (message: string): number => issues.push(makeIssue("BUDGET_MEASUREMENT_FIELD_INVALID", message));
  if (!isRef(item.meter)) field("usage measurement meter must be a bounded non-empty ref");
  if (item.quantity !== null && !isSafeCount(item.quantity)) {
    field("usage measurement quantity must be null or a safe nonnegative integer");
  }
  if (!oneOf(item.coverage, BUDGET_MEASUREMENT_COVERAGES)) field("usage measurement coverage is not a known coverage");
  if (!oneOf(item.source, BUDGET_MEASUREMENT_SOURCES)) field("usage measurement source is not a known source");
  if (!isRef(item.providerRunRef)) field("usage measurement providerRunRef must be a bounded non-empty ref");
  if (!isSafeCount(item.sourceParserVersion)) field("usage measurement sourceParserVersion must be a safe nonnegative integer");
  if (!isSafeCount(item.sequence)) field("usage measurement sequence must be a safe nonnegative integer");
  if (!isDigest(item.rawReceiptDigest)) field("usage measurement rawReceiptDigest must be a lowercase 64-character hex digest");
  if (!isRef(interval.startRef) || !isRef(interval.endRef)) {
    field("usage measurement observedInterval must carry bounded non-empty start and end refs");
  }
  // Design 11.3: UNKNOWN is never converted to zero, and PARTIAL is an exact lower bound.
  if (item.coverage === "UNKNOWN" ? item.quantity !== null : item.quantity === null) {
    issues.push(makeIssue("BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH",
      "UNKNOWN coverage requires a null quantity and COMPLETE or PARTIAL coverage requires a measured one"));
  }
  if (issues.length > 0) return fail(...issues);
  return accept<UsageMeasurementRecord>({
    meter: item.meter as string, quantity: item.quantity as number | null,
    coverage: item.coverage as BudgetMeasurementCoverage, source: item.source as BudgetMeasurementSource,
    providerRunRef: item.providerRunRef as string, sourceParserVersion: item.sourceParserVersion as number,
    sequence: item.sequence as number, rawReceiptDigest: item.rawReceiptDigest as string,
    observedInterval: { startRef: interval.startRef as string, endRef: interval.endRef as string },
  });
}
