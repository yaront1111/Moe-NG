/**
 * Public seam for the benchmark telemetry harness.
 *
 * THIS PACKAGE PROJECTS. IT NEVER DECIDES.
 *
 * It turns one durable provider-run record into the machine-readable rows the pinned
 * benchmark requires — run identity, cost class, timing, effort, settings, evidence
 * receipt, reproducibility — and it does nothing else. It re-derives no fact the
 * daemon's codec already established, recomputes no digest, mints no measurement, and
 * compares no two runs. A second validator that re-judged sealed evidence would be a
 * competing authority over bytes that already have one; the codec is the only authority
 * on what is a record, and this package reads its output rather than its job.
 *
 * WHAT THAT RULES OUT, stated so the line stays visible: no scoring, no ranking, no
 * claim decisions, no corpus bytes. Comparing arms belongs to the campaign that consumes
 * this harness, not to the harness. A projector that ranked its inputs would be deciding
 * the claim it exists to measure.
 *
 * THE INPUT BOUNDARY. Records arrive as BOUNDED PLAIN DATA, already decoded and already
 * sealed. `ProviderRunRecord` is declared in `apps/daemon` and a package cannot import
 * from an app, so the type cannot be taken by reference. Admission therefore validates
 * SHAPE ONLY, answering "is this the schema I project?" and nothing more.
 *
 * THE VERSION SEAM. `PROJECTED_RECORD_VERSION` is "moe-provider-run-record/1", declared
 * here as its own literal and pinned against the daemon's `PROVIDER_RUN_RECORD_VERSION`.
 * Admission refuses every other value. When the record schema moves, this package
 * reddens rather than projecting a shape it no longer understands — which is the whole
 * reason the literal is duplicated instead of inferred.
 *
 * THREE REFUSAL SOURCES, NEVER FLATTENED. `usageRefusals` are the scheduler's layered
 * issues, `upstreamRefusal` is the provider seam's, and this package's own frozen codes
 * cover only what IT could not project. Flattening them would make a scheduler issue
 * indistinguishable from a provider refusal, and the durable bytes are all a later
 * reader has.
 */

export {
  BENCHMARK_PROJECTION_CODES, BENCHMARK_PROJECTION_LAYERS, BENCHMARK_PROJECTION_MESSAGES,
  benchmarkProjectionRefusal,
} from "./benchmark-projection-vocabulary.js";
export type {
  BenchmarkProjectionCode, BenchmarkProjectionLayer, BenchmarkProjectionRefusal,
} from "./benchmark-projection-vocabulary.js";
export { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
export type {
  ProjectedClockObservation, ProjectedConcurrency, ProjectedDeclaredSelection,
  ProjectedFactUnknown, ProjectedLaunchFacts, ProjectedLaunchSelection, ProjectedLayeredIssue,
  ProjectedMeasurementRecord, ProjectedObservedModel, ProjectedPricebookBinding,
  ProjectedQuantity, ProjectedRecordKey, ProjectedRunRecord, ProjectedRunRef,
  ProjectedStepObservations, ProjectedText, ProjectedTokenObservations, ProjectedUpstreamRefusal,
  ProjectedUsageRefusal, ProjectedUsageRow,
} from "./benchmark-record-contracts.js";
