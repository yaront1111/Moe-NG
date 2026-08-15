/**
 * The provider-RUN RECORD seam: one frozen, provider-neutral statement of what a
 * run was, and the usage normalization behind it. `buildProviderRunRecord` is
 * the entry point a benchmark consumer holds; `normalizeProviderUsage` travels
 * with it because a consumer re-reading a stored handoff must be able to
 * re-derive the same measurements without rebuilding the whole record.
 *
 * The vocabularies come for the reason every closed union does here — a `basis`,
 * an `unpricedReason`, a refusal `code` or `layer` whose members cannot be read
 * is a field nobody can branch on — and `PROVIDER_USAGE_METERS` comes because a
 * consumer joining on a meter must not have to spell the identifier itself.
 * `ProviderUsageMeasurement` is an ALIAS of the scheduler's own record type, so
 * naming it here cannot drift from the normalizer that mints it.
 *
 * WITHHELD, matching the asymmetry the seam above already keeps:
 * `PROVIDER_USAGE_MESSAGES` and `providerUsageRefusal` stay internal. Both MINT
 * a refusal — a consumer able to call them could hand a downstream reader a
 * "normalization refused" record this package never produced, and a fabricated
 * refusal is as dangerous as a fabricated measurement. Consumers READ verdicts;
 * only this package mints them.
 */
export {
  PROVIDER_RUN_RECORD_VERSION,
  buildProviderRunRecord,
  type ProviderDecisionDigests,
  type ProviderModelSelection,
  type ProviderModelSnapshotKind,
  type ProviderObservedModel,
  type ProviderRunConcurrency,
  type ProviderRunIdentity,
  type ProviderRunRecord,
  type ProviderRuntimeEvidence,
  type ProviderStepCounts,
  type ProviderTokenCounts,
} from "../providers/telemetry/provider-run-record.js";
export {
  PROVIDER_COST_BASES,
  PROVIDER_UNPRICED_REASONS,
  PROVIDER_USAGE_CODES,
  PROVIDER_USAGE_CONTRACT_VERSION,
  PROVIDER_USAGE_LAYERS,
  PROVIDER_USAGE_METERS,
  PROVIDER_USAGE_SOURCE_PARSER_VERSION,
  type ProviderCostBasis,
  type ProviderUnpricedReason,
  type ProviderUsageCode,
  type ProviderUsageContext,
  type ProviderUsageCostBasis,
  type ProviderUsageLayer,
  type ProviderUsageMeasurement,
  type ProviderUsageNormalized,
  type ProviderUsageRefusal,
  type ProviderUsageResult,
} from "../providers/telemetry/provider-usage-contracts.js";
export { normalizeProviderUsage } from "../providers/telemetry/provider-usage-normalization.js";
