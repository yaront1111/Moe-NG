/**
 * Frozen vocabulary for the durable provider-run telemetry ledger.
 *
 * This module declares names, shapes and one pure derivation. It launches no
 * provider, normalizes no usage and computes no RECORD digest. Its fields bind
 * published producer shapes from `@moe/runner` and `@moe/scheduler`; later
 * composition, codec and ledger slices own population and persistence. The
 * daemon is the direction-safe boundary that may depend on both producers.
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

import { createHash } from "node:crypto";

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

/** Reserved as the event type for this family's future ledger writer and reader. */
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
 * The durable record contract for one provider run.
 *
 * It binds the reviewed launch facts and normalized measurements needed by a
 * later reader without pretending to be a byte-for-byte `ClaudeTelemetryHandoff`:
 * handoff/parser envelope versions are not duplicated as run facts here.
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
 * The exact store surface this family's future ledger may use — three methods, not the whole
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

const AGGREGATE_NAMESPACE = `${PROVIDER_RUN_RECORD_VERSION}|aggregate|sha256:`;
const AGGREGATE_ID_DOMAIN = "moe.provider-run.aggregate-id.v1";
const textEncoder = new TextEncoder();

function aggregateIdentityDigest(components: readonly string[]): string {
  const hash = createHash("sha256").update(`${AGGREGATE_ID_DOMAIN}\u0000`, "utf8");
  for (const component of components) {
    const bytes = textEncoder.encode(component);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Derives this ledger's aggregate id from the run identity, so one provider run
 * is one aggregate head and the ledger can borrow conflict detection from the
 * store's expected-version check instead of hand-rolling one.
 *
 * BOUNDED AND COLLISION-RESISTANT. Every component is UTF-8-length-framed before
 * a domain-separated SHA-256 digest, so field boundaries and all five identity
 * facts affect a fixed-size store identifier. A bare join would map runRef
 * 'a'/effect 'bc' onto the same bytes as runRef 'ab'/effect 'c'; a separator
 * alone is insufficient because a component may contain that separator.
 *
 * THE FIXED SIZE IS LOAD-BEARING. A producer-admitted run ref may contain three
 * 200-byte identity fields; preserving those frames in the aggregate id exceeds
 * the store's 512-byte identifier ceiling and makes every later commit refuse
 * with STORE_INPUT_INVALID. Only the digest is stored in the id; the complete
 * identity remains inside the record and later readers must compare it rather
 * than treating hash uniqueness as authority.
 *
 * WHAT THIS DOES NOT DO, stated so no caller reads more into it. It VALIDATES
 * NOTHING. The runner's own `snapshotRunRef` and bounded-ref alphabet are what
 * make a `ProviderRunRef` admissible, and the runner deliberately withholds that
 * minter from its package root. Hashing a caller-forged ref into a bounded string
 * does not make that ref trustworthy; callers must still take it from the
 * validated handoff.
 */
export function deriveProviderRunAggregateId(ref: ProviderRunRef): string {
  const identity = [ref.provider, ref.runRef, ref.effectIntentId, ref.attemptRef, String(ref.epoch)];
  return `${AGGREGATE_NAMESPACE}${aggregateIdentityDigest(identity)}`;
}
