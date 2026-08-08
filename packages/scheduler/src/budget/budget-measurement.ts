/**
 * Measurement truth (design 11.3, 638-653). Normalizes a provider-neutral usage observation
 * without laundering incomplete metering: UNKNOWN never becomes zero, PARTIAL stays an exact
 * unresolved lower bound, and a DERIVED_LIST_PRICE never becomes an actual-cost claim.
 *
 * TWO LAYERS, and every refusal says which one produced it. The CONTRACT layer is the landed
 * validateUsageMeasurement (shape, vocabulary, the UNKNOWN/quantity biconditional); it runs
 * first and short-circuits, so a malformed record is never judged for truth. The MEASUREMENT
 * layer adds the rules that need cross-field and cross-observation context. Its codes use a
 * BUDGET_OBSERVATION_ prefix because BUDGET_MEASUREMENT_ is already owned by the contract layer
 * and reusing it would make "which layer refused" unassertable.
 *
 * PURE by construction: monotonicity is judged against a prior snapshot the CALLER supplies, not
 * an internal registry, so the same arguments always produce the same answer. No Date, no random,
 * no floating point. No @moe/core or @moe/contracts import — the projected budget fact mirrors
 * PolicyFactInput structurally (policy-contract.ts:68-72) for a future composition boundary and
 * this module evaluates no policy.
 */
import {
  validateUsageMeasurement, type BudgetIssueCode, type BudgetMeasurementSource,
  type BudgetTruthClass, type UsageMeasurementRecord,
} from "./budget-contract.js";
import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "../runtime-shape.js";

export const MEASUREMENT_ISSUE_CODES = Object.freeze([
  "BUDGET_OBSERVATION_MALFORMED", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH",
  "BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID", "BUDGET_OBSERVATION_UNCORRELATED_BILLING_CLAIM",
  "BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM",
  "BUDGET_OBSERVATION_PARSER_VERSION_UNSUPPORTED", "BUDGET_OBSERVATION_IDENTITY_CONFLICT",
  "BUDGET_OBSERVATION_SEQUENCE_GAP", "BUDGET_OBSERVATION_SEQUENCE_REGRESSION",
  "BUDGET_OBSERVATION_STREAM_MISMATCH"] as const);
export const MEASUREMENT_ISSUE_LAYERS = Object.freeze(["CONTRACT", "MEASUREMENT"] as const);
/** Parser revisions this module can read. An unreadable receipt stays UNKNOWN, never COMPLETE. */
export const SUPPORTED_SOURCE_PARSER_VERSIONS = Object.freeze([1, 2] as const);
/** Design 653-style facts bear no risk tier of their own; mirrored, never imported. */
export const MEASUREMENT_FACT_TIER = null;

export type MeasurementIssueCode = (typeof MEASUREMENT_ISSUE_CODES)[number];
export type MeasurementIssueLayer = (typeof MEASUREMENT_ISSUE_LAYERS)[number];
export type LayeredIssue =
  | { readonly layer: "CONTRACT"; readonly code: BudgetIssueCode; readonly message: string }
  | { readonly layer: "MEASUREMENT"; readonly code: MeasurementIssueCode; readonly message: string };
export type MeasurementResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly issues: readonly LayeredIssue[] };

/** A derived price is only meaningful against the immutable revision it was read from. */
export interface PricebookBinding {
  readonly pricebookRevisionRef: string; readonly unitPriceMicros: number;
  readonly pricedAtRef: string;
}
export interface NormalizedMeasurement {
  readonly measurement: UsageMeasurementRecord;
  readonly pricebookBinding: PricebookBinding | null;
  readonly truncated: boolean;
  readonly identity: string;
}
/** Structural mirror of PolicyFactInput. Exactly three fields, or it stops being compatible. */
export interface PolicyFactInputCompatible {
  readonly factId: string;
  readonly tier: "R0" | "R1" | "R2" | "R3" | null;
  readonly truthClass: BudgetTruthClass;
}

const MAX_REF_LENGTH = 512;
const OBSERVATION_KEYS = ["measurement", "pricebookBinding", "truncated"] as const;
const BINDING_KEYS = ["pricebookRevisionRef", "unitPriceMicros", "pricedAtRef"] as const;
/** Coverage each source is allowed to claim. Design 634: the source fixes what it can assert. */
const SOURCE_COVERAGES: Readonly<Record<BudgetMeasurementSource, readonly string[]>> = Object.freeze({
  PROVIDER_REPORTED_COMPLETE: ["COMPLETE"], PROVIDER_REPORTED_PARTIAL: ["PARTIAL"],
  DERIVED_LIST_PRICE: ["COMPLETE", "PARTIAL"], SUBSCRIPTION_QUOTA: ["COMPLETE", "PARTIAL"],
  ACTUAL_BILLED: ["COMPLETE", "PARTIAL"], UNKNOWN: ["UNKNOWN"],
});
/** Design 638-653: a derived list price is an estimate, so it can never claim an observation. */
const SOURCE_TRUTH_CLASSES: Readonly<Record<BudgetMeasurementSource, BudgetTruthClass>> = Object.freeze({
  PROVIDER_REPORTED_COMPLETE: "AGENT_REPORTED", PROVIDER_REPORTED_PARTIAL: "AGENT_REPORTED",
  DERIVED_LIST_PRICE: "UNKNOWN", SUBSCRIPTION_QUOTA: "AGENT_REPORTED",
  ACTUAL_BILLED: "OBSERVED", UNKNOWN: "UNKNOWN",
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sortIssues(issues: readonly LayeredIssue[]): LayeredIssue[] {
  return [...issues].sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
}
function fail<T>(issues: readonly LayeredIssue[]): MeasurementResult<T> {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH;
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
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

interface Observation {
  readonly measurement: unknown; readonly pricebookBinding: unknown; readonly truncated: boolean;
}
/** Envelope guard. A hostile envelope refuses here; a hostile measurement refuses one layer down. */
function readObservation(input: unknown): Observation | null {
  const item = readRecord(input, OBSERVATION_KEYS);
  if (item === null || typeof item.truncated !== "boolean") return null;
  return {
    measurement: item.measurement, pricebookBinding: item.pricebookBinding,
    truncated: item.truncated,
  };
}
function readPricebookBinding(value: unknown): PricebookBinding | null {
  const item = readRecord(value, BINDING_KEYS);
  if (item === null || !isRef(item.pricebookRevisionRef) || !isRef(item.pricedAtRef)) return null;
  if (!isCount(item.unitPriceMicros)) return null;
  return {
    pricebookRevisionRef: item.pricebookRevisionRef, unitPriceMicros: item.unitPriceMicros,
    pricedAtRef: item.pricedAtRef,
  };
}

function issue(code: MeasurementIssueCode, message: string): LayeredIssue {
  return deepFreeze({ layer: "MEASUREMENT" as const, code, message });
}
/**
 * Length-prefixed so the identity is injective. Refs are arbitrary bounded strings, so a plain
 * join would let ("run|a", "b") and ("run", "a|b") share one identity — and therefore one fact ID.
 */
function identityOf(record: UsageMeasurementRecord): string {
  const { providerRunRef: run, meter } = record;
  return `${run.length}:${run}|${meter.length}:${meter}|${record.sequence}`;
}
/** Source/coverage, pricebook binding, truncation, and parser provenance: no observation history. */
function checkStandalone(
  record: UsageMeasurementRecord, rawBinding: unknown, truncated: boolean,
): { readonly issues: LayeredIssue[]; readonly binding: PricebookBinding | null } {
  const issues: LayeredIssue[] = [];
  if (!SOURCE_COVERAGES[record.source].includes(record.coverage)) {
    issues.push(issue("BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH",
      `source ${record.source} may not claim ${record.coverage} coverage`));
  }
  const binding = rawBinding === null ? null : readPricebookBinding(rawBinding);
  if (record.source === "DERIVED_LIST_PRICE") {
    if (binding === null) {
      issues.push(issue("BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID",
        "a derived list price requires an immutable pricebook revision with integer unit micros"));
    }
  } else if (rawBinding !== null) {
    issues.push(issue("BUDGET_OBSERVATION_UNCORRELATED_BILLING_CLAIM",
      `source ${record.source} may not carry a pricebook binding it did not derive from`));
  }
  if (truncated && record.coverage === "COMPLETE") {
    issues.push(issue("BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM",
      "a truncated receipt cannot claim COMPLETE coverage"));
  }
  const readable = (SUPPORTED_SOURCE_PARSER_VERSIONS as readonly number[])
    .includes(record.sourceParserVersion);
  if (!readable && record.coverage !== "UNKNOWN") {
    issues.push(issue("BUDGET_OBSERVATION_PARSER_VERSION_UNSUPPORTED",
      `parser version ${record.sourceParserVersion} is unreadable, so coverage cannot exceed UNKNOWN`));
  }
  return { issues, binding: record.source === "DERIVED_LIST_PRICE" ? binding : null };
}
/** Monotonicity against the caller's snapshot. Same identity plus same bytes is not a conflict. */
function checkAgainstPrior(
  candidate: NormalizedMeasurement, prior: NormalizedMeasurement,
): LayeredIssue[] {
  if (prior.measurement.providerRunRef !== candidate.measurement.providerRunRef) {
    return [issue("BUDGET_OBSERVATION_STREAM_MISMATCH",
      "the prior observation belongs to another provider run stream")];
  }
  if (prior.identity === candidate.identity) {
    return JSON.stringify(prior) === JSON.stringify(candidate)
      ? []
      : [issue("BUDGET_OBSERVATION_IDENTITY_CONFLICT",
        "the same observation identity was already seen carrying different bytes")];
  }
  const expected = prior.measurement.sequence + 1;
  if (candidate.measurement.sequence < expected) {
    return [issue("BUDGET_OBSERVATION_SEQUENCE_REGRESSION",
      `sequence ${candidate.measurement.sequence} does not advance past ${prior.measurement.sequence}`)];
  }
  if (candidate.measurement.sequence > expected) {
    return [issue("BUDGET_OBSERVATION_SEQUENCE_GAP",
      `sequence ${candidate.measurement.sequence} skips the observation at ${expected}`)];
  }
  return [];
}

/**
 * Normalizes one usage observation. `prior` is the last accepted observation of the same stream,
 * supplied by the caller; a duplicate of it with identical bytes is a deterministic no-op that
 * returns that exact record rather than a fresh equal one.
 */
export function normalizeUsageMeasurement(
  input: unknown, prior?: NormalizedMeasurement | null,
): MeasurementResult<NormalizedMeasurement> {
  const observation = readObservation(input);
  if (observation === null) {
    return fail([issue("BUDGET_OBSERVATION_MALFORMED",
      "usage observation must be a plain {measurement, pricebookBinding, truncated} envelope")]);
  }
  const validated = validateUsageMeasurement(observation.measurement);
  if (!validated.ok) {
    return fail(validated.issues.map((entry) =>
      deepFreeze({ layer: "CONTRACT" as const, code: entry.code, message: entry.message })));
  }
  const record = validated.record;
  const standalone = checkStandalone(record, observation.pricebookBinding, observation.truncated);
  const candidate: NormalizedMeasurement = {
    measurement: record, pricebookBinding: standalone.binding, truncated: observation.truncated,
    identity: identityOf(record),
  };
  const history = prior === undefined || prior === null ? [] : checkAgainstPrior(candidate, prior);
  const issues = [...standalone.issues, ...history];
  if (issues.length > 0) return fail(issues);
  if (prior !== undefined && prior !== null && prior.identity === candidate.identity) {
    return deepFreeze({ ok: true, record: prior });
  }
  return deepFreeze({ ok: true, record: candidate });
}

/**
 * Projects the required budget fact. The truth class comes from the source's honesty, never from
 * a caller assertion, and the source is spelled into the fact ID so a derived estimate can never
 * be mistaken for a billed observation downstream.
 */
export function projectBudgetFact(normalized: NormalizedMeasurement): PolicyFactInputCompatible {
  const { source } = normalized.measurement;
  return deepFreeze({
    factId: `budget.usage:${source}:${normalized.identity}`,
    tier: MEASUREMENT_FACT_TIER,
    truthClass: SOURCE_TRUTH_CLASSES[source],
  });
}
