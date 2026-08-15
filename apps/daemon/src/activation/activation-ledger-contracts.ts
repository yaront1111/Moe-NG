/**
 * Frozen vocabulary for the durable activation ledger.
 *
 * This module declares names, shapes and one pure derivation. It holds no
 * behaviour over a database, computes no activation, and constructs no claim or
 * activation outcome — both halves arrive as inputs produced by authorities that
 * already exist (`@moe/runner` for the activation, `@moe/scheduler` for the
 * claim successors) and are persisted verbatim.
 *
 * EVERY RECORD FIELD IS TYPED FROM ITS PRODUCING PACKAGE'S PUBLIC ROOT. A
 * locally re-declared shape would let a producer change compile cleanly here and
 * diverge silently inside durable bytes, which is the one place divergence
 * cannot be corrected after the fact.
 *
 * THE REFUSAL VOCABULARY IS THIS MODULE'S OWN, with its own layer constant
 * disjoint from the store's `DurableStoreErrorCode` and from the work kernel's
 * `WorkFailure`. An activation refusal must never be mistaken for either; where
 * a store call is what refused, its upstream code is preserved verbatim in
 * `storeCode` rather than flattened into ours.
 */

import { SUPERVISOR_ACTIVATION_VERSION } from "@moe/runner";
import type { ActivationGrant, AttemptSlice, EffectIntent } from "@moe/runner";
import type {
  BudgetAvailableView,
  LeaseRecord,
  ProviderSlotReservation,
  ReservationRecord,
} from "@moe/scheduler";
import type {
  CommandDecisionKey,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  DurableStoreErrorCode,
  StoredEvent,
} from "@moe/store";

export const ACTIVATION_LEDGER_RECORD_VERSION = "moe-activation-ledger/1" as const;

/** The one event type this ledger writes and the only one its reader accepts. */
export const ACTIVATION_LEDGER_EVENT_TYPE = "EffectActivationCommitted" as const;

/**
 * The refusing layer. Disjoint from "STORE" and from the work kernel's
 * authority labels on purpose: a caller that sees this layer knows the
 * activation ledger itself refused, not something underneath it.
 */
export const ACTIVATION_LEDGER_LAYER = "ACTIVATION_LEDGER" as const;

/**
 * Closed refusal vocabulary. Ordered by the stage that raises it: shape, bytes,
 * evidence, cross-check, then commit. Nothing outside this module may add a
 * code, so a refusal cannot be invented at a call site.
 */
export const ACTIVATION_LEDGER_CODES = Object.freeze([
  "ACTIVATION_LEDGER_RECORD_MALFORMED",
  "ACTIVATION_LEDGER_FIELD_INVALID",
  "ACTIVATION_LEDGER_VERSION_UNSUPPORTED",
  "ACTIVATION_LEDGER_BYTES_MALFORMED",
  "ACTIVATION_LEDGER_DIGEST_MISMATCH",
  "ACTIVATION_LEDGER_EVIDENCE_ABSENT",
  "ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS",
  "ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED",
  "ACTIVATION_LEDGER_AGGREGATE_MISMATCH",
  "ACTIVATION_LEDGER_EVENT_ID_MISMATCH",
  "ACTIVATION_LEDGER_VERSION_MISMATCH",
  "ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT",
  "ACTIVATION_LEDGER_GRANT_ID_CONFLICT",
  "ACTIVATION_LEDGER_IDEMPOTENCY_CONFLICT",
  "ACTIVATION_LEDGER_STORE_UNAVAILABLE",
] as const);

export type ActivationLedgerCode = (typeof ACTIVATION_LEDGER_CODES)[number];

/**
 * The durable record: one execution activation, whole.
 *
 * Every fact the activation authority and the claim closure produced together,
 * so that a reader holding these bytes can answer without consulting any other
 * row. The four claim successors plus the budget view come from the granted
 * claim; the attempt, grant and activation digest come from the activation
 * commit; the two predecessor versions are the intent and attempt versions the
 * activation observed BEFORE it bumped them, retained because a successor
 * version alone cannot prove which predecessor it succeeded.
 */
export interface ActivationLedgerRecord {
  readonly recordVersion: typeof ACTIVATION_LEDGER_RECORD_VERSION;
  /** Claim closure, verbatim from `ClaimSuccessors`. */
  readonly lease: LeaseRecord;
  /** Dimension- and attempt-bound, state ACTIVE. */
  readonly providerSlot: ProviderSlotReservation;
  /** State ACTIVATED, attempt-bound; moves no units. */
  readonly budgetReservation: ReservationRecord;
  /** `reserveForAdmission`'s own post-reservation view, never recomputed. */
  readonly budgetView: BudgetAvailableView;
  /** State ACTIVE, version already bumped by the activation. */
  readonly effectIntent: EffectIntent;
  /** Activation half, verbatim from `ActivationCommit`. */
  readonly activationVersion: typeof SUPERVISOR_ACTIVATION_VERSION;
  /** State RUNNING. */
  readonly attempt: AttemptSlice;
  /** State UNUSED; its `grantId` is this record's durable event id. */
  readonly grant: ActivationGrant;
  /** `effectIntent.version` MUST equal this plus one. */
  readonly predecessorIntentVersion: number;
  /** `attempt.version` MUST equal this plus one. */
  readonly predecessorAttemptVersion: number;
  readonly activationDigest: string;
}

/**
 * The record's own key set, exported so a sweep over "every field" is bounded
 * by the record rather than by a hand-written list that a later field could
 * escape.
 */
export const ACTIVATION_LEDGER_RECORD_KEYS = Object.freeze([
  "activationDigest",
  "activationVersion",
  "attempt",
  "budgetReservation",
  "budgetView",
  "effectIntent",
  "grant",
  "lease",
  "predecessorAttemptVersion",
  "predecessorIntentVersion",
  "providerSlot",
  "recordVersion",
] as const);

/**
 * A refusal. `UNKNOWN` is the reader's answer to evidence it cannot verify —
 * epic rail 4's "missing or unverifiable evidence stays UNKNOWN and never gains
 * authority" — while `REFUSED` is a commit that was declined. Both carry an
 * exact code and this module's layer; `storeCode` carries the store's own code
 * verbatim when a store call is what refused, and is null otherwise.
 */
export interface ActivationLedgerRefusal {
  readonly ok: false;
  readonly outcome: "UNKNOWN" | "REFUSED";
  readonly code: ActivationLedgerCode;
  readonly layer: typeof ACTIVATION_LEDGER_LAYER;
  readonly storeCode: DurableStoreErrorCode | null;
}

export type ActivationLedgerEncodeResult =
  | {
      readonly ok: true;
      readonly record: ActivationLedgerRecord;
      readonly bytes: Uint8Array;
      readonly digest: string;
    }
  | ActivationLedgerRefusal;

export type ActivationLedgerDecodeResult =
  | { readonly ok: true; readonly record: ActivationLedgerRecord }
  | ActivationLedgerRefusal;

/**
 * The exact store surface this ledger uses — deliberately two methods, not the
 * whole `SqliteEventStore`. `commitExpectedVersionDecisionWithApply` and
 * `commitWithApply` are absent BY CONSTRUCTION: `CommitApply` hands out a raw
 * `DatabaseSync` for callers who write their own tables, which task rail 1
 * forbids here, and a port that cannot name them cannot reach for them.
 */
export interface ActivationLedgerStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface ActivationLedgerCommitInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly key: CommandDecisionKey;
  /** Persisted as given. This module constructs no part of it. */
  readonly record: ActivationLedgerRecord;
  readonly requestBytes: Uint8Array;
}

export type ActivationLedgerCommitResult =
  | {
      readonly ok: true;
      readonly disposition: "COMMITTED" | "REPLAYED";
      readonly aggregateId: string;
      readonly record: ActivationLedgerRecord;
      readonly digest: string;
    }
  | ActivationLedgerRefusal;

export function activationLedgerRefusal(
  outcome: ActivationLedgerRefusal["outcome"],
  code: ActivationLedgerCode,
  storeCode: DurableStoreErrorCode | null = null,
): ActivationLedgerRefusal {
  return Object.freeze({ code, layer: ACTIVATION_LEDGER_LAYER, ok: false as const, outcome, storeCode });
}

/** Reader refusals are always UNKNOWN: unverifiable evidence confers nothing. */
export function activationLedgerUnknown(code: ActivationLedgerCode): ActivationLedgerRefusal {
  return activationLedgerRefusal("UNKNOWN", code);
}

const AGGREGATE_NAMESPACE = `${ACTIVATION_LEDGER_RECORD_VERSION}|aggregate|`;

/**
 * Derives this ledger's target aggregate id from the effect aggregate and the
 * idempotency key.
 *
 * INJECTIVE BY CONSTRUCTION. Each component is preceded by its own code-unit
 * length, so distinct input pairs cannot produce one string. A bare
 * concatenation would map ('a','bc') and ('ab','c') onto the SAME aggregate,
 * and because every activation commits from expected version 0, that single bug
 * would both accept a second activation that should have conflicted and refuse
 * a first activation that should have been accepted. A separator alone is not
 * enough either: a component containing the separator re-splits.
 *
 * THE SEPARATOR MUST ALSO BE A LEGAL IDENTIFIER CHARACTER. A NUL reads like the
 * obvious delimiter and is what this first shipped with, but the store's
 * `requireIdentifier` rejects any identifier containing one — so every commit
 * refused with STORE_INPUT_INVALID while the length framing, the codec and the
 * injectivity table all stayed green. Only a real store catches it.
 */
export function deriveActivationAggregateId(aggregateId: string, idempotencyKey: string): string {
  return `${AGGREGATE_NAMESPACE}${aggregateId.length}:${aggregateId}|${idempotencyKey.length}:${idempotencyKey}`;
}
