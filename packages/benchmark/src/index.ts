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
 * SHAPE MEANS EVERY FIELD THIS PACKAGE READS, AT EVERY DEPTH IT READS IT. Checking only
 * the top-level KIND of a container the projector then reads INTO is not a shape check;
 * it is a shape check that stops one level above where the reading happens. An empty
 * object passes `isPlainRecord` and its absent members read back as `undefined`, which is
 * not a refusal but a value — so `{known: true, value: undefined}` gets published, and
 * missing evidence has gained an observation's authority in silence. Admission therefore
 * guards each container down to the fields projected out of it, and no further: a field
 * this package never reads is a field it has no standing to judge.
 *
 * THE VERSION SEAM, AND WHAT IT CANNOT REACH. `PROJECTED_RECORD_VERSION` is
 * "moe-provider-run-record/1", declared here as its own literal and pinned against the
 * daemon's `PROVIDER_RUN_RECORD_VERSION`. Admission refuses every other value, so when
 * the RECORD schema moves this package reddens rather than projecting a shape it no
 * longer understands — the whole reason the literal is duplicated instead of inferred.
 *
 * That seam pins one string, and the record is not the only producer. Its inner types —
 * `ClaudeLaunchSelection`, `ProviderText`, `LayeredIssue` and their neighbours — belong to
 * @moe/runner and @moe/scheduler and move on their OWN version lines. A renamed field
 * inside one of them arrives with `recordVersion` untouched, so the version guard cannot
 * see it and only the nested shape guards can. The two seams cover different drifts and
 * neither substitutes for the other.
 *
 * THREE REFUSAL SOURCES, NEVER FLATTENED. `usageRefusals` are the scheduler's layered
 * issues, `upstreamRefusal` is the provider seam's, and this package's own frozen codes
 * cover only what IT could not project. Flattening them would make a scheduler issue
 * indistinguishable from a provider refusal, and the durable bytes are all a later
 * reader has.
 *
 * THE ONE NON-PROJECTION EXPORT, AND WHY IT IS NOT A WIDENING. `readConfirmatoryFreezeAuthority`
 * publishes a REFUSAL, never a capability: the confirmatory corpus has no author,
 * custodian, signing key, or registry, so the reader always answers
 * `CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED` at `CONFIRMATORY_FREEZE_AUTHORITY`. It adds
 * no scoring, no corpus handling, no signature verification, and no campaign execution
 * to this package — a consumer can learn from it only that nobody may freeze and seal,
 * which is exactly the fact a downstream admission path must fail closed on.
 */

export {
  CONFIRMATORY_FREEZE_AUTHORITY_CODE, CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
  readConfirmatoryFreezeAuthority,
} from "./confirmatory-freeze-authority.js";
export type { ConfirmatoryFreezeAuthorityRefusal } from "./confirmatory-freeze-authority.js";
export {
  BENCHMARK_COST_BASES, BENCHMARK_PROJECTION_CODES, BENCHMARK_PROJECTION_LAYERS,
  BENCHMARK_PROJECTION_MESSAGES, BENCHMARK_UNKNOWN_BASES, benchmarkProjectionRefusal,
} from "./benchmark-projection-vocabulary.js";
export type {
  BenchmarkCostBasis, BenchmarkProjectionCode, BenchmarkProjectionLayer,
  BenchmarkProjectionRefusal, BenchmarkUnknownBasis, BenchmarkValue,
} from "./benchmark-projection-vocabulary.js";
export { admitRunRecord } from "./benchmark-record-admission.js";
export type { BenchmarkAdmission } from "./benchmark-record-admission.js";
export { projectCostClass, projectCounts } from "./benchmark-cost-projection.js";
export type { BenchmarkCostRow, BenchmarkCounts } from "./benchmark-cost-projection.js";
export { projectBenchmarkRun } from "./benchmark-run-projection.js";
export type {
  BenchmarkEffort, BenchmarkEvidenceReceipt, BenchmarkModelEvidence, BenchmarkProjectionResult,
  BenchmarkRecordRefusals, BenchmarkReproducibility, BenchmarkRunProjection, BenchmarkSettings,
  BenchmarkTiming,
} from "./benchmark-run-projection.js";
export {
  FIXTURE_OBSERVED_END, FIXTURE_OBSERVED_END_OTHER_BOOT, FIXTURE_OBSERVED_START,
  FIXTURE_USAGE_ROW, FIXTURE_USAGE_ROW_UNMEASURED, completeRunRecordFixture,
  unknownFactFixture, unobservedRunRecordFixture,
} from "./benchmark-record-fixture.js";
export { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
export type {
  ProjectedClockObservation, ProjectedConcurrency, ProjectedDeclaredSelection,
  ProjectedFactUnknown, ProjectedLaunchFacts, ProjectedLaunchSelection, ProjectedLayeredIssue,
  ProjectedMeasurementRecord, ProjectedObservedModel, ProjectedPricebookBinding,
  ProjectedQuantity, ProjectedRecordKey, ProjectedRunRecord, ProjectedRunRef,
  ProjectedStepObservations, ProjectedText, ProjectedTokenObservations, ProjectedUpstreamRefusal,
  ProjectedUsageRefusal, ProjectedUsageRow,
} from "./benchmark-record-contracts.js";
