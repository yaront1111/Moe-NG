/**
 * Provider usage vocabulary: the meters a provider run is measured in, this
 * seam's own refusal codes and layers, and the cost-BASIS classes.
 *
 * SEPARATE FROM THE MAPPING on purpose. A consumer that must NAME what it
 * received — a meter, a refusal, an unpriced reason — needs these identifiers;
 * it does not need, and must not reach, the mapping that mints a measurement.
 *
 * THE COST BASIS CARRIES NO SPEND. `spendMicros` is typed `null`, not
 * `number | null`, so no arithmetic anywhere downstream can turn PARTIAL or
 * UNKNOWN token evidence into a spend figure: the type has no arm to put one in.
 * What IS published is the basis a pricer would need — which meters carry a
 * measured quantity, at what coverage, from what source, and why the total is
 * unpriced.
 */
import type {
  BudgetMeasurementCoverage, BudgetMeasurementSource, LayeredIssue, NormalizedMeasurement,
} from "@moe/scheduler";

import { deepFreeze } from "../../canonical.js";

export const PROVIDER_USAGE_CONTRACT_VERSION = "moe-provider-usage/1" as const;

/** Provider-NEUTRAL meter names: a consumer joins on these, not on Claude's spelling. */
export const PROVIDER_USAGE_METERS = Object.freeze({
  inputTokens: "provider.input_tokens",
  outputTokens: "provider.output_tokens",
  cacheCreationInputTokens: "provider.cache_creation_input_tokens",
  cacheReadInputTokens: "provider.cache_read_input_tokens",
} as const);

/**
 * The receipt revision this mapping speaks for, pinned as a literal rather than
 * read out of the supported set: a set that grew a member would otherwise
 * silently change what this module CLAIMS to have parsed. Whether the value is
 * still supported is the authority's judgement to make, not this module's.
 */
export const PROVIDER_USAGE_SOURCE_PARSER_VERSION = 1;

export const PROVIDER_USAGE_CODES = Object.freeze([
  "PROVIDER_USAGE_AUTHORITY_REFUSED", "PROVIDER_USAGE_INTERVAL_UNOBSERVED",
  "PROVIDER_USAGE_PRIOR_UNREADABLE", "PROVIDER_USAGE_RECEIPT_UNKNOWN",
  "PROVIDER_USAGE_SEQUENCE_UNKNOWN",
] as const);
/** WHICH layer answered: this seam's own input checks, or the measurement authority. */
export const PROVIDER_USAGE_LAYERS = Object.freeze(["USAGE_INPUT", "USAGE_AUTHORITY"] as const);
export const PROVIDER_COST_BASES =
  Object.freeze(["PROVIDER_REPORTED_TOKENS", "UNPRICED"] as const);
export const PROVIDER_UNPRICED_REASONS = Object.freeze([
  "NO_PRICEBOOK_ON_THIS_SEAM", "COVERAGE_INCOMPLETE", "COVERAGE_UNKNOWN",
] as const);

export type ProviderUsageCode = (typeof PROVIDER_USAGE_CODES)[number];
export type ProviderUsageLayer = (typeof PROVIDER_USAGE_LAYERS)[number];
export type ProviderCostBasis = (typeof PROVIDER_COST_BASES)[number];
export type ProviderUnpricedReason = (typeof PROVIDER_UNPRICED_REASONS)[number];

/** Static per-code messages: nothing interpolated, so no captured byte is echoed back. */
export const PROVIDER_USAGE_MESSAGES: Readonly<Record<ProviderUsageCode, string>> = Object.freeze({
  PROVIDER_USAGE_AUTHORITY_REFUSED: "the measurement authority refused this observation",
  PROVIDER_USAGE_INTERVAL_UNOBSERVED: "the run reports no observed start and end",
  PROVIDER_USAGE_PRIOR_UNREADABLE: "a prior observation is not a normalizer-issued record",
  PROVIDER_USAGE_RECEIPT_UNKNOWN: "the run reports no readable stdout receipt digest",
  PROVIDER_USAGE_SEQUENCE_UNKNOWN: "the run reports no observation sequence",
});

/**
 * The authority's own record type under a name a consumer of THIS package can
 * say. An alias, never a copy: it is the same type identity, so it cannot drift
 * from the normalizer that mints it.
 */
export type ProviderUsageMeasurement = NormalizedMeasurement;

export interface ProviderUsageCostBasis {
  readonly basis: ProviderCostBasis;
  readonly coverage: BudgetMeasurementCoverage;
  readonly source: BudgetMeasurementSource;
  /** Meters carrying a measured quantity: what a pricer could price, nothing more. */
  readonly pricedMeters: readonly string[];
  readonly pricebookBinding: null;
  readonly spendMicros: null;
  readonly unpricedReason: ProviderUnpricedReason;
}
export interface ProviderUsageNormalized {
  readonly ok: true;
  readonly contractVersion: typeof PROVIDER_USAGE_CONTRACT_VERSION;
  readonly measurements: readonly NormalizedMeasurement[];
  readonly coverage: BudgetMeasurementCoverage;
  readonly source: BudgetMeasurementSource;
  readonly costBasis: ProviderUsageCostBasis;
}
/** Own code and own layer, with the authority's issues carried separately and verbatim. */
export interface ProviderUsageRefusal {
  readonly ok: false;
  readonly code: ProviderUsageCode;
  readonly layer: ProviderUsageLayer;
  readonly message: string;
  readonly upstream: readonly LayeredIssue[];
}
export type ProviderUsageResult = ProviderUsageNormalized | ProviderUsageRefusal;
export interface ProviderUsageContext {
  /** The last accepted observation per meter, as returned by a previous call. */
  readonly priors: readonly NormalizedMeasurement[];
}

export function providerUsageRefusal(
  code: ProviderUsageCode, layer: ProviderUsageLayer, upstream: readonly LayeredIssue[] = [],
): ProviderUsageRefusal {
  return deepFreeze({
    ok: false as const, code, layer, message: PROVIDER_USAGE_MESSAGES[code], upstream: [...upstream],
  });
}
