/**
 * The durable commit adapter for one execution activation.
 *
 * ONE call to the store's existing `commitExpectedVersionDecision`, and no
 * SQLite object of this daemon's own. The durable record IS the event payload,
 * so the decision's own `events` array carries the whole activation and there is
 * no side table to keep in step with it.
 *
 * THE THREE UNIQUENESS MECHANISMS ARE ALL BORROWED, none invented here:
 *
 *   replay        the command-decision key — the store returns the ORIGINAL
 *                 decision with a REPLAYED disposition and runs apply only on
 *                 EFFECTS_COMMITTED, so a replay cannot re-execute anything.
 *                 The store's replay identity does NOT cover the events array,
 *                 so a replay is answered by reading the derived aggregate back
 *                 (`answerReplayed`) rather than by echoing the caller's record;
 *                 that read is this module's only other store call;
 *   conflict      the aggregate-head primary key with expectedVersion ALWAYS 0 —
 *                 a distinct command targeting a pair that already activated
 *                 observes version 1 and is rejected;
 *   grant id      `domain_events.event_id` is UNIQUE store-wide, and the event
 *                 id is the grantId COPIED from the grant, never minted here.
 *
 * `commitWithApply` and `commitExpectedVersionDecisionWithApply` are NOT used:
 * `CommitApply` hands the callback a raw `DatabaseSync` and exists for callers
 * that write their own tables inside the transaction, which task rail 1 forbids.
 * The `ActivationLedgerStore` port does not name them, so this module could not
 * reach for one even by accident.
 *
 * THIS MODULE CONSTRUCTS NOTHING. The claim successors and the activation commit
 * arrive as inputs, already produced by authorities that own them, and are
 * persisted exactly as given.
 */

import { DurableStoreError } from "@moe/store";
import type { CommandDecisionResponse, StoredEvent } from "@moe/store";

import { encodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  activationLedgerRefusal,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type {
  ActivationLedgerCommitInput,
  ActivationLedgerCommitResult,
  ActivationLedgerStore,
} from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";

const COMMAND_KIND = "activation.commit";

/** Every activation is the FIRST event on its own derived aggregate. */
const EXPECTED_VERSION = 0;

/**
 * Maps a thrown store error onto this module's vocabulary while preserving the
 * store's own code verbatim in `storeCode`. Flattening them would destroy the
 * distinction DoD 3 requires to be separately assertable: an expected-version
 * conflict and a reused grant id are different facts about what went wrong.
 */
function refuseThrown(error: unknown): ActivationLedgerCommitResult {
  if (!(error instanceof DurableStoreError)) {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_STORE_UNAVAILABLE", null);
  }
  if (error.code === "DURABLE_ID_CONFLICT") {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_GRANT_ID_CONFLICT", error.code);
  }
  if (error.code === "IDEMPOTENCY_CONFLICT") {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_IDEMPOTENCY_CONFLICT", error.code);
  }
  if (error.code === "EXPECTED_VERSION_CONFLICT") {
    return activationLedgerRefusal(
      "REFUSED",
      "ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT",
      error.code,
    );
  }
  // An input fault is OURS, not the store's, and retrying one never succeeds.
  // Folding it into an availability code tells the caller to retry forever, and
  // it is precisely what masked a NUL byte in the derived aggregate id: the
  // store was healthy and rejecting a malformed identifier, while this adapter
  // reported it as unavailable.
  if (error.code === "STORE_INPUT_INVALID" || error.code === "STORE_LIMIT_EXCEEDED") {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_FIELD_INVALID", error.code);
  }
  return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_STORE_UNAVAILABLE", error.code);
}

/**
 * An expected-version conflict is RETURNED, not thrown: the store writes a
 * NO_BUSINESS_EFFECT decision carrying `resultCode: "EXPECTED_VERSION_CONFLICT"`
 * and appends no domain event. Treating a returned decision as success because
 * the call did not throw is exactly how a second activation would be reported as
 * committed while nothing was written.
 */
function refuseDecided(response: CommandDecisionResponse): ActivationLedgerCommitResult | null {
  if (response.decision.effectDisposition === "EFFECTS_COMMITTED") return null;
  return activationLedgerRefusal(
    "REFUSED",
    "ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT",
    response.decision.resultCode,
  );
}

/**
 * Answers a REPLAYED disposition from the DURABLE bytes.
 *
 * The store's replay identity — `identifyExpectedVersionRequest` — hashes only
 * the identity version, projectId, principalId, commandId, commandKind,
 * targetAggregateId, expectedVersion and requestBytes. The `events` array is
 * NOT in it. This adapter pins commandKind and expectedVersion constant and
 * derives targetAggregateId from `effectIntent.{aggregateId,idempotencyKey}`
 * alone, so every other field of the record — lease, slot, reservation, view,
 * attempt, GRANT ID, both predecessor versions, the activation digest — can
 * drift while the store still, correctly, reports a replay.
 *
 * Returning the caller's own record on that path would hand back authority for
 * an activation nobody ever committed. So the durable event is read back and
 * re-verified through the SAME production reader a recovery caller would use,
 * and the answer is the record THOSE bytes carry:
 *
 *   - the reader refuses     -> its UNKNOWN is propagated verbatim; unverifiable
 *                               evidence never becomes an ok result;
 *   - candidate disagrees    -> REPLAY_DIVERGED, this ledger's own refusal, with
 *                               no storeCode because no store call refused;
 *   - they agree             -> ok, carrying the DECODED record, not the input.
 *
 * The comparison is over the canonical digest rather than field by field: the
 * encoding is deterministic, so one digest covers all twelve fields and cannot
 * silently omit the one that drifted.
 */
function answerReplayed(
  store: ActivationLedgerStore,
  aggregateId: string,
  candidateDigest: string,
): ActivationLedgerCommitResult {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch (error) {
    return refuseThrown(error);
  }
  // NARROWED, not relaxed. `readActivationLedgerRecord` refuses more than one
  // event as AMBIGUOUS, and that guard has to keep meaning "exactly one
  // activation record per aggregate". But this aggregate is also where the
  // Foundation launch tail lands, so handing over EVERY event would read an
  // ordinary launched effect as ambiguous and break idempotent re-commit the
  // moment a second event of ANY type exists.
  //
  // The discriminator is the reader's own, applied one step earlier for this
  // caller rather than weakened: zero activation events still refuse ABSENT and
  // two still refuse AMBIGUOUS. The filter is deliberately HERE and not inside
  // the reader, because the reader's contract is "these events are the whole
  // evidence" — a lone wrong-typed event must still refuse EVENT_TYPE_UNEXPECTED
  // for callers that pass a singleton, and filtering inside would silently turn
  // that into ABSENT.
  const activations = events.filter(
    (event) => event.eventType === ACTIVATION_LEDGER_EVENT_TYPE,
  );
  const durable = readActivationLedgerRecord(aggregateId, activations);
  if (!durable.ok) return durable;
  const sealed = encodeActivationLedgerRecord(durable.record);
  if (!sealed.ok) return sealed;
  if (sealed.digest !== candidateDigest) {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_REPLAY_DIVERGED", null);
  }
  return Object.freeze({
    aggregateId,
    digest: sealed.digest,
    disposition: "REPLAYED" as const,
    ok: true as const,
    record: sealed.record,
  });
}

export function commitActivationLedgerRecord(
  store: ActivationLedgerStore,
  input: ActivationLedgerCommitInput,
): ActivationLedgerCommitResult {
  const encoded = encodeActivationLedgerRecord(input.record);
  if (!encoded.ok) return encoded;
  const { record } = encoded;
  const aggregateId = deriveActivationAggregateId(
    record.effectIntent.aggregateId,
    record.effectIntent.idempotencyKey,
  );
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: COMMAND_KIND,
      committedResultBytes: encoded.bytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      events: [
        {
          // COPIED from the grant. Minting one here would forfeit the store-wide
          // uniqueness that makes a reused grant refuse.
          eventId: record.grant.grantId,
          eventType: ACTIVATION_LEDGER_EVENT_TYPE,
          payload: encoded.bytes,
        },
      ],
      expectedVersion: EXPECTED_VERSION,
      key: input.key,
      requestBytes: input.requestBytes,
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return refuseThrown(error);
  }
  const refused = refuseDecided(response);
  if (refused !== null) return refused;
  if (response.disposition === "REPLAYED") {
    return answerReplayed(store, aggregateId, encoded.digest);
  }
  // COMMITTED: the store just wrote `encoded.bytes` verbatim, so the validated
  // record IS the durable record and re-reading it would prove nothing the
  // append did not already prove.
  return Object.freeze({
    aggregateId,
    digest: encoded.digest,
    disposition: "COMMITTED" as const,
    ok: true as const,
    record,
  });
}
