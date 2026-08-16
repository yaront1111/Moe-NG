/**
 * The wire between the activation path's telemetry launch and the durable
 * provider-run ledger: compose one record from the runner's handoff, commit it
 * exactly once, and answer with whatever authority spoke.
 *
 * ## WHAT THIS MODULE OWNS, AND THE FOUR THINGS IT DELIBERATELY DOES NOT
 *
 * It owns the PROJECTION and nothing else. Usage normalization belongs to
 * `@moe/runner`'s `buildProviderRunRecord`, which reaches `@moe/scheduler`'s
 * measurement authority; the record digest belongs to the codec, which mints it
 * over the canonical record with the field excluded; structural admission belongs
 * to the codec too; identity, replay and conflict belong to the ledger. Each of
 * those already has exactly one owner, and a second opinion here would be the one
 * a later reader trusted.
 *
 * ## TWO RECORD TYPES SHARE ONE NAME, AND THEY ARE NOT INTERCHANGEABLE
 *
 * `@moe/runner`'s `ProviderRunRecord` is the provider-NEUTRAL statement a
 * benchmark consumer reads; this daemon's `ProviderRunRecord` is the DURABLE
 * contract the codec admits, and its required keys — `providerRunRef`, `launch`,
 * `declared`, `sequence`, `usageRefusals`, the two receipt digests — do not exist
 * on the runner's shape at all. Handing one to the codec refuses every time. So
 * the launch facts, the declared selection, the observed model, the counts, the
 * concurrency and the receipts travel VERBATIM from the handoff, and the runner's
 * record contributes the one fact the handoff does not carry: normalized usage.
 *
 * ## `ok: true` IS NOT SUCCESS, AND THE DECISION HERE IS DELIBERATE
 *
 * The launcher reaches `ok: false` only for a run reference it could not
 * snapshot. That arm is NOT committable and is returned unchanged: without the
 * five identity facts there is nothing to key an aggregate on, and synthesising
 * one would durably attribute an event to a run that never had an identity.
 *
 * A launcher that REFUSED before any provider bytes existed, and a delivery that
 * launched no process at all, both arrive `ok: true` carrying a BLIND handoff
 * whose facts are UNKNOWN. Those ARE committed. Epic rail 4 keeps unverifiable
 * evidence UNKNOWN and denies it authority; it does not say the evidence goes
 * unrecorded, and a ledger that withheld blind runs could not distinguish a
 * refused launch from a launch that never happened. The durable falsehood would
 * be committing one AS IF OBSERVED, which is exactly what the verbatim carry
 * prevents: an UNKNOWN fact stays UNKNOWN, and `upstreamRefusal` travels with it
 * saying which refusal produced it.
 *
 * ## NEITHER `commitWithApply` NOR `commitExpectedVersionDecisionWithApply`
 *
 * Both are unreachable from here by construction rather than by discipline: the
 * narrow `ProviderRunStore` port cannot NAME them, because `CommitApply` hands a
 * callback a raw `DatabaseSync` for callers that write their own tables and the
 * no-new-schema rail forbids that.
 */
import { buildProviderRunRecord } from "@moe/runner";
import type {
  ClaudeTelemetryHandoff,
  ClaudeTelemetryLaunchResult,
  ProviderTelemetryRefusal,
  ProviderUsageResult,
} from "@moe/runner";
import type { ClockObservation, NormalizedMeasurement } from "@moe/scheduler";
import type { CommandDecisionKey } from "@moe/store";

import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type {
  ProviderRunRecord,
  ProviderRunStore,
  ProviderRunUsageRefusal,
} from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import type { ProviderRunCommitResult } from "../telemetry/provider-run-ledger.js";
import {
  PROVIDER_RUN_LEDGER_LAYERS,
  providerRunRefusal,
} from "../telemetry/provider-run-refusals.js";
import type { ProviderRunRefusal } from "../telemetry/provider-run-refusals.js";

/** "the composition before any record exists" — this module's reserved layer. */
const COMPOSITION = PROVIDER_RUN_LEDGER_LAYERS[0];

/**
 * The daemon's OWN clock readings at the two ends of the run. Distinct from the
 * launcher's `startedAt`/`completedAt`, which stay verbatim inside `launch`: two
 * observers, deliberately not reconciled, because reconciling them would overwrite
 * one and the durable bytes would no longer say which clock was read. `null` is an
 * unobserved reading and never a zero.
 */
export interface ActivationRunClockFacts {
  readonly observedStart: ClockObservation | null;
  readonly observedEnd: ClockObservation | null;
}

export interface ActivationRunCommitInput {
  /** The runner's result exactly as `launchActivationProviderRun` returned it. */
  readonly launch: ClaudeTelemetryLaunchResult;
  readonly clock: ActivationRunClockFacts;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly key: CommandDecisionKey;
  readonly requestBytes: Uint8Array;
  /** The last accepted observation per meter, forwarded to the normalizer opaquely. */
  readonly usagePriors?: readonly NormalizedMeasurement[];
}

export type ActivationRunComposition =
  | { readonly ok: true; readonly record: ProviderRunRecord }
  | ProviderRunRefusal;

/**
 * Three vocabularies can answer, and they stay disjoint: the launcher's own
 * refusal on the uncommittable arm, this family's codes from the composition,
 * codec or ledger, and a store code preserved verbatim inside the last of those.
 */
export type ActivationRunCommitResult = ProviderRunCommitResult | ProviderTelemetryRefusal;

type UsageProjection =
  | {
      readonly ok: true;
      readonly usage: readonly NormalizedMeasurement[];
      readonly usageRefusals: readonly ProviderRunUsageRefusal[];
    }
  | ProviderRunRefusal;

/**
 * The runner's normalization, run ONCE and never repeated here. A throw is turned
 * into a stable refusal rather than escaping: a crash is not a refusal, and a
 * handoff this module could not read is a fact a caller must be able to branch on.
 * Only the `usage` result is kept — every other field of the runner's record is a
 * differently-shaped restatement of facts the handoff already carries verbatim.
 */
function normalizedUsage(
  handoff: ClaudeTelemetryHandoff,
  priors: readonly NormalizedMeasurement[],
): ProviderUsageResult | null {
  try {
    return buildProviderRunRecord(handoff, { priors }).usage;
  } catch {
    return null;
  }
}

/**
 * Maps the normalizer's verdict onto the record's two usage fields.
 *
 * A `USAGE_INPUT` refusal is a fact of the RUN — no observed interval, no
 * sequence, no readable receipt — and each of those is already visible in the
 * record's own UNKNOWN fields, so no envelope refusal is invented to restate it.
 * `PROVIDER_USAGE_PRIOR_UNREADABLE` is the exception in that family: it is a fault
 * in CALLER data, invisible in the record, and committing an empty usage for it
 * would report an unmeasured run that was in fact measurable.
 *
 * A `USAGE_AUTHORITY` refusal IS an envelope the scheduler declined, so it is
 * carried with its exact layered issues. `providerSequence` is the envelope's
 * position in the provider's original emission order and is never defaulted: the
 * normalizer checks the sequence before it reaches the authority, so a known
 * sequence is implied here, and the guard refuses rather than substituting a zero
 * if that ever stops holding.
 */
function projectUsage(handoff: ClaudeTelemetryHandoff, usage: ProviderUsageResult): UsageProjection {
  if (usage.ok) return { ok: true, usage: usage.measurements, usageRefusals: [] };
  if (usage.code === "PROVIDER_USAGE_PRIOR_UNREADABLE") {
    return providerRunRefusal("REFUSED", "PROVIDER_RUN_MEASUREMENT_REFUSED", COMPOSITION);
  }
  if (usage.layer !== "USAGE_AUTHORITY") return { ok: true, usage: [], usageRefusals: [] };
  if (!handoff.sequence.known) {
    return providerRunRefusal("REFUSED", "PROVIDER_RUN_USAGE_SEQUENCE_INVALID", COMPOSITION);
  }
  const refused = { issues: [...usage.upstream], providerSequence: handoff.sequence.value };
  return { ok: true, usage: [], usageRefusals: [refused] };
}

/**
 * Projects one handoff onto the durable record contract.
 *
 * NOTHING IS RE-DERIVED. Every field below is either the handoff's own value or
 * the normalizer's, and `recordDigest` is the empty string because this module
 * states no opinion about it: the codec digests the canonical record with that
 * field excluded and then overwrites it, so a value computed here would be a
 * second, drifting opinion about the same bytes.
 *
 * The clock readings are the only CALLER data in the record and they are NOT
 * pre-validated. The codec is the shape authority, and a daemon-side check would
 * be validating one record while the codec digested another.
 */
export function composeProviderRunRecord(
  handoff: ClaudeTelemetryHandoff,
  clock: ActivationRunClockFacts,
  priors: readonly NormalizedMeasurement[] = [],
): ActivationRunComposition {
  const usage = normalizedUsage(handoff, priors);
  if (usage === null) {
    return providerRunRefusal("REFUSED", "PROVIDER_RUN_HANDOFF_MALFORMED", COMPOSITION);
  }
  const projected = projectUsage(handoff, usage);
  if (!projected.ok) return projected;
  return {
    ok: true,
    record: Object.freeze({
      concurrency: handoff.concurrency,
      declared: handoff.declared,
      infrastructure: handoff.infrastructure,
      launch: handoff.launch,
      observedEnd: clock.observedEnd,
      observedModel: handoff.observedModel,
      observedStart: clock.observedStart,
      providerRunRef: handoff.providerRunRef,
      recordDigest: "",
      recordVersion: PROVIDER_RUN_RECORD_VERSION,
      sequence: handoff.sequence,
      stderrReceiptDigest: handoff.stderrReceiptDigest,
      stdoutReceiptDigest: handoff.stdoutReceiptDigest,
      steps: handoff.steps,
      terminal: handoff.terminal,
      tokens: handoff.tokens,
      upstreamRefusal: handoff.telemetryRefusal,
      usage: projected.usage,
      usageRefusals: projected.usageRefusals,
    }),
  };
}

/**
 * Compose and durably commit one activation's provider run, exactly once.
 *
 * The uncommittable arm is returned BY IDENTITY, not re-wrapped: the launcher's
 * code and layer are the answer to "why is there no record", and re-coding them
 * into this family would erase which authority refused.
 */
export function commitActivationProviderRun(
  store: ProviderRunStore,
  input: ActivationRunCommitInput,
): ActivationRunCommitResult {
  if (!input.launch.ok) return input.launch;
  const composed = composeProviderRunRecord(
    input.launch.handoff,
    input.clock,
    input.usagePriors ?? [],
  );
  if (!composed.ok) return composed;
  // `record` is `unknown` on the commit input by design — the codec is the only
  // authority on what is a record — so it travels unvalidated and undigested.
  return commitProviderRunRecord(store, {
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    key: input.key,
    record: composed.record,
    requestBytes: input.requestBytes,
  });
}
