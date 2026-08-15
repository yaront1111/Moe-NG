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
 *                 EFFECTS_COMMITTED, so a replay cannot re-execute anything;
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
import type { CommandDecisionResponse } from "@moe/store";

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
  return Object.freeze({
    aggregateId,
    digest: encoded.digest,
    disposition: response.disposition === "REPLAYED" ? ("REPLAYED" as const) : ("COMMITTED" as const),
    ok: true as const,
    record,
  });
}
