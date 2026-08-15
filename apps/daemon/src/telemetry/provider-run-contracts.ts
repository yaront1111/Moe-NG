/**
 * Frozen vocabulary for the durable provider-run telemetry ledger.
 *
 * This module declares names, shapes and one pure derivation. It launches no
 * provider, normalizes no usage and computes no digest — both halves arrive as
 * inputs produced by authorities that already exist (`@moe/runner` for the raw
 * launch telemetry, `@moe/scheduler` for the usage measurement) and are
 * persisted verbatim. The daemon is the only boundary that may depend on both,
 * which is why the composition lives here and not in either producer.
 *
 * EVERY RECORD FIELD IS TYPED FROM ITS PRODUCING PACKAGE'S PUBLIC ROOT. A
 * locally re-declared shape would let a producer change compile cleanly here and
 * diverge silently inside durable bytes, which is the one place divergence
 * cannot be corrected after the fact.
 *
 * THE TWO PROVENANCE VOCABULARIES NEVER MERGE. `upstreamRefusal` carries the
 * runner's own `ProviderTelemetryRefusal` — the provider seam refusing before
 * any measurement existed — while `usageRefusals` carries the scheduler's
 * `LayeredIssue`, which already says whether its CONTRACT or its MEASUREMENT
 * layer answered. Flattening them would make "which authority refused this run"
 * unanswerable from the durable bytes, and the bytes are all a later reader has.
 */

import type {
  ClaudeDeclaredSelection,
  ClaudeObservedModel,
  ClaudeStepObservations,
  ClaudeTelemetryConcurrency,
  ClaudeTelemetryLaunchFacts,
  ClaudeTokenObservations,
  ProviderInfrastructureOutcome,
  ProviderQuantity,
  ProviderRunRef,
  ProviderTelemetryRefusal,
  ProviderTerminalOutcome,
  ProviderText,
} from "@moe/runner";
import type { ClockObservation, LayeredIssue, NormalizedMeasurement } from "@moe/scheduler";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  StoredEvent,
} from "@moe/store";

/**
 * Closure for consumers of this record, re-exported rather than re-declared.
 * `NormalizedMeasurement.measurement` is a `UsageMeasurementRecord` whose
 * `observedInterval` is an `ObservedIntervalRefs`; without both names in reach a
 * consumer can read this record but never construct one, which is the same
 * closure gap the scheduler root documents at its own boundary.
 */
export type { ObservedIntervalRefs, UsageMeasurementRecord } from "@moe/scheduler";

export const PROVIDER_RUN_RECORD_VERSION = "moe-provider-run-record/1" as const;

/** The one event type this ledger writes and the only one its reader accepts. */
export const PROVIDER_RUN_EVENT_TYPE = "ProviderRunTelemetryCommitted" as const;

/**
 * One usage envelope the SCHEDULER refused, kept in the record rather than
 * dropped. A dropped envelope and an envelope the provider never emitted are
 * indistinguishable in the durable bytes, so a benchmark reading a record with
 * three accepted rows could not tell a fully measured run from one whose fourth
 * envelope was silently discarded.
 *
 * `providerSequence` is the envelope's position in the provider's ORIGINAL
 * emission order. It is the one fact the scheduler's own failure arm cannot
 * carry: `LayeredIssue` names the code and the layer, and the accepted arm
 * carries its sequence inside the measurement, but a refused envelope has no
 * measurement to carry it.
 */
export interface ProviderRunUsageRefusal {
  readonly providerSequence: number;
  readonly issues: readonly LayeredIssue[];
}

/**
 * The durable record: one provider run, whole.
 *
 * Every fact the launch telemetry and the usage measurement produced together,
 * so that a reader holding these bytes can answer without consulting any other
 * row or re-reading a provider receipt that may no longer exist.
 *
 * WHERE THE ENUMERATED DoD FACTS LIVE, so no later slice re-derives one that is
 * already bound: run/effect/attempt identity is `providerRunRef` whole; the
 * runtime identities are `launch`'s four runtime digests plus its effect,
 * activation and observation digests; the reasoning EFFORT and the PROFILE
 * revision are inside `declared`, which is the launch selection verbatim and is
 * therefore the only place they can be read without inventing a second copy.
 */
export interface ProviderRunRecord {
  readonly recordVersion: typeof PROVIDER_RUN_RECORD_VERSION;
  /** Run, effect and attempt identity, verbatim. Never three hand-rolled ids. */
  readonly providerRunRef: ProviderRunRef;
  /** Launch facts verbatim: runtime/profile digests and the wall interval. */
  readonly launch: ClaudeTelemetryLaunchFacts;
  /** What was ASKED FOR — selected model, reasoning effort, profile revision. */
  readonly declared: ClaudeDeclaredSelection;
  /**
   * What the provider's own bytes SAID. Never defaulted from `declared`: a
   * selection is not an observation, and merging them destroys the only
   * evidence that the provider ran the model it was asked to run.
   */
  readonly observedModel: ClaudeObservedModel;
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  /** Token counts with their own `ProviderCountCoverage`, verbatim. */
  readonly tokens: ClaudeTokenObservations;
  /** Step counts with their own `ProviderCountCoverage`, verbatim. */
  readonly steps: ClaudeStepObservations;
  readonly sequence: ProviderQuantity;
  /** Declared ceiling and the `ProviderConcurrencyFact` that classifies it. */
  readonly concurrency: ClaudeTelemetryConcurrency;
  /**
   * The daemon's OWN clock readings at the two ends of the run, each a
   * `ClockObservation` — wall seconds, boot identity and monotonic reading
   * together. Bound whole rather than reduced to a monotonic number: a
   * monotonic reading is only comparable against another from the SAME boot, so
   * a duration derived from a pair without `bootId` is unfalsifiable, and epic
   * rail 4 forbids unverifiable evidence gaining authority.
   *
   * DISTINCT FROM `launch.startedAt` / `launch.completedAt`, which are the
   * LAUNCHER's own wall stamps and stay verbatim. Two observers, deliberately
   * not reconciled: reconciling them would mean overwriting one with the other,
   * and the durable bytes would then no longer say which clock was read.
   * `null` is an unobserved reading and never a zero.
   */
  readonly observedStart: ClockObservation | null;
  readonly observedEnd: ClockObservation | null;
  /**
   * Normalized usage in the provider's original sequence, each row carrying its
   * own cost basis in `pricebookBinding`. A derived list price stays a binding
   * and never becomes an actual-cost claim, because the row is the scheduler's
   * own output and this module never mints one.
   */
  readonly usage: readonly NormalizedMeasurement[];
  /** Envelopes the scheduler refused, with their exact layered issues. */
  readonly usageRefusals: readonly ProviderRunUsageRefusal[];
  /** The PROVIDER seam's refusal, disjoint from every scheduler issue above. */
  readonly upstreamRefusal: ProviderTelemetryRefusal | null;
  readonly stdoutReceiptDigest: ProviderText;
  readonly stderrReceiptDigest: ProviderText;
  readonly recordDigest: string;
}

/**
 * The exact store surface this family uses — three methods, not the whole
 * `SqliteEventStore`. `commitExpectedVersionDecisionWithApply` and
 * `commitWithApply` are absent BY CONSTRUCTION: `CommitApply` hands out a raw
 * `DatabaseSync` for callers who write their own tables, which the no-new-schema
 * rail forbids here, and a port that cannot NAME them cannot reach for them.
 * This is the only slice that can build that guard; no later test recovers it.
 */
export interface ProviderRunStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

const AGGREGATE_NAMESPACE = `${PROVIDER_RUN_RECORD_VERSION}|aggregate|`;

const framed = (component: string): string => `${component.length}:${component}`;

/**
 * Derives this ledger's aggregate id from the run identity, so one provider run
 * is one aggregate head and the ledger can borrow conflict detection from the
 * store's expected-version check instead of hand-rolling one.
 *
 * INJECTIVE BY CONSTRUCTION. Each component is preceded by its own code-unit
 * length, so distinct identities cannot produce one string. A bare join would
 * map runRef 'a'/effect 'bc' onto the SAME aggregate as runRef 'ab'/effect 'c',
 * and because every run commits from expected version 0 that single bug would
 * both accept a second run that should have conflicted and refuse a first run
 * that should have been accepted. A separator alone is not enough either: a
 * component containing the separator re-splits.
 *
 * THE SEPARATOR MUST ALSO BE A LEGAL IDENTIFIER CHARACTER. The store's
 * `requireIdentifier` rejects any identifier containing a NUL — the obvious
 * delimiter — and it rejects it at commit time, after the framing table, the
 * codec and every injectivity row have gone green.
 *
 * WHAT THIS DOES NOT DO, stated so no caller reads more into it. It VALIDATES
 * NOTHING. The framing is injective over the components as strings, but the
 * runner's own `snapshotRunRef` and its bounded-ref alphabet are what make a
 * `ProviderRunRef` admissible in the first place, and the runner deliberately
 * withholds that minter from its package root. So a ref that never came from a
 * handoff can still carry an unbounded, unprintable or accessor-backed field
 * straight into this string. Callers must take the ref FROM the handoff; the
 * store's identifier check is the backstop, not this function.
 */
export function deriveProviderRunAggregateId(ref: ProviderRunRef): string {
  const identity = [ref.provider, ref.runRef, ref.effectIntentId, ref.attemptRef, String(ref.epoch)];
  return `${AGGREGATE_NAMESPACE}${identity.map(framed).join("|")}`;
}
