/**
 * The production reader for the durable activation ledger.
 *
 * Split from the codec because the codec crossed the 250-line target; decoding
 * bytes and cross-checking an event against the record those bytes carry are
 * separable responsibilities, and the reader is the one worth reading alone.
 *
 * THE READER NEVER RECONSTRUCTS. Every disagreement returns UNKNOWN with an
 * exact code and this module's layer; there is no path that answers from the
 * fields that happened to parse. That is epic rail 4 applied at the one boundary
 * where a wrong answer becomes durable authority: a caller that receives a
 * record here treats it as proof that an activation was committed.
 */

import type { StoredEvent } from "@moe/store";

import { decodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  activationLedgerUnknown,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerDecodeResult } from "./activation-ledger-contracts.js";

/**
 * Answers with the record only when EVERY one of these agrees:
 *
 * 1. exactly one event exists for the aggregate — zero is ABSENT, more is
 *    AMBIGUOUS, and neither is ever resolved by picking one;
 * 2. its type is exactly the ledger's event type;
 * 3. its payload decodes, digest first;
 * 4. the payload's OWN derived aggregate id equals both the aggregate it was
 *    read from and the aggregate the event claims — a payload that derives
 *    somewhere else is evidence about a different activation;
 * 5. the event id equals the record's grantId, which is the durable uniqueness
 *    the store enforces on this ledger's behalf;
 * 6. both successor versions follow their recorded predecessors by exactly one —
 *    the arithmetic `effect-activation.ts:231,235` itself performs.
 */
export function readActivationLedgerRecord(
  aggregateId: string,
  events: readonly StoredEvent[],
): ActivationLedgerDecodeResult {
  if (events.length === 0) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_ABSENT");
  if (events.length > 1) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS");
  const [event] = events;
  if (event === undefined) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_ABSENT");
  if (event.eventType !== ACTIVATION_LEDGER_EVENT_TYPE) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED");
  }
  const decoded = decodeActivationLedgerRecord(event.payload);
  if (!decoded.ok) return decoded;
  const { record } = decoded;
  const derived = deriveActivationAggregateId(
    record.effectIntent.aggregateId,
    record.effectIntent.idempotencyKey,
  );
  if (derived !== aggregateId || derived !== event.aggregateId) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_AGGREGATE_MISMATCH");
  }
  if (event.eventId !== record.grant.grantId) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_EVENT_ID_MISMATCH");
  }
  if (
    record.effectIntent.version !== record.predecessorIntentVersion + 1 ||
    record.attempt.version !== record.predecessorAttemptVersion + 1
  ) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_VERSION_MISMATCH");
  }
  return decoded;
}
