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
 * TWO NON-PROJECTION EXPORT FAMILIES, AND WHY NEITHER IS CAMPAIGN AUTHORITY. Neither adds
 * scoring, corpus handling, signature verification or campaign execution to this package.
 *
 * 1. `readConfirmatoryFreezeAuthority` and its pure record validator. No authority record
 *    is installed, so the zero-arity reader currently answers
 *    `CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED` at `CONFIRMATORY_FREEZE_AUTHORITY`. The
 *    validator makes a later human installation a strict data change; callers cannot feed
 *    their own bytes or path to the production reader.
 *
 * 2. `runPreFreezeAudit`. The pinned benchmark spec requires, at its Section 12.1, an
 *    automated namespace-and-reference audit that "must pass" before a campaign is frozen,
 *    "a failing audit blocks freeze; it is not a judgment call". This implements that
 *    section over the two pinned documents and publishes refusals at `PRE_FREEZE_AUDIT`
 *    with exact source locations.
 *
 *    IT READS ONLY BYTES IT HAS VERIFIED BY HASH. `readPinnedSource` refuses
 *    SPEC_BYTES_UNPINNED before decoding, and every parser takes a value only that
 *    function can mint, so no path in this package parses an unpinned document. A fixture
 *    cannot stand in for the spec, because nothing hashes to the spec's digest except the
 *    spec. Verifying that digest is NOT ratifying the revision: the audit answers whether
 *    exactly those bytes are internally consistent, and says nothing about their
 *    normativity, which remains a human question.
 *
 *    WHAT IT STILL DOES NOT DO, stated because a "pre-freeze" name invites the assumption:
 *    it creates and reads NO corpus bytes, admits NO freeze manifest, verifies NO
 *    signature, names NO custodian, executes NO campaign, computes NO score and decides NO
 *    claim. A passing audit is a necessary condition for a freeze and never a sufficient
 *    one — the authority reader above still refuses while no record is installed.
 */

export {
  ACTIVATION_GENERATION_KEYS, GA_ACTIVATION_BINDING_CODES, GA_ACTIVATION_BINDING_LAYER,
  GA_ACTIVATION_WORK_REF, GO_ACTIVATE_GATE_ID, admitActivationBinding,
} from "./activation-binding.js";
export type {
  ActivationBinding, ActivationBindingAdmission, ActivationBindingCode,
  ActivationBindingLayer, ActivationBindingRefusal, ActivationGenerationKey,
} from "./activation-binding.js";
export {
  GA_ACTIVATION_RECORD_CODES, GA_ACTIVATION_RECORD_LAYER, GA_ACTIVATION_RECORD_SCHEMA_VERSION,
  composeActivationRecord,
} from "./activation-record.js";
export type {
  ActivationBindingAdmitted, ActivationNotActivated, ActivationOutcome, ActivationRecord,
  ActivationRecordCode, ActivationRecordInput, ActivationRecordLayer, ActivationRecordRefusal,
  ActivationRecordResult,
} from "./activation-record.js";
export {
  CONFIRMATORY_FREEZE_AUTHORITY_CODE, CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
  CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH, readConfirmatoryFreezeAuthority,
} from "./confirmatory-freeze-authority.js";
export type {
  ConfirmatoryFreezeAuthorityReadResult, ConfirmatoryFreezeAuthorityRefusal,
} from "./confirmatory-freeze-authority.js";
export {
  CONFIRMATORY_FREEZE_AUTHORITY_CODES, validateConfirmatoryFreezeAuthorityRecord,
} from "./confirmatory-freeze-authority-contracts.js";
export type {
  ConfirmatoryFreezeAuthorityCode, ConfirmatoryFreezeAuthorityGrant,
  ConfirmatoryFreezeAuthorityRecord, ConfirmatoryFreezeAuthorityRecordSource,
  ConfirmatoryFreezeAuthorityValidation, ConfirmatoryFreezeAuthorityValidationRefusal,
} from "./confirmatory-freeze-authority-contracts.js";
export {
  PRE_FREEZE_AUDIT_CODES, PRE_FREEZE_AUDIT_LAYER, preFreezeAuditRefusal, preFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
export type {
  PreFreezeAuditCode, PreFreezeAuditRefusal, PreFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
export { auditPreFreezeSources, runPreFreezeAudit } from "./pre-freeze-audit.js";
export type { PreFreezeAuditReport, PreFreezeAuditSources } from "./pre-freeze-audit.js";
export { auditReferences } from "./pre-freeze-reference-audit.js";
export type { ReferenceAuditInput, ReferenceAuditReport } from "./pre-freeze-reference-audit.js";
export {
  TRIVALENT_VERDICTS, auditGateInventory, isReportBlock, parseReportBlock, resolveRungVerdict,
} from "./pre-freeze-gate-audit.js";
export type {
  GateDefinition, GateInventoryReport, GateVerdict, ReportBlock, RungGateSet,
} from "./pre-freeze-gate-audit.js";
export {
  auditComparatorCoverage, auditThresholds, collectConstantSymbols,
} from "./pre-freeze-threshold-audit.js";
export type {
  ComparatorCoverageReport, ComparatorVerdictTable, ThresholdAuditReport,
} from "./pre-freeze-threshold-audit.js";
export {
  EXPANDED_RANGE_SPAN_CAP, PINNED_SOURCE_BRAND,
  PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256, collectBareScenarioTokens,
  collectFamilyDefinitions, collectFamilyUses, collectGateIdUses, collectHeadingNumbers,
  collectSectionPointers, expandFamilyRange, isPinnedSource, readPinnedSource,
} from "./pre-freeze-source-reader.js";
export type { LocatedToken, PinnedSource } from "./pre-freeze-source-reader.js";
export {
  PINNED_BENCHMARK_SPEC_RELATIVE_PATH,
  PINNED_DOCUMENT_ROOT_ENV, PINNED_REBUILD_DESIGN_RELATIVE_PATH, isPinnedCorpusAuthority,
  isPinnedDocument, observePinnedCorpusAuthority, readPinnedBenchmarkSpec,
  readPinnedCorpusAuthority, readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";
export type {
  PinnedCorpusAuthority, PinnedDocument,
} from "./pre-freeze-pinned-documents.js";
export {
  CONFIRMATORY_FREEZE_BINDING_KINDS, CONFIRMATORY_FREEZE_MANIFEST_MAX_BYTES,
  FREEZE_MANIFEST_SCHEMA_VERSION, canonicalizeConfirmatoryFreezeManifest,
  decodeConfirmatoryFreezeManifest,
} from "./freeze-manifest-contracts.js";
export type {
  ConfirmatoryFreezeAttestation, ConfirmatoryFreezeBinding,
  ConfirmatoryFreezeBindingKind, ConfirmatoryFreezeManifest,
  ConfirmatoryFreezeManifestContractCode, ConfirmatoryFreezeManifestContractRefusal,
  ConfirmatoryFreezeManifestDecode,
} from "./freeze-manifest-contracts.js";
export {
  CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES, admitConfirmatoryFreezeManifest,
  deriveConfirmatoryFreezeCampaignId, deriveConfirmatoryFreezeManifestRegistryRef,
} from "./freeze-manifest-admission.js";
export type {
  ConfirmatoryFreezeCampaignIdentityInput, ConfirmatoryFreezeManifestAdmission,
  ConfirmatoryFreezeManifestAdmissionCode, ConfirmatoryFreezeManifestAdmissionRefusal,
} from "./freeze-manifest-admission.js";
export {
  FROZEN_COMPARABLE_COHORT_FLOOR, FROZEN_COMPARATOR_GATE_IDS, FROZEN_CONSTANT_SYMBOL_COUNT,
  FROZEN_GATE_IDS, FROZEN_GATE_THRESHOLD_SYMBOLS, FROZEN_NI_TAIL_DIRECTIONS,
  FROZEN_OUT_OF_LADDER_GATE_IDS, FROZEN_REFERENCE_CARDINALITY, FROZEN_RUNG_GATE_INVENTORY,
  FROZEN_RUNG_IDS, FROZEN_SCHEDULE_COVERAGE_FLOOR, FROZEN_SYMBOL_ASCII_ALIASES,
  FROZEN_UMBRELLA_GATE_IDS,
} from "./pre-freeze-audit-rosters.js";
export type {
  FrozenReferenceFamily, NiEndpointDirection, NiTail,
} from "./pre-freeze-audit-rosters.js";
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
export { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
export type {
  ProjectedClockObservation, ProjectedConcurrency, ProjectedDeclaredSelection,
  ProjectedFactUnknown, ProjectedLaunchFacts, ProjectedLaunchSelection, ProjectedLayeredIssue,
  ProjectedMeasurementRecord, ProjectedObservedModel, ProjectedPricebookBinding,
  ProjectedQuantity, ProjectedRecordKey, ProjectedRunRecord, ProjectedRunRef,
  ProjectedStepObservations, ProjectedText, ProjectedTokenObservations, ProjectedUpstreamRefusal,
  ProjectedUsageRefusal, ProjectedUsageRow,
} from "./benchmark-record-contracts.js";
