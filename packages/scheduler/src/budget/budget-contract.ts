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
 * The local makeIssue/sortIssues/deepFreeze clones repeat the dependencies, authority, and
 * admission subtrees; consolidation stays blocked because graph-internal's GraphIssueCode is
 * a closed union that cannot admit BUDGET_* codes.
 */
import {
  hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnArrayElement, readOwnDataProperty, readPlainArrayLength,
} from "../runtime-shape.js";

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
export type BudgetBucket = (typeof BUDGET_BUCKETS)[number];
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
  readonly graphRevisionRef: string; readonly version: number;
  readonly state: BudgetAccountState; readonly meters: readonly BudgetMeterBuckets[];
}
export interface ObservedIntervalRefs {
  readonly startRef: string; readonly endRef: string;
}
export interface UsageMeasurementRecord {
  readonly meter: string; readonly quantity: number | null;
  readonly coverage: BudgetMeasurementCoverage; readonly source: BudgetMeasurementSource;
  readonly providerRunRef: string; readonly sourceParserVersion: number;
  readonly sequence: number; readonly rawReceiptDigest: string;
  readonly observedInterval: ObservedIntervalRefs;
}
export interface ReserveDeclarationRecord {
  readonly purpose: BudgetReservePurpose; readonly meter: string; readonly quantity: number;
}
export interface BudgetIssue {
  readonly code: BudgetIssueCode; readonly message: string;
}
export type BudgetValidationResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly issues: readonly BudgetIssue[] };

export const MAX_BUDGET_METERS = 64;
const MAX_REF_LENGTH = 512;
const HEX_64 = /^[0-9a-f]{64}$/u;
const ACCOUNT_KEYS = ["accountId", "ownerRef", "parentRef", "graphRevisionRef", "version",
  "state", "meters"] as const;
const BUCKET_KEYS = ["meter", "available", "reserved", "quarantined", "committed"] as const;
const MEASUREMENT_KEYS = ["meter", "quantity", "coverage", "source", "providerRunRef",
  "sourceParserVersion", "sequence", "rawReceiptDigest", "observedInterval"] as const;
const RESERVE_KEYS = ["purpose", "meter", "quantity"] as const;
const AMOUNT_KEYS = ["available", "reserved", "quarantined", "committed"] as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function makeIssue(code: BudgetIssueCode, message: string): BudgetIssue { return deepFreeze({ code, message }); }
function sortIssues(issues: readonly BudgetIssue[]): BudgetIssue[] {
  return [...issues].sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
}
function fail<T>(...issues: readonly BudgetIssue[]): BudgetValidationResult<T> {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
function accept<T>(record: T): BudgetValidationResult<T> { return deepFreeze({ ok: true, record }); }
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH;
}
/** Safe nonnegative integer. Rejects NaN, Infinity, fractions, -0, and unsafe magnitudes. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && !Object.is(value, -0);
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}
function readRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, allowed)) return null;
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}
/** Applies the length ceiling BEFORE any element read, so an oversized list refuses cheaply. */
function readDenseArray(value: unknown, maximum: number): unknown[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length > maximum || !hasExactDenseArrayShape(value, length)) return null;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) return null;
    output.push(read.value);
  }
  return output;
}
function readMeters(value: unknown): BudgetMeterBuckets[] | null {
  const entries = readDenseArray(value, MAX_BUDGET_METERS);
  if (entries === null) return null;
  const output: BudgetMeterBuckets[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = readRecord(entry, BUCKET_KEYS);
    if (item === null || !isRef(item.meter) || seen.has(item.meter)) return null;
    if (!AMOUNT_KEYS.every((key) => isCount(item[key]))) return null;
    seen.add(item.meter);
    output.push({
      meter: item.meter, available: item.available as number, reserved: item.reserved as number,
      quarantined: item.quarantined as number, committed: item.committed as number,
    });
  }
  return output.sort((a, b) => compareStrings(a.meter, b.meter));
}

/** Zero-authority shape validation. Accepting an account moves no units and funds nothing. */
export function validateBudgetAccount(input: unknown): BudgetValidationResult<BudgetAccountRecord> {
  const item = readRecord(input, ACCOUNT_KEYS);
  if (item === null) {
    return fail(makeIssue("BUDGET_ACCOUNT_MALFORMED", "budget account record is malformed"));
  }
  const issues: BudgetIssue[] = [];
  const field = (message: string): number => issues.push(makeIssue("BUDGET_ACCOUNT_FIELD_INVALID", message));
  if (!isRef(item.accountId)) field("budget account accountId must be a bounded non-empty ref");
  if (!isRef(item.ownerRef)) field("budget account ownerRef must be a bounded non-empty ref");
  if (item.parentRef !== null && !isRef(item.parentRef)) {
    field("budget account parentRef must be null or a bounded non-empty ref");
  }
  if (!isRef(item.graphRevisionRef)) field("budget account graphRevisionRef must be a bounded non-empty ref");
  if (!isCount(item.version)) field("budget account version must be a safe nonnegative integer");
  if (!oneOf(item.state, BUDGET_ACCOUNT_STATES)) field("budget account state is not a known account state");
  const meters = readMeters(item.meters);
  if (meters === null) {
    issues.push(makeIssue("BUDGET_METER_BUCKETS_MALFORMED",
      "budget account meters must be a bounded list of uniquely metered integer bucket quadruples"));
  }
  if (issues.length > 0 || meters === null) return fail(...issues);
  return accept<BudgetAccountRecord>({
    accountId: item.accountId as string, ownerRef: item.ownerRef as string,
    parentRef: item.parentRef as string | null, graphRevisionRef: item.graphRevisionRef as string,
    version: item.version as number, state: item.state as BudgetAccountState, meters,
  });
}

/** Zero-authority shape validation. Accepting a measurement commits no spend. */
export function validateUsageMeasurement(input: unknown): BudgetValidationResult<UsageMeasurementRecord> {
  const item = readRecord(input, MEASUREMENT_KEYS);
  const interval = item === null ? null : readRecord(item.observedInterval, ["startRef", "endRef"]);
  if (item === null || interval === null) {
    return fail(makeIssue("BUDGET_MEASUREMENT_MALFORMED", "usage measurement record is malformed"));
  }
  const issues: BudgetIssue[] = [];
  const field = (message: string): number => issues.push(makeIssue("BUDGET_MEASUREMENT_FIELD_INVALID", message));
  if (!isRef(item.meter)) field("usage measurement meter must be a bounded non-empty ref");
  if (item.quantity !== null && !isCount(item.quantity)) {
    field("usage measurement quantity must be null or a safe nonnegative integer");
  }
  if (!oneOf(item.coverage, BUDGET_MEASUREMENT_COVERAGES)) field("usage measurement coverage is not a known coverage");
  if (!oneOf(item.source, BUDGET_MEASUREMENT_SOURCES)) field("usage measurement source is not a known source");
  if (!isRef(item.providerRunRef)) field("usage measurement providerRunRef must be a bounded non-empty ref");
  if (!isCount(item.sourceParserVersion)) field("usage measurement sourceParserVersion must be a safe nonnegative integer");
  if (!isCount(item.sequence)) field("usage measurement sequence must be a safe nonnegative integer");
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

/** Zero-authority shape validation. A declaration is a request shape, never a held reservation. */
export function validateReserveDeclaration(input: unknown): BudgetValidationResult<ReserveDeclarationRecord> {
  const item = readRecord(input, RESERVE_KEYS);
  if (item === null) {
    return fail(makeIssue("BUDGET_RESERVE_MALFORMED", "reserve declaration record is malformed"));
  }
  const issues: BudgetIssue[] = [];
  const field = (message: string): number => issues.push(makeIssue("BUDGET_RESERVE_FIELD_INVALID", message));
  if (!oneOf(item.purpose, BUDGET_RESERVE_PURPOSES)) field("reserve declaration purpose is not a known purpose");
  if (!isRef(item.meter)) field("reserve declaration meter must be a bounded non-empty ref");
  if (!isCount(item.quantity)) field("reserve declaration quantity must be a safe nonnegative integer");
  if (issues.length > 0) return fail(...issues);
  return accept<ReserveDeclarationRecord>({
    purpose: item.purpose as BudgetReservePurpose, meter: item.meter as string,
    quantity: item.quantity as number,
  });
}
