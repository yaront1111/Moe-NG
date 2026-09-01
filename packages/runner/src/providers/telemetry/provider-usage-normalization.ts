/**
 * Provider usage normalization: the Claude telemetry handoff mapped onto the
 * landed @moe/scheduler measurement authority, one row per token meter.
 *
 * IT DECIDES NOTHING THE AUTHORITY DECIDES. The source/coverage matrix, the
 * pricebook rule, the truncation rule, the parser-version rule and the
 * identity/sequence rules all live in `normalizeUsageMeasurement`, and
 * `validateUsageMeasurement` is deliberately withheld from the scheduler root so
 * this module cannot route around it. What this module does is MAP: it states
 * facts the launcher and the result parser already observed in the authority's
 * vocabulary, and forwards every refusal with its layer and code verbatim.
 *
 * THE ONE RULE WORTH SPELLING OUT. A `ProviderQuantity` that is not `known`
 * becomes `quantity: null` at `coverage: UNKNOWN` — never `0`. The union makes
 * that structural on the reading side and the authority's own coverage/quantity
 * biconditional makes it structural on the writing side, so a `?? 0` introduced
 * here refuses at the CONTRACT layer rather than shipping a measured zero nobody
 * measured.
 *
 * THIS SEAM PRICES NOTHING, so it never emits `DERIVED_LIST_PRICE` and never
 * attaches a `PricebookBinding`: only that source may carry one, and a
 * provider-reported row that acquired one would be an uncorrelated billing claim.
 */
import { types } from "node:util";

import {
  encodeProviderRunRef, normalizeUsageMeasurement,
  type BudgetMeasurementCoverage, type BudgetMeasurementSource, type NormalizedMeasurement,
  type UsageMeasurementRecord,
} from "@moe/scheduler";

import { deepFreeze } from "../../canonical.js";
import type { ClaudeTelemetryHandoff } from "./claude-telemetry-launch.js";
import type { ProviderQuantity, ProviderRunRef } from "./provider-telemetry-contracts.js";
import {
  PROVIDER_USAGE_CONTRACT_VERSION, PROVIDER_USAGE_METERS,
  PROVIDER_USAGE_SOURCE_PARSER_VERSION, providerUsageRefusal,
  type ProviderUnpricedReason, type ProviderUsageContext, type ProviderUsageCostBasis,
  type ProviderUsageResult,
} from "./provider-usage-contracts.js";

const TOKEN_METERS = Object.freeze([
  ["inputTokens", PROVIDER_USAGE_METERS.inputTokens],
  ["outputTokens", PROVIDER_USAGE_METERS.outputTokens],
  ["cacheCreationInputTokens", PROVIDER_USAGE_METERS.cacheCreationInputTokens],
  ["cacheReadInputTokens", PROVIDER_USAGE_METERS.cacheReadInputTokens],
] as const);
const COVERAGE_BY_SOURCE: Readonly<Record<string, BudgetMeasurementCoverage>> = Object.freeze({
  PROVIDER_REPORTED_COMPLETE: "COMPLETE", PROVIDER_REPORTED_PARTIAL: "PARTIAL",
  UNKNOWN: "UNKNOWN",
});
const UNPRICED_BY_COVERAGE: Readonly<Record<BudgetMeasurementCoverage, ProviderUnpricedReason>> =
  Object.freeze({ COMPLETE: "NO_PRICEBOOK_ON_THIS_SEAM", PARTIAL: "COVERAGE_INCOMPLETE",
    UNKNOWN: "COVERAGE_UNKNOWN" });

/**
 * Length-prefixed so the identity is injective: refs are arbitrary bounded
 * strings, so a plain join would let two different runs share one identity and
 * therefore one measurement stream.
 *
 * THE FORMAT IS NOT OURS TO SPELL. Settlement DECODES the attempt segment back out of this string
 * to correlate a reading against a reservation, so producer and consumer share ONE implementation
 * in `@moe/scheduler` rather than two that agree today (task-763c24cf).
 *
 * `ProviderRunRef` also carries `effectIntentId`, which the encoder's parameter does not name and
 * which is therefore IGNORED — exactly as this function has always ignored it. Do not "fix" that
 * by folding the field in: it would change a format every durable measurement already carries.
 */
function runRefOf(ref: ProviderRunRef): string {
  return encodeProviderRunRef(ref);
}

/**
 * Derived from OBSERVED facts, never accepted from a caller. COMPLETE requires
 * every contributing count present, an ordinary completion, and a parse that
 * raised no refusal — a run that ended any other way is at most PARTIAL.
 */
function sourceOf(handoff: ClaudeTelemetryHandoff): BudgetMeasurementSource {
  const known = TOKEN_METERS.filter(([field]) => handoff.tokens[field].known).length;
  if (known === 0) return "UNKNOWN";
  if (known === TOKEN_METERS.length && handoff.terminal === "COMPLETED" &&
    handoff.telemetryRefusal === null) {
    return "PROVIDER_REPORTED_COMPLETE";
  }
  return "PROVIDER_REPORTED_PARTIAL";
}

interface RowBase {
  readonly providerRunRef: string;
  readonly sequence: number;
  readonly rawReceiptDigest: string;
  readonly observedInterval: { readonly startRef: string; readonly endRef: string };
  readonly truncated: boolean;
}

/** An unknown quantity is `null` at UNKNOWN coverage. There is no arithmetic arm. */
function rowFor(
  meter: string, fact: ProviderQuantity, setSource: BudgetMeasurementSource, base: RowBase,
): UsageMeasurementRecord {
  const source = fact.known ? setSource : "UNKNOWN";
  return {
    meter, quantity: fact.known ? fact.value : null,
    coverage: COVERAGE_BY_SOURCE[source] ?? "UNKNOWN", source,
    providerRunRef: base.providerRunRef,
    sourceParserVersion: PROVIDER_USAGE_SOURCE_PARSER_VERSION,
    sequence: base.sequence, rawReceiptDigest: base.rawReceiptDigest,
    observedInterval: base.observedInterval,
  };
}

/**
 * Priors are read as OPAQUE normalizer output: a hostile container is refused
 * before `Array.isArray` runs, because that call THROWS on a revoked proxy, and
 * an entry that does not look like normalizer output is refused rather than
 * silently ignored — an ignored prior would turn a rewind into an acceptance.
 */
function priorIndex(
  priors: unknown,
): ReadonlyMap<string, NormalizedMeasurement> | null {
  try {
    if (types.isProxy(priors)) return null;
  } catch {
    return null;
  }
  if (!Array.isArray(priors)) return null;
  const index = new Map<string, NormalizedMeasurement>();
  for (const prior of priors) {
    if (typeof prior !== "object" || prior === null) return null;
    try {
      if (types.isProxy(prior)) return null;
    } catch {
      return null;
    }
    const entry = prior as { readonly identity?: unknown; readonly measurement?: unknown };
    const measurement = entry.measurement;
    if (typeof entry.identity !== "string" || typeof measurement !== "object" ||
      measurement === null) {
      return null;
    }
    const meter = (measurement as { readonly meter?: unknown }).meter;
    if (typeof meter !== "string") return null;
    index.set(meter, prior);
  }
  return index;
}

/**
 * The context is CALLER data, so it is read as an own DATA descriptor behind a
 * proxy guard rather than by property access: an accessor on `priors` would be
 * the caller's own code running inside the read that decides whether to trust
 * the caller, and a throwing getter would turn a refusal into an exception.
 */
function readPriors(context: ProviderUsageContext): unknown {
  if (typeof context !== "object" || context === null) return null;
  try {
    if (types.isProxy(context)) return null;
  } catch {
    return null;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(context, "priors");
  } catch {
    return null;
  }
  return descriptor === undefined || !("value" in descriptor) ? null : descriptor.value;
}

function costBasisOf(
  source: BudgetMeasurementSource, coverage: BudgetMeasurementCoverage,
  pricedMeters: readonly string[],
): ProviderUsageCostBasis {
  return {
    basis: coverage === "UNKNOWN" ? "UNPRICED" : "PROVIDER_REPORTED_TOKENS",
    coverage, source, pricedMeters: [...pricedMeters],
    pricebookBinding: null, spendMicros: null,
    unpricedReason: UNPRICED_BY_COVERAGE[coverage],
  };
}

/**
 * Maps one provider-run handoff onto the measurement authority. Every fact the
 * authority needs and this run did not observe is a refusal here rather than a
 * substituted placeholder: an interval, a sequence or a receipt that was never
 * observed cannot be invented without the invented value gaining authority.
 */
export function normalizeProviderUsage(
  handoff: ClaudeTelemetryHandoff, context: ProviderUsageContext,
): ProviderUsageResult {
  const { startedAt, completedAt } = handoff.launch;
  if (startedAt === null || completedAt === null) {
    return providerUsageRefusal("PROVIDER_USAGE_INTERVAL_UNOBSERVED", "USAGE_INPUT");
  }
  if (!handoff.sequence.known) {
    return providerUsageRefusal("PROVIDER_USAGE_SEQUENCE_UNKNOWN", "USAGE_INPUT");
  }
  if (!handoff.stdoutReceiptDigest.known) {
    return providerUsageRefusal("PROVIDER_USAGE_RECEIPT_UNKNOWN", "USAGE_INPUT");
  }
  const priors = priorIndex(readPriors(context));
  if (priors === null) {
    return providerUsageRefusal("PROVIDER_USAGE_PRIOR_UNREADABLE", "USAGE_INPUT");
  }
  const source = sourceOf(handoff);
  const base: RowBase = {
    providerRunRef: runRefOf(handoff.providerRunRef), sequence: handoff.sequence.value,
    rawReceiptDigest: handoff.stdoutReceiptDigest.value,
    observedInterval: { startRef: startedAt, endRef: completedAt },
    truncated: handoff.telemetryRefusal?.code === "TELEMETRY_CAPTURE_TRUNCATED",
  };
  const measurements: NormalizedMeasurement[] = [];
  const pricedMeters: string[] = [];
  for (const [field, meter] of TOKEN_METERS) {
    const fact = handoff.tokens[field];
    const verdict = normalizeUsageMeasurement({
      measurement: rowFor(meter, fact, source, base), pricebookBinding: null,
      truncated: base.truncated,
    }, priors.get(meter) ?? null);
    if (!verdict.ok) {
      return providerUsageRefusal("PROVIDER_USAGE_AUTHORITY_REFUSED", "USAGE_AUTHORITY",
        verdict.issues);
    }
    measurements.push(verdict.record);
    if (fact.known) pricedMeters.push(meter);
  }
  const coverage = COVERAGE_BY_SOURCE[source] ?? "UNKNOWN";
  return deepFreeze({
    ok: true as const, contractVersion: PROVIDER_USAGE_CONTRACT_VERSION,
    measurements, coverage, source, costBasis: costBasisOf(source, coverage, pricedMeters),
  });
}
