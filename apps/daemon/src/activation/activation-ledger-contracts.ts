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

import { createHash } from "node:crypto";

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
  CommitExpectedVersionDecisionLegsInput,
  DurableStoreErrorCode,
  ExpectedVersionDecisionLeg,
  StoredEvent,
} from "@moe/store";

export const ACTIVATION_LEDGER_RECORD_VERSION = "moe-activation-ledger/1" as const;

/** The one event type this ledger writes and the only one its reader accepts. */
export const ACTIVATION_LEDGER_EVENT_TYPE = "EffectActivationCommitted" as const;

/**
 * The command kind the writer commits under: this ledger's INTERNAL durable
 * identity, exported so a provenance reader can reject a self-consistent foreign
 * command without copying a literal that would drift. NOT a `RuntimeCommandKind`:
 * those are gated at envelope decode, and this one never crosses that boundary.
 */
export const ACTIVATION_LEDGER_COMMAND_KIND = "activation.commit" as const;

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
 *
 * ACTIVATION_LEDGER_REPLAY_DIVERGED is the commit stage's own cross-check and
 * is deliberately NOT folded into IDEMPOTENCY_CONFLICT. The store's replay
 * identity (`store-digests.ts` `identifyExpectedVersionRequest`) hashes only
 * version, projectId, principalId, commandId, commandKind, targetAggregateId,
 * expectedVersion and requestBytes — the `events` array is outside it. So a
 * second call under the same key with the same request bytes but a DIFFERENT
 * record replays cleanly at the store while describing an activation that was
 * never written. That is this ledger refusing, not the store, and it must be
 * separately assertable from a store-raised conflict.
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
  "ACTIVATION_LEDGER_REPLAY_DIVERGED",
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
  /**
   * `reserveForAdmission`'s own output, snapshotted at commit time: state RESERVED with
   * `attemptRef: null`, and it stays that way. The attempt binding lands AFTER this decision,
   * in the `${commandId}:BUDGET_ACTIVATE` transition (task-03049148), so it moves the durable
   * ledger head to ACTIVATED and never this record. Reading ACTIVATED off here would be
   * reading the wrong surface.
   */
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
  /**
   * The MULTI-LEG seam (task-46987831). One decision, several fenced aggregates, so an
   * activation and the budget hold it authorises cannot survive one without the other.
   * A METHOD, not a free import: `commitExpectedVersionDecisionLegs` is not a named export of
   * `@moe/store` — it rides on `SqliteEventStore`, and naming it here is what lets this port
   * stay the exact surface this ledger uses.
   */
  commitExpectedVersionDecisionLegs(
    input: CommitExpectedVersionDecisionLegsInput,
  ): CommandDecisionResponse;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface ActivationLedgerCommitInput {
  /**
   * The budget hold this activation authorises, CAPTURED from the ledger's own writer and
   * carried here so it rides the SAME decision. Absent means there is no second aggregate to
   * fence — never "commit the activation and settle the money later", which is precisely the
   * pair this row exists to make inseparable.
   */
  readonly budgetLeg?: ExpectedVersionDecisionLeg;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly key: CommandDecisionKey;
  /** Persisted as given. This module constructs no part of it. */
  readonly record: ActivationLedgerRecord;
  readonly requestBytes: Uint8Array;
}

/**
 * On COMMITTED, `record` and `digest` describe the bytes this call just wrote.
 * On REPLAYED they describe the bytes ALREADY IN THE STORE, resolved by reading
 * the derived aggregate back through the production reader — never the caller's
 * input echoed. The caller's own record is only ever a candidate; a replay whose
 * candidate disagrees with the durable bytes refuses REPLAY_DIVERGED instead of
 * handing back authority for an activation nobody committed.
 */
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
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;

/**
 * Derives this ledger's target aggregate id from the effect aggregate and the
 * idempotency key.
 *
 * LEGACY ROWS ARE NEVER REKEYED: code-unit framing remains byte-for-byte when
 * its UTF-8 form fits the store. Only overflow rows use collision-resistant
 * SHA-256 over that complete versioned, length-framed legacy preimage. Framing
 * is injective; hashing is deliberately described only as collision-resistant.
 */
export function deriveActivationAggregateId(aggregateId: string, idempotencyKey: string): string {
  const legacy = `${AGGREGATE_NAMESPACE}${aggregateId.length}:${aggregateId}|${idempotencyKey.length}:${idempotencyKey}`;
  if (Buffer.byteLength(legacy, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return legacy;
  const digest = createHash("sha256").update(legacy, "utf8").digest("hex");
  return `${AGGREGATE_NAMESPACE}sha256:${digest}`;
}
