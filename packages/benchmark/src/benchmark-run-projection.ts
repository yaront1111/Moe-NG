/**
 * The projector: one durable provider-run record in, one row set out.
 *
 * IT PROJECTS. IT NEVER DECIDES. Nothing here re-derives a fact the daemon's codec
 * established, recomputes a digest, mints a measurement, or compares this run to another.
 * Every column below is either a value carried verbatim or an explicit UNKNOWN naming
 * why it is unknown.
 *
 * THE THREE COLUMN PAIRS THAT MUST NEVER MERGE, each guarding a rule the record's own
 * contract states:
 *  - `effort`/`settings` (what was ASKED FOR, from `declared`) against `modelEvidence`
 *    (what the provider's BYTES SAID, from `observedModel`). A selection is not an
 *    observation; merging them destroys the only evidence that the provider ran the model
 *    it was asked to run. The same trap runs through concurrency, where a declared
 *    ceiling sits next to an achieved reading the pinned schema cannot supply.
 *  - `timing.launcher*` (the LAUNCHER's wall stamps) against `timing.daemon*` (the
 *    daemon's own clock readings). Two observers, deliberately not reconciled: the one
 *    derived duration is taken from the daemon's monotonic pair alone, and only when both
 *    readings share a boot, because a monotonic delta across boots is unfalsifiable.
 *  - `refusals.scheduler` (layered issues from the scheduler) against `refusals.provider`
 *    (the provider seam's own refusal). Flattening them would make "which authority
 *    refused this run" unanswerable from the durable bytes. This harness's OWN codes are
 *    a third vocabulary and never appear in either column: when it cannot project, it
 *    returns a refusal instead of a projection, so the three can never be confused.
 */

import { admitRunRecord } from "./benchmark-record-admission.js";
import { projectCostClass, projectCounts } from "./benchmark-cost-projection.js";
import type { BenchmarkCostRow, BenchmarkCounts } from "./benchmark-cost-projection.js";
import {
  factCell, knownCell, nullableCell, producerUnknownCell, unknownCell,
} from "./benchmark-projection-cells.js";
import type { BenchmarkProjectionRefusal, BenchmarkValue } from "./benchmark-projection-vocabulary.js";
import type {
  ProjectedClockObservation, ProjectedDeclaredSelection, ProjectedLaunchSelection,
  ProjectedRunRecord, ProjectedRunRef, ProjectedUpstreamRefusal, ProjectedUsageRefusal,
} from "./benchmark-record-contracts.js";

/** What the provider's own bytes said about the model. Never defaulted from `declared`. */
export interface BenchmarkModelEvidence {
  readonly observedModelId: BenchmarkValue<string>;
  readonly snapshotKind: string;
  readonly snapshotEvidence: BenchmarkValue<string>;
}

/** What was ASKED FOR. The only place reasoning effort and profile revision exist. */
export interface BenchmarkEffort {
  readonly declaredModelId: BenchmarkValue<string>;
  readonly reasoningEffort: BenchmarkValue<string>;
  readonly profileRevisionId: BenchmarkValue<string>;
}

export interface BenchmarkSettings {
  readonly configurationDigest: BenchmarkValue<string>;
  readonly policyDigest: BenchmarkValue<string>;
  readonly orchestrationDigest: BenchmarkValue<string>;
  readonly concurrencyFact: string;
  readonly declaredConcurrencyCeiling: BenchmarkValue<number>;
  readonly achievedConcurrency: BenchmarkValue<number>;
}

/** Both observers, side by side. No column here mixes one observer's stamp with another's. */
export interface BenchmarkTiming {
  readonly launcherStartedAt: BenchmarkValue<string>;
  readonly launcherCompletedAt: BenchmarkValue<string>;
  readonly daemonStart: BenchmarkValue<ProjectedClockObservation>;
  readonly daemonEnd: BenchmarkValue<ProjectedClockObservation>;
  readonly daemonMonotonicDuration: BenchmarkValue<number>;
}

/** Receipts carried verbatim so a later reader can compare them. Never recomputed here. */
export interface BenchmarkEvidenceReceipt {
  readonly stdoutReceiptDigest: BenchmarkValue<string>;
  readonly stderrReceiptDigest: BenchmarkValue<string>;
  readonly recordDigest: string;
}

export interface BenchmarkReproducibility {
  readonly effectDigest: BenchmarkValue<string>;
  readonly activationDigest: BenchmarkValue<string>;
  readonly runtimeBindingDigest: BenchmarkValue<string>;
  readonly quotedRuntimeDigest: BenchmarkValue<string>;
  readonly freshRuntimeDigest: BenchmarkValue<string>;
  readonly pinnedClosureDigest: BenchmarkValue<string>;
  readonly observationDigest: BenchmarkValue<string>;
}

/** Two disjoint sources, carried verbatim and never merged into one list. */
export interface BenchmarkRecordRefusals {
  readonly scheduler: readonly ProjectedUsageRefusal[];
  readonly provider: ProjectedUpstreamRefusal | null;
}

export interface BenchmarkRunProjection {
  readonly runIdentity: ProjectedRunRef;
  readonly modelEvidence: BenchmarkModelEvidence;
  readonly effort: BenchmarkEffort;
  readonly settings: BenchmarkSettings;
  readonly timing: BenchmarkTiming;
  readonly counts: BenchmarkCounts;
  readonly costClass: readonly BenchmarkCostRow[];
  readonly evidenceReceipt: BenchmarkEvidenceReceipt;
  readonly reproducibility: BenchmarkReproducibility;
  readonly refusals: BenchmarkRecordRefusals;
}

export type BenchmarkProjectionResult =
  | { readonly ok: true; readonly projection: BenchmarkRunProjection }
  | BenchmarkProjectionRefusal;

/**
 * Reads one field of the declared selection. When the selection was unreadable the cell
 * is UNKNOWN under `SELECTION_UNREADABLE`, carrying the producer's own code — never
 * substituted from a digest, a runtime identity or an observed value, each of which is
 * nearby and none of which is what was asked for.
 */
function declaredCell<T>(
  declared: ProjectedDeclaredSelection,
  read: (selection: ProjectedLaunchSelection) => T,
): BenchmarkValue<T> {
  if (declared.known) return knownCell(read(declared.selection));
  return producerUnknownCell<T>(declared, "SELECTION_UNREADABLE");
}

/**
 * The harness's ONE derived number, and the only place it can be derived.
 *
 * A `ClockObservation` binds wall seconds, boot identity and monotonic reading together
 * because a monotonic reading is comparable only against another from the SAME boot. A
 * delta across two boots is not a long duration or a short one; it is not a duration at
 * all, and epic rail 4 forbids unverifiable evidence gaining authority. The wall seconds
 * sitting right there are deliberately not used as a fallback: falling back would answer
 * with a different observer's measurement under the same column name.
 */
function projectDuration(
  start: ProjectedClockObservation | null,
  end: ProjectedClockObservation | null,
): BenchmarkValue<number> {
  if (start === null || end === null) return unknownCell<number>("OBSERVATION_ABSENT");
  if (start.bootId !== end.bootId) return unknownCell<number>("BOOT_IDENTITY_MISMATCH");
  return knownCell(end.monotonicObservation - start.monotonicObservation);
}

function projectTiming(record: ProjectedRunRecord): BenchmarkTiming {
  const { launch, observedStart, observedEnd } = record;
  return {
    launcherStartedAt: nullableCell(launch.startedAt),
    launcherCompletedAt: nullableCell(launch.completedAt),
    daemonStart: nullableCell(observedStart),
    daemonEnd: nullableCell(observedEnd),
    daemonMonotonicDuration: projectDuration(observedStart, observedEnd),
  };
}

function projectReproducibility(record: ProjectedRunRecord): BenchmarkReproducibility {
  const { launch } = record;
  return {
    effectDigest: nullableCell(launch.effectDigest),
    activationDigest: nullableCell(launch.activationDigest),
    runtimeBindingDigest: nullableCell(launch.runtimeBindingDigest),
    quotedRuntimeDigest: nullableCell(launch.quotedRuntimeDigest),
    freshRuntimeDigest: nullableCell(launch.freshRuntimeDigest),
    pinnedClosureDigest: nullableCell(launch.pinnedClosureDigest),
    observationDigest: nullableCell(launch.observationDigest),
  };
}

function projectRecord(record: ProjectedRunRecord): BenchmarkRunProjection {
  const { concurrency, declared, observedModel } = record;
  return {
    runIdentity: record.providerRunRef,
    modelEvidence: {
      observedModelId: factCell(observedModel.modelId),
      snapshotKind: observedModel.snapshotKind,
      snapshotEvidence: factCell(observedModel.snapshotEvidence),
    },
    effort: {
      declaredModelId: declaredCell(declared, (s) => s.selectedModelId),
      reasoningEffort: declaredCell(declared, (s) => s.reasoningEffort),
      profileRevisionId: declaredCell(declared, (s) => s.profileRevisionId),
    },
    settings: {
      configurationDigest: declaredCell(declared, (s) => s.configurationDigest),
      policyDigest: declaredCell(declared, (s) => s.policyDigest),
      orchestrationDigest: declaredCell(declared, (s) => s.orchestrationDigest),
      concurrencyFact: concurrency.fact,
      declaredConcurrencyCeiling: factCell(concurrency.declaredCeiling),
      achievedConcurrency: factCell(concurrency.achieved),
    },
    timing: projectTiming(record),
    counts: projectCounts(record),
    costClass: projectCostClass(record),
    evidenceReceipt: {
      stdoutReceiptDigest: factCell(record.stdoutReceiptDigest),
      stderrReceiptDigest: factCell(record.stderrReceiptDigest),
      recordDigest: record.recordDigest,
    },
    reproducibility: projectReproducibility(record),
    refusals: { scheduler: record.usageRefusals, provider: record.upstreamRefusal },
  };
}

/**
 * Projects one record. Admission answers first, so a record this harness cannot read
 * yields a refusal carrying this package's own code and layer rather than a partial row
 * set — a half-projected run would be evidence with a hole in it that no later reader
 * could see.
 */
export function projectBenchmarkRun(input: unknown): BenchmarkProjectionResult {
  const admitted = admitRunRecord(input);
  if (!admitted.ok) return admitted;
  return { ok: true, projection: projectRecord(admitted.record) };
}
